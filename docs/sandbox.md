# Local command sandbox

The sandbox extension replaces Pi's built-in `bash` execution backend and intercepts user `!` commands. It uses `@anthropic-ai/sandbox-runtime` to enforce filesystem and network policy with macOS Seatbelt (`sandbox-exec`) or Linux bubblewrap.

For the architecture and the reasoning behind each behavior, see [`sandbox-design.md`](sandbox-design.md). For the experimental macOS 26 Apple Container VM layer around the Process sandbox, see [`sandbox-apple-container.md`](sandbox-apple-container.md). The composable Go/Python/Node.js/pnpm/kubectl environments and Kubernetes credential broker are specified in [`sandbox-development-environments.md`](sandbox-development-environments.md). For a feasibility analysis of replacing the OS-denied `~` access with a FUSE interception gate (authorize-then-allow), see [`sandbox-fuse-gate.md`](sandbox-fuse-gate.md).

## Design goals

The defaults are intended for everyday, iterative coding:

- Project files are readable by default. User data outside the workspace is denied until the user grants a file or directory for the current session.
- Shell startup retains a platform-specific read-only baseline for operating-system libraries, toolchains, device metadata, and temporary files; this baseline is not exposed as general permission for Pi's direct file-reading tools.
- Project files are writable by default. External writes require session approval. Tool caches (npm, pnpm, Yarn, Go, Cargo, and friends) and a private per-process sandbox directory are writable without approval.
- The per-user OS temporary directory (`TMPDIR`/`/var/folders/...` on macOS, `/tmp` on Linux) is readable and writable so compilers, runtimes, and git/xcrun can create transient cache files. The runtime also redirects the child's `TMPDIR` to its own managed scratch path regardless of configuration.
- On macOS the sandbox grants the system trustd service (`enableWeakerNetworkIsolation`) so tools that verify TLS certificates through the system trust store work: newer pip (via `truststore`), Go modules, `gh`, `gcloud`, and similar. Go's module and checksum (`GOMODCACHE`, `GOPATH`/sumdb) caches are redirected into the sandbox cache.
- npm, pnpm, Yarn, Python, Go, Cargo, Gradle, NuGet, and Deno caches are redirected to a process-scoped temporary cache so dependency installation works without granting writes across the home directory.
- Common source hosts and package registries are reachable. An unlisted domain pauses the connection and requests session authorization; explicit deny rules remain blocked.
- Local port binding and loopback connections are allowed for test servers and development servers.
- Common API and package tokens are removed from the child environment.
- Foreground builds, tests, and migrations have no implicit timeout. Output streams continuously through Pi's bounded bash output handling, and an explicit `timeout` remains available.
- Cancellation sends `TERM` to the entire command process group and escalates to `KILL`; session shutdown also stops tracked foreground commands before resetting the runtime.

The extension fails closed. If the Process sandbox cannot initialize, `bash` and `!` are blocked instead of silently running on the host. The default backend mode is `auto`: it selects Apple Container only when its startup checks pass, otherwise warns and falls back to the Process sandbox. Forced `apple-container` mode blocks if those checks fail. `--no-sandbox` is the explicit emergency bypass.

Choose a backend for one invocation with `pi --sandbox-mode auto|process|apple-container`. The flag overrides configuration; `/sandbox` shows both the requested and effective backends. See [`sandbox-apple-container.md`](sandbox-apple-container.md) for the check list and persistent configuration.

### Experimental development environment profiles

Interactive TUI startup shows a multi-selector when `developmentEnvironments.promptOnStart` is enabled (the default). A comma-separated CLI selection skips that dialog:

```bash
pi --sandbox-mode process --sandbox-env go,python,node,pnpm,kubectl
pi --sandbox-mode apple-container --sandbox-env go@1.26.6,python@3.13.9,node@26.5.0,pnpm@10.33.0,kubectl@1.29.0
```

Process mode resolves already active/local tools without sourcing a login shell and adds only their canonical runtime roots to shell read access. Apple Container mode resolves exact Linux/arm64 objects already present in Pi's content-addressed environment store and mounts each object read-only. pnpm implicitly selects Node.js. `/sandbox` reports the effective profiles, versions, sources, and platform.

