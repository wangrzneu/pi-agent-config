---
name: pi-workflow
description: Guides concise, evidence-first coding work with focused planning, verification, and safe handling. Use for repository coding tasks.
---

# Pi Workflow

- Inspect before editing.
- State assumptions when requirements are unclear.
- Prefer the smallest coherent change.
- For multi-file or behavior changes, make a short plan first.
- Do not plan single-file mechanical changes unless requested.
- Run focused checks after editing.
- Summarize changed files, checks, and remaining risks.
- Never expose secrets.
- Call out changes to credentials, lock files, or deployment configuration.
- Before every `git push`, obtain the user's explicit authorization for that specific push. Do not treat commit approval, prior push approval, or tool permission as authorization.
- Run Python through the workspace virtual environment: create it once with `python3 -m venv .venv`, then activate it with `source .venv/bin/activate` and use `python`/`pip`. Each bash call is a fresh shell, so combine activation with the work in one command, for example `source .venv/bin/activate && pip install requests` (alternatively call `.venv/bin/python` directly). The sandbox denies home-directory reads, so the host interpreter's `pip` can fail outside a venv (see docs/sandbox.md, "Python environments").
- Keep final responses concise unless detail is requested.

Detailed exploration guidance belongs in task-specific documentation, not the default skill.
