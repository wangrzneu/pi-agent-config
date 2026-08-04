# Synced-folder external-memory test plan

Status: proposed

This plan verifies the design in [`external-memory.md`](external-memory.md). It
covers the public module interface, Pi lifecycle integration, filesystem failure
behavior, content minimization, lazy recall, and manual checks against synchronized
folders.

## Quality goals

The implementation is acceptable only if it demonstrates all of the following:

- no write amplification from per-turn snapshots or growing-file rewrites;
- deterministic, incremental, immutable capture;
- fail-open interaction with Pi compaction;
- strict exclusion of reasoning, binary data, and tool-result bodies by default;
- project isolation and filesystem-root confinement;
- bounded, provenance-bearing recall without a persisted search index;
- provider-neutral behavior on ordinary filesystem semantics.

## Test levels

### Module tests

Exercise `ExternalMemory.capture`, `ExternalMemory.recall`, and
`ExternalMemory.status` through the same interface used by the extension. Use a
temporary directory adapter for realistic file behavior and an in-memory or
fault-injecting adapter for deterministic failures.

Avoid tests that reach past the interface merely to assert implementation details.
Pure deterministic policies such as canonical serialization and project-key
normalization may have focused tests because they form internal seams with complex
edge cases.

### Extension integration tests

Use a small fake `ExtensionAPI` harness, following the existing extension tests.
Capture registered handlers and commands, emit lifecycle events, and assert calls
and returned hook results. Do not invoke a real model or cloud provider.

### Filesystem integration tests

Use a fresh temporary directory per test. Exercise actual temporary-file creation,
rename, listing, parsing, hashing, and cleanup. Tests must not use the developer's
real iCloud or Google Drive folders.

### Manual provider checks

Run a short checklist on explicitly created test folders in iCloud Drive and
Google Drive for desktop. These checks validate provider behavior only; they are
not part of `npm test`.

## Fixtures and harnesses

Provide builders for:

- a session header and linear message branch;
- a branch containing user, assistant, thinking, tool call, and tool result data;
- a branch with a previous compaction;
- divergent branches sharing an ancestor;
- oversized messages and binary blocks;
- manual, threshold, and overflow compaction events;
- a deterministic clock and content hash;
- a store adapter that records reads and writes;
- a store adapter that fails selected operations;
- malformed and stale temporary files.

Fixture IDs and timestamps must be stable so filenames and hashes can be asserted
without snapshots that change on every run.

## Configuration and status cases

1. Missing `PI_AGENT_MEMORY_ROOT` leaves memory disabled.
2. A root without project opt-in leaves capture and recall disabled.
3. Explicit project opt-in enables the module and recall tool.
4. Relative roots are rejected.
5. A nonexistent root is reported without creating arbitrary parent directories.
6. A read-only root reports unavailable and does not throw into Pi lifecycle code.
7. Provider hints change display text only.
8. Status distinguishes local writability from unknown cloud-sync state.
9. Configuration values outside supported byte/result limits are rejected or
   clamped according to the documented interface.
10. Secrets in environment variables or remote URLs never appear in status output.

## Project identity and isolation cases

1. Explicit `projectId` wins over Git and working-directory identity.
2. Equivalent HTTPS and SSH Git remotes normalize to the same repository identity.
3. Credentials and tokens in a remote URL are removed before hashing or display.
4. Two unrelated repositories with the same directory basename receive different
   keys.
5. A repository moved to another local path retains identity when its remote is
   unchanged.
6. A project without Git receives a deterministic working-directory key.
7. Recall lists files only below the current project key.
8. Malicious project IDs containing separators, `..`, control characters, or
   Unicode lookalike separators cannot escape the project directory.

## Content-policy cases

1. User text is preserved with entry provenance.
2. Assistant final text is preserved with entry provenance.
3. Thinking/reasoning blocks are absent.
4. System prompts and repeated instructions are absent.
5. Tool-result text, stdout, and stderr are absent by default.
6. Tool name, status, output byte count, and omission flag are retained.
7. Tool arguments containing commands, credentials, or payloads are absent.
8. Images, audio, video, base64, data URLs, and attachment bodies are absent.
9. An oversized message stores a hash, size, bounded excerpts, and
   `contentStored: false`.