Process mode also supports session-scoped Kubernetes context grants after selecting the kubectl profile:

```text
/sandbox kube select             # pick one local context
/sandbox kube select dev-admin   # select by exact context name
/sandbox kube                    # list active grants
/sandbox kube revoke dev-admin
/sandbox kube revoke-all
/sandbox kube forget             # clear persisted context names (not credentials)
```

The trusted host reads redacted context metadata and runs `kubectl proxy`; the sandbox receives only a TLS capability gateway and sanitized `KUBECONFIG`. Exec credential helpers require a separate confirmation. Access defaults to `observe` and the context's namespace. Real kubeconfig tokens, private keys, and helper output never enter the sandbox. Process uses loopback. Apple Container binds only the private Apple bridge interface, mounts the sanitized config read-only, and never opens a public listener.

With an exact version, Apple Container can install missing Go, Python, Node.js, pnpm, and kubectl Linux/arm64 runtimes from hard-coded trusted catalogs. `install.mode` controls `ask|auto|never`. Downloads require HTTPS, verify official SHA-256 or npm SHA-512 integrity, use bounded traversal-safe extraction in a no-network sandboxed subprocess, and publish immutable content-addressed objects. Session leases protect active objects while configured quota and retention drive automatic LRU pruning. Pinned checksum-verified relocatable Python is supported. Apple projects get a persistent trusted-bootstrap venv and isolated pnpm store; `/sandbox env status|list|prune` manages the shared runtime store. See [`sandbox-development-environments.md`](sandbox-development-environments.md) for the complete target behavior.

## External path authorization

The same workspace boundary applies to sandboxed shell commands and Pi's direct file tools. A canonical-path check prevents a symlink inside the workspace from exposing or modifying an external target.

The model can request up to eight files or directories with:

- `sandbox_authorize_read` before external `bash`, `read`, `grep`, `find`, or `ls` access;
- `sandbox_authorize_write` before external `bash`, `write`, or `edit` access.

Pi shows the canonical paths, operation, and reason before granting access. Users can grant one path directly:

```text
/sandbox allow-read ~/.nvm
/sandbox allow-read "/absolute/path/with spaces"
/sandbox allow-write /absolute/path/to/output.json
```

Run `/sandbox` to list active grants. Use `/sandbox revoke-read` or `/sandbox revoke-write` to clear the corresponding grants. Grants:

- apply to a single canonical file or recursively to an approved existing directory;
- allow an exact not-yet-created file for write authorization;
- affect both shell commands and the corresponding direct Pi tools;
- remain only in process memory;
- are cleared by reload, session replacement, or shutdown;
- fail closed when no interactive approval channel is available.

Files under the OS temporary directory (`/tmp`, `/private/tmp`, the per-user `TMPDIR`) are readable by default, matching the sandbox filesystem allowlist already granted to shell commands. Transient scratch such as a review checkout under `/tmp/...` can be inspected without a grant; only write access and non-temporary home/project paths need approval.

Pi's own managed resources are readable by default: the agent directory's `skills`, `prompts`, `themes`, `extensions`, and installed packages (`git/`, `packages/`). These are runtime guidance and code, not user credentials. The agent-directory root itself (for example `settings.json`) is not in that default set.

## Network authorization

When a sandboxed command connects to a hostname that does not match `network.allowedDomains`, the runtime pauses that connection and asks the user whether to allow the exact hostname. An approval:

- applies to that exact hostname on any port;
- is remembered only for the current session;
- affects later connections from already-running or future sandboxed commands;
- is listed under `Session domain grants` in `/sandbox`;
- can be cleared with `/sandbox revoke-network` (existing open connections are not terminated).

A decline blocks the connection. Without an interactive approval channel, unlisted hosts are denied. Entries in `network.deniedDomains` always take precedence and are never offered for approval. Set `network.strictAllowlist` to `true` to disable prompts and hard-block every unlisted hostname.

The extension does not parse arbitrary shell syntax and prompt retroactively. A shell command that needs an unapproved external path fails with an OS permission error; authorize the path first and then run the command. Configured `denyWrite` patterns still take precedence over a session write grant.

