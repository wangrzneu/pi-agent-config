# Code Exploration

Use this guide when a task needs deeper repository investigation. It is reference material and should not be loaded for routine edits.

## Workflow

1. Map files and read repository instructions, manifests, entry points, and focused tests.
2. Search for user-visible behavior, symbols, errors, configuration keys, and test names.
3. Use the language server to confirm definitions, references, implementations, types, and diagnostics.
4. Use syntax-aware search for repetitive structural matches or edits.
5. Read complete relevant functions and their callers before deciding where to change code.
6. Trace configuration, data flow, error handling, and verification paths.

## Tool selection

- Use rg for filenames, text, regular expressions, and initial candidates.
- Use the language server for semantic relationships and types.
- Use ast-grep for syntax-shaped search and safe repetitive rewrites.
- Use Tree-sitter only for custom parsing, syntax indexes, or chunking.

Treat lexical matches as candidates until source or semantic tooling confirms them. If a required language server is missing, explain the install and network impact before installing it.

## Verification

After editing, inspect the diff, repeat the narrow search, and run the smallest relevant formatter, type check, linter, and tests. Expand verification only when the change crosses boundaries.
