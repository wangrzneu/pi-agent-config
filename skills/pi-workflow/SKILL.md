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

## Single-repository code exploration

Use an evidence-first retrieval loop before changing code. Keep the search local and prefer open-source tools that can run without uploading repository contents.

1. Map the repository with `rg --files`, then inspect the relevant manifests, entry points, tests, and local instructions. Exclude generated, vendored, build, and dependency directories when they are not relevant.
2. Start with `rg` for cheap lexical recall. Search for the user-visible behavior, symbol names, error messages, configuration keys, and test names. Include line numbers and narrow by path or file type where possible.
3. Use the language server as the default semantic tool: go to definition, find references, find implementations, inspect types, and read diagnostics. Prefer the repository's configured open-source server, such as `gopls`, `rust-analyzer`, `clangd`, or `pyright`. Treat text matches as candidates until the language server or source confirms them.
4. Use `ast-grep` for syntax-shaped searches and safe repetitive edits. Match the code structure rather than formatting or whitespace; preview matches before rewriting. Use Tree-sitter only when custom parsing, AST-based chunking, or a syntax index is actually needed; it complements LSP rather than replacing it.
5. Read complete relevant functions and their callers/callees, not only matching lines. Trace configuration, data flow, error handling, and tests before deciding where to edit.

### LSP server setup

Prefer a language server already provided by the editor, repository, or system. If the required server is missing:

1. Identify the server and explain the installation command, network requirement, and any files it may change.
2. Ask for confirmation before downloading or installing it; do not install silently.
3. Prefer the repository's existing package manager and configuration.
4. Do not modify dependency manifests or lock files solely to enable LSP unless the user explicitly requests it.
5. After installation, verify that the server starts and use its diagnostics or symbol results as evidence.

### Retrieval tool selection

- `rg`: search text, regular expressions, filenames, and initial candidates.
- LSP: resolve definitions, references, implementations, types, and diagnostics.
- `ast-grep`: search and rewrite code by syntax structure.
- Tree-sitter: optionally parse source code for custom tooling, syntax-aware chunking, or indexing.

### Compact command patterns

```sh
rg --files -g '!vendor' -g '!dist' -g '!build'
rg -n -S 'symbol|error message|config.key' src test
ast-grep -p 'old_api($$$ARGS)' -l <language> .
```

If a preferred tool is unavailable, fall back from LSP to direct source inspection and from `ast-grep` to `rg`. Never silently claim semantic certainty from a lexical match.

## Change verification

After editing, re-run the narrowest relevant search to confirm all intended call sites were handled, inspect the diff, and run the repository's focused formatter, type checker, linter, and tests. Expand validation only when the change crosses module boundaries or the focused checks do not cover the affected behavior.

## Safety

Never expose secrets. Do not modify `.env`, credentials, lock files, or deployment configuration without calling it out explicitly.