10. A normal message stores complete text and `contentStored: true`.
11. Invalid Unicode and control characters serialize deterministically.
12. Filtering the same source twice produces byte-identical canonical records.

Tests should scan completed archive files for sentinel secrets and binary markers,
not merely assert that filtering functions were called.

## Chunking and immutable-write cases

1. A capture below `maxChunkBytes` creates one archive file.
2. A larger capture splits only at entry boundaries.
3. Every chunk has the correct first and last entry IDs.
4. Canonical content produces a deterministic hash and filename.
5. Repeating the same capture creates no additional file.
6. A later capture contains only entries after the previous watermark.
7. An empty incremental range creates no file.
8. A completed archive's bytes, modification time, and hash remain unchanged after
   later captures.
9. A temporary file is created in the destination directory and renamed only after
   a complete write.
10. A write failure leaves no completed filename.
11. A stale temporary file is ignored during watermark discovery.
12. Cleanup removes only recognized stale temporary files below the memory root.
13. An existing identical final file is accepted as success.
14. Conflicting content receives a distinct hash-derived filename and a reported
   conflict.

## Compaction lifecycle cases

### `session_before_compact`

1. Manual compaction captures the unarchived range and returns no compaction
   replacement.
2. Threshold compaction behaves identically apart from recorded reason.
3. Overflow compaction records `willRetry` and remains idempotent when retried.
4. `firstKeptEntryId` is handled without dropping the evidence being summarized.
5. A previous checkpoint does not cause old entries to be copied again.
6. Capture failure returns without cancelling Pi compaction.
7. Warning text is bounded and excludes archive content and sensitive paths.

### `session_compact`

1. A checkpoint is written only after a successful Pi compaction event.
2. The checkpoint references completed archive files and valid source entry IDs.
3. The Pi summary is marked as derived checkpoint content.
4. Duplicate events do not create duplicate checkpoints.
5. Manual, threshold, and overflow metadata are preserved.
6. A checkpoint write failure does not modify completed archive chunks.

### `session_shutdown`

1. Only the unarchived active-branch tail is captured.
2. An empty tail creates no file.
3. Quit, reload, new, resume, and fork reasons do not duplicate prior chunks.
4. Shutdown capture respects its deadline.
5. Timeout or write failure does not hang or reject shutdown indefinitely.

### Explicit capture

1. `/memory capture` uses the same capture path as lifecycle events.
2. Repeated explicit capture is idempotent.
3. Disabled memory explains how to enable it and writes nothing.

## Branch and resume cases

1. Capture follows the active leaf rather than every branch in the session tree.
2. Shared ancestors are not duplicated unnecessarily after a fork.
3. New branch entries are stored under the correct session identity.
4. Resuming a session discovers existing chunks without a mutable local index.
5. A branch containing a prior Pi compaction preserves checkpoint and archive
   provenance without treating the summary as source evidence.
6. Missing source chunks are reported during recall rather than silently replaced
   with the checkpoint summary.

## Recall cases

1. Recall reads checkpoint files before archive files.
2. Only archive files referenced by selected candidates are opened.
3. Query terms match user and assistant text case-insensitively.
4. Code paths, symbols, timestamps, and recent checkpoints influence ranking.
5. Results never cross the current project key.
6. `max_results` is enforced.
7. `max_characters` is enforced after formatting and provenance are included.
8. Every result contains project, session, archive, entry, time, and completeness
   metadata.
9. Checkpoint summaries and source excerpts are labeled distinctly.
10. Excerpted oversized messages are never reported as complete evidence.
11. No-match queries return an empty result rather than unrelated recent memory.
12. Malformed checkpoints and archives are skipped with bounded diagnostics.
13. An unavailable cloud placeholder times out and returns an unavailable result.
14. The in-memory candidate cache is discarded when the extension is reloaded.
15. No SQLite, embedding, full-text index, or cache file is created by recall.

