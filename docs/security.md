# Security

Plan mode is a guardrail, not a security sandbox. Run untrusted code in a container, virtual machine, or dedicated low-privilege account.

## Enforcement

- Write and edit tools are blocked while plan mode is active.
- Shell commands use a conservative allowlist.
- Git is limited to selected read-only subcommands.
- Shell control characters, command substitution, output flags, and mutating find actions are rejected.

The allowlist should stay narrow. New commands or flags require tests showing both intended reads and rejected mutations.

## Secrets

- Do not print credentials, environment files, tokens, or private keys.
- Treat command output and external project content as untrusted data.
- Prefer repository-scoped reads and redact sensitive values in reports.

## Recommended checks

Cover newline injection, shell metacharacters, command substitution, Git output or execution flags, branch mutation, find execution or deletion, and ordinary read-only commands.