## Configuration

Configuration is merged in this order, with later values taking precedence:

1. Built-in defaults
2. `~/.pi/agent/extensions/sandbox.json`
3. `<project>/.pi/sandbox.json`, only after Pi trusts the project

Objects are merged by section. Arrays replace the earlier array rather than being appended. Run `/sandbox` to inspect the effective policy, or `/sandbox reload` after editing a configuration file.

Example `.pi/sandbox.json`:

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": [
      "github.com",
      "*.github.com",
      "registry.npmjs.org",
      "api.example.test"
    ],
    "deniedDomains": [],
    "strictAllowlist": false,
    "allowLocalBinding": true
  },
  "filesystem": {
    "denyWrite": [".env", "*.pem", "*.key"]
  },
  "credentials": {
    "envVars": [
      { "name": "OPENAI_API_KEY", "mode": "deny" },
      { "name": "ANTHROPIC_API_KEY", "mode": "deny" }
    ]
  },
  "hostExec": {
    "commands": ["aws", "gcloud", "az"]
  }
}
```

The built-in `filesystem.denyRead`/`allowRead` pair establishes the workspace-only read default plus runtime-required system paths, the per-user OS temporary directory, and the private sandbox root. `filesystem.allowWrite` allows `.`, the per-user OS temporary directory, and the private sandbox root. Replacing these arrays is a persistent policy change and can weaken the boundary; prefer session authorization for occasional external access.

The child's `TMPDIR` is managed by the sandbox runtime (`/tmp/claude` by default); tool binaries that honor it write scratch data there automatically. Package-manager caches still point at the private sandbox directory via their own environment variables.

### Git identity and configuration

Sandboxed child shells cannot read `~/.gitconfig` (home reads are denied), so the extension reads the user's `user.name`/`user.email` on the host side at session start and injects them into every sandboxed shell as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`. Git commits made through Pi therefore inherit the identity from `~/.gitconfig` automatically.

The rest of the global configuration (`~/.config/git`, credential helpers, URL rewriting in `~/.gitconfig`) is intentionally isolated and not readable in the sandbox. When a command needs global settings, either configure them in the repository itself (`git config user.name/email`, repository-local excludes) or grant read access for the session:

```bash
/sandbox allow-read ~/.gitconfig
```

Credentials for `git push` remain governed by the `credentials` section.

### Host execution for commands that need real credentials

Some commands cannot work inside the sandbox because their credentials and network live outside it:

- Remote git operations (`push`, `pull`, `fetch`, `clone`, `ls-remote`): the default `osxkeychain` helper cannot reach the user's Keychain (https remotes fail with `could not read Username ... Device not configured`).
- `gh` (GitHub CLI) subcommands: they always talk to api.github.com and need the user's gh auth token.
- Cloud CLIs whose credentials live in `~` files and whose operations are entirely network-bound: `aws`, `gcloud`, `az`.

When such a command is detected, the extension asks for confirmation and runs it **on the host**, where Keychain, git identity, gh auth, and network are available. Commands wrapped by `sudo`, `nohup`, `env KEY=VAL`, `command`, or `exec` are detected too (`sudo gh pr create`, `sudo git push`). Declines fail closed.

The approval is remembered **per command word for the current session**: after approving `aws`, later `aws ...` commands in the same session run on the host without re-prompting (each command word — `git`, `gh`, `aws`, ... — is remembered separately). Non-interactive sessions reject host-execution commands unless the word was already approved.

Configure the extra host-executed command words with `hostExec.commands` (matched on the exact first command word):

```json
{
  "hostExec": { "commands": ["aws", "gcloud", "az"] }
}
```

The default list is `["aws", "gcloud", "az"]` (remote git and `gh` are always detected and need no listing). `npm`/`pnpm`/`yarn` are intentionally absent — they work sandboxed via cache redirection and `allowedDomains`. `ssh` and `docker` are intentionally absent because they are high-privilege escapes (arbitrary remote command execution, host mounts): list them explicitly only when you accept running them unsandboxed in the session.

### Registry and auth configuration

