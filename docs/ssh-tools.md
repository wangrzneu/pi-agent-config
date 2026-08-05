# SSH tools

The SSH extension provides bounded remote execution without replacing Pi's local file or shell tools. It uses the system `ssh` and `scp` clients so existing SSH config, host-key verification, keys, agents, and `ProxyJump` settings continue to apply.

## Requirements

- `ssh` and `scp` must be available on the local `PATH`.
- The remote host needs a POSIX shell, `base64`, `nohup`, `head`, `tail`, and ordinary process utilities.
- `setsid` is optional. When present, job cancellation targets the complete remote process group; otherwise it targets the direct child process.
- Configure and verify host keys before unattended use. The extension does not disable host-key checking.

## Dynamic tool discovery

Only `ssh_enable` is visible initially. The model calls it with an SSH host and one or more capability groups:

| Capability | Tools exposed for the current agent run |
| --- | --- |
| `exec` | `ssh_exec` |
| `files` | `ssh_upload`, `ssh_download` |
| `jobs` | `ssh_job_start` |

After a job starts, `ssh_job_status` and `ssh_job_cancel` remain visible while needed. Execution, file, and job-start tools are withdrawn when the agent settles. Capability grants expire at the same boundary, so a later agent run must authorize its required host/capability pairs again. Tool activation always starts from `pi.getActiveTools()` and changes only the SSH tool names, so unrelated user tool settings are preserved.

No keyword matcher or extra classifier request is used. The active model selects the capability enum from the `ssh_enable` schema.

## Usage

Ask Pi for the remote task normally, for example:

```text
On staging, show the kernel version and free disk space.
Upload dist/app.tar.gz to deploy:/tmp/app.tar.gz.
Start the integration test on build-host as a long job and monitor it.
```

`ssh_enable` displays one interactive authorization containing the host, newly requested capability groups, connection timeout, and retry count. The grant covers ordinary operations in those groups for the current agent run, avoiding a confirmation for every command or transfer. Adding another capability or starting a later agent run requires another grant. `sudo` execution and job cancellation always retain their own operation-specific confirmation. Remote actions are unavailable in print/RPC mode because those modes cannot provide interactive approval.

Detached jobs additionally ask once per host per agent run whether the job may start a login shell that reads the remote user's profile files (`~/.profile`, `~/.bash_profile`, `~/.zprofile`, ...) to inherit the login environment. Declining still starts the job, but in a plain shell that does not read the profile, so job output carries no profile side effects or warnings.

Use `/ssh-tools` to inspect authorized hosts and tracked jobs:

```text
/ssh-tools
/ssh-tools off
/ssh-tools on
/ssh-tools reset
```

`off` hides all SSH tools and clears current grants and cached passwords. `reset` additionally clears remembered hosts and connection policies. Neither command stops an already detached remote job.

## Execution and output

- `ssh_exec` defaults to a 60-second timeout and 32 KiB each of captured stdout and stderr. Both limits can be adjusted within bounded schema limits.
- A local SSH timeout or cancellation cannot guarantee that an independently detached remote child has stopped. Use `ssh_job_start` for long work.
- Job output is fetched incrementally with separate stdout and stderr byte offsets. Each status call returns the next offsets.
- Remote job metadata and logs are stored under `${PI_SSH_JOB_DIR}` when set, otherwise `${XDG_STATE_HOME:-$HOME/.local/state}/pi-agent/jobs`.
- Job IDs are tracked only in the current Pi process. Exiting Pi does not stop a remote job, but the current version cannot rediscover it after restart.

## Connection retry

`ssh_enable` configures the connection policy for its host:

- `connect_timeout_seconds`: 10 seconds by default, range 1–60;
- `connection_retries`: 2 retries by default, range 0–3;
- `retry_delay_ms`: 500 ms by default, range 100–5000, with exponential backoff capped at 10 seconds.

Retries are limited to recognizable OpenSSH connection, transport, authentication, and host-key failures. Host-key retries never disable or bypass OpenSSH verification; they only allow a later attempt to succeed after the trusted host-key state has been corrected externally. Authentication retries apply separately to the initial key/agent attempt and, when requested, the password attempt. Use a low retry count where repeated failures could trigger account lockout. Remote command exit codes and operation timeouts are never retried automatically. Foreground commands retry only failures known to occur before command execution; upload, download, status, and cancellation are safe to retry as transport operations. Job start uses the same generated job ID and a remote start lock, so a repeated request returns the existing process instead of starting a duplicate.

The operation timeout bounds each process attempt but is not itself retryable. Total elapsed time can therefore include preceding connection attempts and backoff delays plus the final operation timeout.

## File transfer

Upload and download use `scp`, so file contents remain binary-safe. Local source and destination paths are restricted to the current workspace. Downloads first use a temporary file in the destination directory and are renamed into place only after `scp` succeeds.

Remote paths are not confined by the extension. Restrict them with a dedicated remote account, filesystem permissions, container, or forced command where appropriate.

## Password and sudo handling

Key or SSH-agent authentication is attempted first with batch mode. If the server requires a password, the TUI requests it through a masked input. `sudo -n` is also attempted first; a masked sudo password is requested only when necessary.

Passwords:

- are never tool parameters and are not sent to the model;
- are not written to the Pi session, job files, command arguments, or repository;
- remain only in extension process memory for the current session;
- are passed to OpenSSH through a temporary askpass environment and to remote `sudo` through standard input.

Environment variables of a running local process may still be inspectable by the same operating-system account. Prefer keys, SSH certificates, hardware-backed agents, and narrowly scoped `sudoers` rules over reusable passwords.

## Security boundaries

The extension provides approvals, host authorization, bounded output, workspace-confined local transfers, strict host argument validation, and ordinary OpenSSH host-key checks. It is not a remote sandbox and does not attempt to determine whether an arbitrary shell command is safe.

For production systems, use a dedicated low-privilege account and expose reviewed runbooks through Ansible Runner, Rundeck, or a similar job control plane instead of granting general shell access.
