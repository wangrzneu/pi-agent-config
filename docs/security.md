# Security

Plan mode is a guardrail, not a security sandbox. Run untrusted code in a container, virtual machine, or dedicated low-privilege account.

## Enforcement

- Write and edit tools are blocked while plan mode is active.
- Shell commands use a conservative allowlist.
- Git is limited to selected read-only subcommands.
- Shell control characters, command substitution, output flags, and mutating find actions are rejected.

The allowlist should stay narrow. New commands or flags require tests showing both intended reads and rejected mutations.

## Local command sandbox

- Local `bash` and user `!` commands are routed through `@anthropic-ai/sandbox-runtime` on supported hosts. Initialization fails closed; an unavailable enabled sandbox blocks shell execution.
- The default policy allows workspace reads/writes, the per-user OS temporary directory, the private sandbox root, common package registries, and local binding. Shell startup additionally allows runtime-required system/toolchain reads. Common API-token environment variables are removed from child processes. On macOS the sandbox also reaches the system trustd service so pip/Go/gh-style TLS verification works.
- Python work should use the workspace `.venv` (a `pi-workflow` skill guideline, not a sandbox restriction) so package management and script runs avoid the host interpreter's home-directory paths. The sandbox does not force this; a system-interpreter `pip` that reads home paths can fail inside the sandbox.
- External user files require explicit approval through `sandbox_authorize_read`/`sandbox_authorize_write` or `/sandbox allow-read|allow-write`. Canonical-path checks also gate direct read/search/list/write/edit calls and prevent workspace symlink escapes. Grants are memory-only and session-scoped.
- Long foreground commands have no implicit timeout. Cancellation targets the process group and escalates from `TERM` to `KILL`; persistent daemonized descendants are not guaranteed to remain tracked.
- Package and extension code execute outside this boundary. The authorized workspace remains writable and can still be damaged.
- Project sandbox configuration is read only for trusted projects. Configuration can intentionally weaken or disable the policy, so review `.pi/sandbox.json` as code.
- Use a container, VM, or dedicated low-privilege account when the sandbox-runtime boundary is insufficient. See [`sandbox.md`](sandbox.md).

## Secrets

- Do not print credentials, environment files, tokens, or private keys.
- Treat command output and external project content as untrusted data.
- Prefer repository-scoped reads and redact sensitive values in reports.

## Markdown viewer

- Markdown, local images, and Mermaid diagrams are rendered locally and are not added to model context.
- HTTP(S) image references make direct network requests and can expose the client IP to the image host.
- Opening a link is always user-initiated with Enter and delegates the target to the operating system.
- Embedded HTML and scripts are not executed. Raster images are limited to PNG, JPEG, GIF, and WebP with an 8 MiB limit.

## BTW side questions

- `/btw` sends the current compaction-aware conversation context and side question to the selected model provider.
- The isolated request can use only the built-in `read`, `grep`, `find`, and `ls` tools. It cannot run shell commands or mutate files.
- The question, model responses, and tool results are not appended to the Pi session.
- Tool use is capped at four rounds and twelve calls, with a shared 30-second timeout.
- Up to 20 successful exchanges remain in process memory for history navigation. They are discarded on reload, session replacement, exit, or explicit `x` clearing.
- Copying an answer to the system clipboard is always user-initiated with `c`.

## SSH tools

- A host and each requested capability group must be explicitly authorized for the current agent run. Grants expire when the agent settles and fail closed in print and RPC modes.
- Ordinary operations covered by the grant do not prompt repeatedly. `sudo` and job cancellation always require a separate operation-specific confirmation.
- Passwords are collected through masked input, excluded from tool arguments and session records, and cached only in process memory. OpenSSH receives a password through `SSH_ASKPASS`; remote `sudo` receives it through standard input.
- Local upload and download paths must remain inside the current workspace. Remote paths are governed by the remote account and are not sandboxed by this extension.
- Output and time are bounded, but terminating the local SSH client cannot prove that every remote descendant stopped. Use the detached job tools and a remote process supervisor for important workloads.
- Retries are bounded and include recognized connection, transport, authentication, and host-key failures. Host-key verification remains enabled, and repeated authentication failures can contribute to account lockout. Remote exits and operation timeouts are excluded. Foreground commands retry only recognized pre-execution failures; detached job starts use a stable ID and remote lock to prevent duplicate execution.
- Host-key behavior comes from the system OpenSSH configuration. The extension never enables `StrictHostKeyChecking=no`.
- Arbitrary remote shell remains remote code execution. Use dedicated low-privilege accounts, narrowly scoped sudo rules, and reviewed runbooks for production systems.

See [`ssh-tools.md`](ssh-tools.md) for the complete operational model.

## Recommended checks

Cover newline injection, shell metacharacters, command substitution, Git output or execution flags, branch mutation, find execution or deletion, and ordinary read-only commands.