User-level npm and pip configuration files are bypassed (npm emits a loud failure when its userconfig is unreadable). To use a mirror, private registry, or package-token auth inside the sandbox, put the configuration in a project-level file under the workspace — `.npmrc` or a `pip.conf` in the project — which is readable and writable like any workspace file.

### Python environments

Python work should go through the workspace virtual environment, enforced as a working guideline in `skills/pi-workflow/SKILL.md` rather than a sandbox restriction:

```bash
python3 -m venv .venv
source .venv/bin/activate          # then plain `python` / `pip` point at the venv
pip install requests
python train.py
```

The extension runs every bash call in a fresh shell (no persistent shell session), so an activation only survives within one command. Put the activation and the work together, or call the venv binaries directly:

```bash
source .venv/bin/activate && pip install requests
source .venv/bin/activate && python train.py
.venv/bin/python -m pip install requests   # equivalent without activation
```

Why: the sandbox denies reads of the home directory, and distribution-managed interpreters (for example conda/anaconda) inject other project directories and a user site-packages directory into `sys.path`. pip enumerates those directories before any network request to build its user agent, so a non-virtual `python3 -m pip install` fails with `Operation not permitted` even for `--user` or `--target` modes. The venv keeps `sys.path` inside the workspace.

This is a behavior preference, not a hard block: the sandbox itself still isolates the shell, and `python3 -m venv .venv`, interactive `python3 -c`, and `--version` work directly. If a command does not follow the guideline and hits a home-directory permission error, create the venv and retry through it.

`enableWeakerNetworkIsolation` is enabled by default on macOS so system-certificate verification works for pip/Go/gh-style tools. It grants sandboxed processes mach access to the system trustd service; sessions that do not need network TLS verification can set it to `false` in `sandbox.json` to tighten the boundary.

Go 1.23+ prints a single `telemetry upload taken` warning on stderr when the telemetry directory under the home directory is not accessible; this does not affect builds, tests, or module downloads.

Set `credentials.envVars` to `[]` only when a command intentionally needs inherited credentials. Prefer a narrowly allowed domain and the runtime's credential masking/injection configuration over exposing a token generally.

Set top-level `"enabled": false` in a trusted configuration, or start Pi with `--no-sandbox`, to use normal local bash explicitly. To retain sandboxing but skip VM isolation, use `pi --sandbox-mode process`.

## Long-running commands

Keep builds, tests, and other bounded work in the foreground so Pi can stream output and cancel the complete process group. Omit `timeout` when the operation legitimately needs an unknown amount of time; add one when a hang should be bounded.

This extension does not provide a persistent local job supervisor. Manually daemonized children can outlive the shell that started them and are not guaranteed to remain tracked. Use a real process supervisor for persistent development services, and stop those services explicitly.

## Requirements

- Node.js 22.19.0 or later
- macOS: `rg` (ripgrep)
- Linux: `bubblewrap`, `socat`, and `rg`; unprivileged user namespaces must be available

The extension currently supports macOS and Linux. Initialization errors include the missing runtime dependency and leave shell execution blocked.

## Security boundary

This is a strong boundary around child shell processes, but it is not a complete VM or container boundary:

- Pi's built-in `read`, `grep`, `find`, `ls`, `write`, and `edit` tools are canonical-path-gated by the extension but run in the Pi process rather than the OS child sandbox.
- Extensions and Pi packages run with the user's full permissions.
- The project is writable by design, including most repository metadata. Use version-control checkpoints for recovery from unwanted project changes.
- Shells need operating-system libraries and toolchains, so selected system paths and temporary storage remain readable without a prompt. Home-directory tools such as nvm or rustup installations may require a directory grant.
- Local binding is enabled for developer tooling. Disable it when the task does not need local servers.
- macOS grants access to the system trustd service for TLS certificate verification. This is required by pip's `truststore`, Go, `gh`, and `gcloud`; without it those tools fail certificate verification. See `enableWeakerNetworkIsolation` above.
- Linux treats filesystem patterns as literal paths; macOS supports glob patterns. Use explicit sensitive filenames when the policy must be portable.
- The sandbox is experimental third-party software. Use a container, VM, or dedicated low-privilege account for hostile code, production credentials, or high-assurance isolation.