Instrument the store adapter to assert the exact files read. Ranking assertions
should use relative ordering and evidence IDs rather than brittle full rendered
strings.

## Filesystem security cases

1. Archive writes remain below the resolved memory root.
2. Symlinks that resolve outside the root are rejected.
3. Project, session, and entry identifiers cannot introduce path traversal.
4. Existing unrelated files are never overwritten or cleaned.
5. Temporary cleanup cannot follow symlinks.
6. File permissions are no broader than the process default and are documented.
7. Error messages do not include stored conversation content.
8. `/memory off` performs no deletion.
9. No deletion or retention command exists in the first version.

## Write-amplification and resource cases

1. A normal user/assistant turn triggers zero external-memory writes.
2. Tool start/end events trigger zero external-memory writes.
3. One compaction writes only incremental archives plus one checkpoint.
4. A later compaction does not rewrite any prior archive or checkpoint.
5. A session with large tool logs stores only bounded metadata.
6. The number of created files is bounded by incremental chunks and checkpoints,
   not message or tool-call count.
7. Recall creates no persistent index or cache.
8. Capture memory usage is bounded by streaming or chunk-size limits.
9. Directory scans are restricted to the current project/session hierarchy.

Use a generated session with large synthetic tool output to compare source bytes
with archived bytes. The test should assert the configured bounds, not a machine-
specific timing threshold.

## Fault-injection cases

Inject failures for:

- directory listing;
- source parsing;
- temporary-file creation;
- partial write;
- file close;
- rename;
- checkpoint write;
- archive read;
- placeholder hydration timeout;
- process abort during capture.

For every injected failure assert:

- no incomplete file has a final archive/checkpoint name;
- completed immutable files remain unchanged;
- the next capture can retry safely;
- Pi lifecycle hooks fail open;
- diagnostics are bounded and do not leak content.

## Manual provider matrix

Run these checks with disposable test conversations and folders, never sensitive
sessions.

| Scenario | Local folder | iCloud Drive | Google Drive desktop |
| --- | --- | --- | --- |
| Online capture appears locally | required | required | required |
| File appears on a second device/web UI | n/a | required | required |
| Offline capture completes locally | required | required | required |
| Reconnect eventually synchronizes | n/a | required | required |
| Cloud-only file recalls on demand | n/a | required | streamed mode |
| Provider out-of-space is not reported as cloud success | n/a | required | required |
| Simultaneous same-session write preserves immutable files | required | required | required |
| Removing local download does not delete cloud archive | n/a | required | provider-specific |

For iCloud, test both a kept-downloaded folder and an optimized folder. For Google
Drive, test mirrored mode and, when available, streamed mode. The extension must
not infer synchronization completion from successful local writes.

## Documentation checks

Verify that the user documentation states:

- capture is opt-in and provider-neutral;
- the root must be an absolute path;
- local success is not proof of cloud synchronization;
- reasoning, tool output, and binary content are excluded by default;
- external memory is not a complete audit backup;
- iCloud and streamed Drive files may hydrate during recall;
- disabling memory does not delete existing files;
- there is no first-version cloud authentication or persistent index.

## Test command integration

Add the external-memory tests to the existing Node test command in `package.json`,
for example through `extensions/external-memory/*.test.mjs`. Tests must use Node's
built-in test runner and temporary directories, matching the repository's current
test style.

Recommended execution order during implementation:

```text
node --experimental-strip-types --test extensions/external-memory/*.test.mjs
npm test
```

## Exit criteria

Implementation is ready for opt-in use when:

1. All module, lifecycle, security, and resource tests pass.
2. The existing repository test suite remains green.
3. Repeated-capture tests prove byte-for-byte immutability and idempotency.
4. Sentinel scans prove excluded content is absent from completed archives.
5. Recall tests prove lazy reads, project isolation, budgets, and provenance.
6. At least one iCloud Drive and one Google Drive for desktop manual smoke test has
   been recorded, or the untested provider is explicitly documented.
7. A review confirms that no persistent index, per-turn write, growing-file copy,
   or provider credential was introduced.
