# Sandbox extension design

This document records the architecture and design decisions behind
[`extensions/sandbox`](../extensions/sandbox) (usage walkthrough: `docs/sandbox.md`).
It explains *why* the extension is shaped the way it is, so future changes stay
consistent with the original trade-offs.

## Goal

Local shell commands and Pi's direct file tools get a strong, fail-closed
boundary while remaining suitable for everyday, iterative coding ("vibe
coding") and long-running work:

- The workspace is readable and writable by default; anything outside it needs
  explicit session approval.
- Toolchains still work: system libraries, the OS temporary directory, package
  registries, and local test servers stay available.
- Long foreground commands do not time out by default and can be cancelled as
  one process group.
- If the sandbox cannot initialize, shell execution is blocked rather than
  silently falling back to the host.

## Principles

1. **Fail closed.** An enabled-but-broken sandbox blocks `bash`/`!` instead of
   running on the host. There is no implicit downgrade: `--no-sandbox` is the
   only escape hatch and it is explicit.
2. **Workspace is the trust boundary for user data.** Reads and writes outside
   the workspace require a per-session grant. Machine-owned paths (OS temp,
   Pi's own resources) are exempt because they are not user credentials.
3. **Two enforcement layers, one policy.** The OS child sandbox (Seatbelt /
   bubblewrap via `@anthropic-ai/sandbox-runtime`) enforces filesystem and
   network rules on shell children; the `tool_call` interceptor enforces the
   same workspace policy on Pi's direct `read`/`grep`/`find`/`ls`/`write`/`edit`
   tools, which otherwise run in the Pi process with full permissions.
   The two layers must stay in agreement (see Decisions 1–3).
4. **Hard constraints in interceptors, preferences in skills.** Sandbox rules
   are enforced in code; softer guidance such as "use a Python venv" lives in
   `skills/pi-workflow/SKILL.md` (repository design principle #2).
5. **Credentials stay out of child processes.** Common API/packaging tokens are
   stripped from the environment, home reads are denied, and Keychain-backed
   operations (git push) are promoted to the host under explicit approval
   instead of being made reachable inside the sandbox.

## Architecture

```
                    Pi process (trusted)
┌─────────────────────────────────────────────────────────────┐
│  extensions/sandbox/index.ts                                 │
│    • state machine (starting/sandboxed/bypass/blocked)       │
│    • tool_call gate → SandboxPathAuthorization               │
│    • /sandbox commands, sandbox_authorize_* tools            │
│    • host-side git identity loader                           │
│    • remote-git host-escape guard                            │
└─────────────────────────────────────────────────────────────┘
        │  bash tool / user `!` go through BashOperations
        ▼
┌─────────────────────────────────────────────────────────────┐
│  extensions/sandbox/process.ts                               │
│    createSandboxedBashOperations → SandboxManager            │
│    • wrapWithSandbox (per-exec custom filesystem grants)     │
│    • process-group TERM→KILL, no implicit timeout            │
│    • cache/TMPDIR/env redirection, git identity injection    │
└─────────────────────────────────────────────────────────────┘
        ▼
┌─────────────────────────────────────────────────────────────┐
│  sandbox-runtime (OS level)                                  │
│    macOS: sandbox-exec (Seatbelt) / Linux: bubblewrap        │
│    filesystem allow/deny rules + HTTP/SOCKS proxy network    │
└─────────────────────────────────────────────────────────────┘
```

### Authorization flow (files)

1. Agent (or user `!`) invokes `read`/`write`/… or a shell command with an
   external path.
2. `tool_call` gate resolves the path canonically (`realpath`, with a
   walk-up for not-yet-existing files) and asks `SandboxPathAuthorization`.
3. Allowed if inside: workspace, OS temp (read), Pi managed resources (read),
   or an active session grant. Otherwise the call is blocked with a
   `sandbox_authorize_*` hint.
4. `sandbox_authorize_read|write` inspects up to 8 paths, prompts the user,
   and stores grants in process memory only. Grants are cleared on reload,
   session replacement, and shutdown.

### Graceful shutdown

`session_shutdown` stops tracked children (`TERM`→`KILL` on the process
group), clears grants, resets the runtime, and — only on `quit` — removes the
private temp root. Reload/new/resume keep the temp root because they reuse the
same process.

## Design decisions

### 1. Workspace-only user-data access, machine paths exempt

The sandbox denies reads of the filesystem root with a narrow allowlist
(workspace, system/toolchain paths, OS temp, sandbox root). User data outside
the workspace — including `~` — needs a grant. **Why:** transient toolchain
paths and Pi's own resource directories are not credentials and were the top
source of authorization friction in practice (`/tmp/pr16-wt` review checkouts,
`~/.pi/agent/git/.../skills/SKILL.md`). The tool gate mirrors the OS
allowlist so `read` behaves like `bash cat` (previous mismatch caused
confusing "authorize a temp file" prompts).

### 2. Fail-closed initialization

`session_start` tries to `SandboxManager.initialize`; on failure the state is
`blocked` and both `bash` and `!` refuse to run. **Why:** silently running
unsandboxed turns a security feature into a false sense of safety. The escape
hatch is explicit (`--no-sandbox` or `"enabled": false`).

### 3. Per-exec filesystem grants

Session grants are merged into the `filesystem.allowRead/allowWrite` list at
`wrapWithSandbox` time per command (not just at initialize). **Why:** macOS
Seatbelt profiles are generated per invocation and literal paths beat
high-level directories (`/var` vs `/private/var` etc.); this also keeps the
OS layer in agreement with the tool gate.

### 4. No implicit timeout; process-group cancellation

Unlike the upstream reference example, commands are not killed after a fixed
timeout by default. **Why:** long builds/tests/migrations are the norm in the
target workflow; an explicit `timeout` argument remains available. Cancellation
(targeting `detached: true` + `kill(-pid)`) escalates `TERM`→`KILL` so
descendants die with the shell, not orphan.

### 5. git identity inherited via env injection

Child shells cannot read `~/.gitconfig` (home denied). The extension reads
`user.name`/`user.email` on the host at `session_start` and injects
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` plus `GIT_CONFIG_*` (key numbers continue
from the runtime's existing count so `safe.directory` is preserved).
**Why:** commits through Pi should carry the user's real identity, not git's
username@hostname guess; the rest of `~/.gitconfig` stays isolated.

### 6. Credential-needing commands run on the host after approval

Remote git operations (`push|pull|fetch|clone|ls-remote|submodule update`)
and `gh` subcommands are always detected (any command segment, quote-aware,
incl. `bash -c` wrappers); the configurable `hostExec.commands` list adds
more exact first-command-word matches (default `aws`, `gcloud`, `az`). After
a confirmation dialog the command is executed with host `BashOperations`, and
the command word is remembered for the session so repeated occurrences do not
re-prompt. **Why:** https remotes need Keychain credentials (`osxkeychain`
cannot reach Keychain inside the sandbox), gh needs the host auth token, and
cloud CLIs read `~`-homed credential files; direct network is proxy-confined.
These are exactly the operations where credentials and network must be real —
and where user approval is required anyway. Local git work (`commit`,
`merge`, `status`) stays in the sandbox.

Scope guardrails: `npm`/`pnpm`/`yarn` are not in the default list because they
work sandboxed (cache redirection + `allowedDomains`). `ssh` and `docker`
are high-privilege escapes (arbitrary remote command execution, host mounts)
and are deliberately absent from the defaults; a user must list them
explicitly when they accept running those unsandboxed in a session. Session
memory is per command word and cleared by session end, so approval cannot
leak across sessions or across unrelated commands.

### 7. Behavior preferences live in skills, not interceptors

The Python-venv rule and other "should do" guidance live in
`skills/pi-workflow/SKILL.md`. **Why:** they are preferences with legitimate
exceptions, not security boundaries; hard-coding them as blocks created false
positives (interactive `python3 -c`, venv creation itself).

### 8. Experimental third-party runtime

`@anthropic-ai/sandbox-runtime` is experimental upstream software; the
extension documents its limits (no VM/container isolation, writable project,
trustd grant on macOS) rather than pretending otherwise.

## Status machine

| State | Meaning | bash/`!` behavior | Direct tools |
| --- | --- | --- | --- |
| `starting` | session not initialized yet | blocked | gated (workspace-only) |
| `sandboxed` | runtime initialized | sandboxed | gated (workspace + grants) |
| `bypass` | `--no-sandbox` / `enabled:false` | plain host shell | **not gated** |
| `blocked` | init failed | blocked | gated (workspace-only) |

`/sandbox` shows the current state and the active policy; `/sandbox reload`
re-runs `session_start`.

## Environment injection summary

`codingCacheEnvironment` redirections keep builds hermetic and credentials
out: caches (npm/pnpm/yarn/pip/uv/go/cargo/gradle/nuget/deno) → sandbox root;
`TMPDIR` → runtime-managed scratch; `GIT_CONFIG_GLOBAL`/`npm_config_userconfig`
→ `/dev/null`; sensitive token env vars are unset by the runtime's credentials
section; git identity → injected env (Decision 5).

## Open considerations

- `git submodule update` is treated as remote; `git bundle` and other
  edge transports are not — revisit if they become common.
- The `bash -c` unwrap in `matchHostExecCommand` is intentionally shallow
  (single level) to avoid treating `echo "git push"` as a command.
- Linux filesystem patterns are literal paths (no globs); the allowed-domain
  and deny-write lists must stay portable.
- Keep the tool gate and OS allowlist in agreement when adding paths (see
  Decisions 1 and 3); add a test when changing either.
