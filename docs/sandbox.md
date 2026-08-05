# Local command sandbox

The sandbox extension replaces Pi's built-in `bash` execution backend and intercepts user `!` commands. It uses `@anthropic-ai/sandbox-runtime` to enforce filesystem and network policy with macOS Seatbelt (`sandbox-exec`) or Linux bubblewrap.

For the architecture and the reasoning behind each behavior, see [`sandbox-design.md`](sandbox-design.md).

## Design goals

The defaults are intended for everyday, iterative coding:

- Project files are readable by default. User data outside the workspace is denied until the user grants a file or directory for the current session.
- Shell startup retains a platform-specific read-only baseline for operating-system libraries, toolchains, device metadata, and temporary files; this baseline is not exposed as general permission for Pi's direct file-reading tools.
- Project files are writable by default. External writes require session approval. Tool caches (npm, pnpm, Yarn, Go, Cargo, and friends) and a private per-process sandbox directory are writable without approval.
- The per-user OS temporary directory (`TMPDIR`/`/var/folders/...` on macOS, `/tmp` on Linux) is readable and writable so compilers, runtimes, and git/xcrun can create transient cache files. The runtime also redirects the child's `TMPDIR` to its own managed scratch path regardless of configuration.
- On macOS the sandbox grants the system trustd service (`enableWeakerNetworkIsolation`) so tools that verify TLS certificates through the system trust store work: newer pip (via `truststore`), Go modules, `gh`, `gcloud`, and similar. Go's module and checksum (`GOMODCACHE`, `GOPATH`/sumdb) caches are redirected into the sandbox cache.
- npm, pnpm, Yarn, Python, Go, Cargo, Gradle, NuGet, and Deno caches are redirected to a process-scoped temporary cache so dependency installation works without granting writes across the home directory.
- Common source hosts and package registries are reachable; other destinations are blocked.
- Local port binding and loopback connections are allowed for test servers and development servers.
- Common API and package tokens are removed from the child environment.
- Foreground builds, tests, and migrations have no implicit timeout. Output streams continuously through Pi's bounded bash output handling, and an explicit `timeout` remains available.
- Cancellation sends `TERM` to the entire command process group and escalates to `KILL`; session shutdown also stops tracked foreground commands before resetting the runtime.

The extension fails closed. If an enabled sandbox cannot initialize, `bash` and `!` are blocked instead of silently running on the host. `--no-sandbox` is the explicit emergency bypass.

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

### Remote git operations run on the host

Remote git operations cannot fully work inside the sandbox: the default `osxkeychain` credential helper cannot reach the user's Keychain (https remotes fail with `could not read Username ... Device not configured`), and direct network is channeled through the sandbox proxy. When a remote git command is detected (`push`, `pull`, `fetch`, `clone`, `ls-remote`), the extension asks for confirmation and runs it **on the host**, where Keychain, git identity, and network are available. Operations therefore keep working and stay approval-gated; declines fail closed.

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

Set `"enabled": false` in a trusted configuration, or start Pi with `--no-sandbox`, to use normal local bash explicitly.

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
