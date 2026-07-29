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

## Markdown viewer

- Markdown, local images, and Mermaid diagrams are rendered locally and are not added to model context.
- HTTP(S) image references make direct network requests and can expose the client IP to the image host.
- Opening a link is always user-initiated with Enter and delegates the target to the operating system.
- Embedded HTML and scripts are not executed. Raster images are limited to PNG, JPEG, GIF, and WebP with an 8 MiB limit.

## Recommended checks

Cover newline injection, shell metacharacters, command substitution, Git output or execution flags, branch mutation, find execution or deletion, and ordinary read-only commands.
