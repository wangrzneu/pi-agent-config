# Personal Pi Workflow

Use this skill for coding tasks in this repository.

## Default behavior

1. Inspect the repository before editing.
2. State assumptions when requirements are ambiguous.
3. Prefer the smallest coherent change.
4. Run focused tests or checks after editing.
5. Summarize changed files and remaining risks.

## Planning

When the task spans multiple files or changes behavior, first produce a short numbered plan. Do not begin implementation until the user confirms, unless the user explicitly asks for direct execution.

## Safety

Never expose secrets. Do not modify `.env`, credentials, lock files, or deployment configuration without calling it out explicitly.
