# Synced-folder external memory

Status: proposed

This document defines a lightweight external-memory extension for Pi. The first
implementation stores immutable incremental files in a user-selected directory
that is synchronized by iCloud Drive, Google Drive for desktop, or another
filesystem synchronization provider.

The design deliberately avoids provider-specific cloud APIs, persistent search
indexes, embeddings, and a second continuously rewritten copy of the Pi session.
The accompanying verification strategy is in
[`external-memory-test-plan.md`](external-memory-test-plan.md).

## Goals

- Preserve useful conversation history outside Pi's compacted working context.
- Write only at compaction, explicit capture, and session shutdown boundaries.
- Store immutable incremental chunks instead of rewriting a growing session file.
- Avoid copying large tool output, build logs, reasoning, and binary content.
- Recall relevant evidence lazily without a persistent full-text or vector index.
- Work with iCloud Drive, Google Drive for desktop, and ordinary local folders.
- Keep projects isolated and attach provenance to every recalled result.
- Allow Pi compaction and shutdown to continue when external-memory capture fails.

## Non-goals

- A lossless remote backup of every Pi session field.
- Automatic synchronization status reporting for a cloud provider.
- Cross-device concurrent editing of the same archive file.
- Semantic vector search in the first version.
- Automatic injection of external memory into every model request.
- Provider-specific authentication, OAuth, or cloud APIs.
- Replacing Pi's own append-only session storage.

## Design constraints

Pi already owns the durable local session and compaction process. The extension
must not duplicate the complete session after every turn or interfere with the
summary produced by Pi. A synchronized directory is asynchronous external
storage: a successful local write does not prove that a provider has uploaded the
file.

The package may be installed globally, so capture must be explicitly enabled for
each project. A configured root directory alone must not silently export every
project's conversations.

The storage format is provider-neutral. Provider names are display hints only and
must not alter persistence semantics.

## Terms

- **External memory**: the module that captures, stores, and recalls selected
  conversation evidence.
- **Archive chunk**: an immutable JSONL file containing a bounded, consecutive
  range of selected Pi session entries.
- **Checkpoint**: an immutable JSON file containing a Pi compaction summary and
  provenance linking it to archive chunks and entry IDs.
- **Capture watermark**: the last Pi entry already represented by a completed
  archive chunk for one session branch.
- **Evidence**: a bounded recalled excerpt with project, session, time, and entry
  provenance.
- **Synced folder**: a local filesystem directory whose synchronization is owned
  by iCloud Drive, Google Drive for desktop, or another external process.

## Module and seam

The extension lifecycle is the external seam. Callers and lifecycle tests use one
small interface:

```ts
interface ExternalMemory {
  capture(snapshot: SessionSnapshot): Promise<CaptureResult>;
  recall(query: RecallQuery): Promise<MemoryEvidence[]>;
  status(): Promise<MemoryStatus>;
}
```

This is a deep module. The interface hides entry selection, content policy,
deterministic chunking, hashing, atomic writes, idempotency, lazy candidate
selection, ranking, and result budgets.

`SyncedFolderStore` is an internal adapter at the persistence seam. Tests use an
in-memory or fault-injecting adapter at the same seam. Cloud-provider behavior is
not part of the module interface.

Suggested implementation layout:

```text
extensions/external-memory/
├── index.ts
├── external-memory.ts
├── synced-folder-store.ts
├── session-snapshot.ts
├── content-policy.ts
├── retrieval.ts
├── project-identity.ts
├── config.ts
└── *.test.mjs
```

## Configuration and enablement

The synchronized root is supplied outside the repository:

```text
PI_AGENT_MEMORY_ROOT=/absolute/path/to/PiAgentMemory
```

An optional display hint may be supplied:

```text
PI_AGENT_MEMORY_PROVIDER=icloud|google-drive|filesystem
```

Capture remains disabled until the current project opts in. The implementation
may use a small project file such as `.pi/external-memory.json`:

```json
{
  "enabled": true,
  "projectId": "pi-agent-config",
  "capture": "conversation",
  "includeToolResults": false,
  "maxMessageBytes": 65536,
  "maxChunkBytes": 262144,
  "maxRecallCharacters": 12000
}
```

The configuration contains no credentials. `/memory on` may create or update it
only after user confirmation. `/memory off` stops future capture and recall; it
does not delete existing memory.

At session start the extension resolves and validates the root, verifies project
opt-in, and performs a bounded write probe. It must not claim that a writable
folder is synchronized to the cloud.

## Project identity

Memory must never be searched across projects by default.

The project key is derived in this order:

1. Explicit `projectId` from project configuration.
2. A normalized Git remote identity plus a short hash.
3. A normalized working-directory identity plus a short hash.

The stored key should combine a readable slug with a collision-resistant suffix.
Raw absolute paths and credentials embedded in remotes must not appear in the
folder name or recalled evidence.

## Storage layout

```text
PiAgentMemory/
└── v1/
    └── projects/
        └── <project-key>/
            ├── project.json
            └── sessions/
                └── <session-id>/
                    ├── 20260804T101500-e001-e087-a3f2.jsonl
                    ├── 20260804T143200-e088-e154-b91c.jsonl
                    ├── 20260804T143205-checkpoint-c001.json
                    └── 20260804T190000-e155-e173-6d20.jsonl
```

There is no mutable `latest.json`. The newest checkpoint is discovered by its
timestamp and stable identifier. Completed archive and checkpoint files are never
modified.

The implementation writes a temporary file in the destination directory, closes
it, and renames it to the final name. A stale temporary file is ignored and may be
cleaned during a later status or capture operation.

## Archive format

Archive chunks use versioned JSONL. The first record is a header:

```json
{
  "type": "archive",
  "schemaVersion": 1,
  "projectKey": "pi-agent-config-a1b2c3d4",
  "sessionId": "session-1",
  "firstEntryId": "e001",
  "lastEntryId": "e087",
  "createdAt": "2026-08-04T10:15:00.000Z"
}
```

Following records contain selected conversation evidence. Every record retains
the source entry ID, parent ID where available, timestamp, and role.

The final filename includes a hash of canonical serialized records. Repeating the
same capture therefore produces the same target name and is treated as success
rather than creating a duplicate.

If selected data exceeds `maxChunkBytes`, the module creates multiple immutable
chunks at entry boundaries. A single oversized message is reduced by the content
policy before chunking.

## Content policy

The default `conversation` policy stores:

- user text;
- assistant final text;
- entry IDs, parent IDs, roles, and timestamps;
- model and provider identifiers when available;
- bounded tool metadata: tool name, completion status, output size, and whether
  output was omitted.

It excludes:

- reasoning or thinking blocks;
- system prompts and repeated instructions;
- tool arguments that may contain commands, secrets, or large payloads;
- tool-result stdout and stderr;
- compiler, test, package-manager, and installation logs;
- image, audio, video, base64, data URLs, and other binary content;
- attachment contents;
- embeddings and persistent search indexes.

Example omitted tool result:

```json
{
  "type": "tool",
  "entryId": "e104",
  "timestamp": "2026-08-04T10:20:00.000Z",
  "toolName": "bash",
  "status": "success",
  "outputBytes": 183240,
  "outputStored": false
}
```

Messages larger than `maxMessageBytes` store a byte count, content hash, and
bounded beginning/end excerpts instead of the complete message. The archive must
state that the content is partial; it must never present an excerpt as a complete
source record.

The local Pi session remains the recovery source for excluded data on the device
where it exists. External memory is intentionally a lightweight continuity store,
not a complete audit log.

## Capture lifecycle

### Before compaction

On `session_before_compact`:

1. Read the current `branchEntries` and compaction preparation.
2. Discover completed chunks for this project and session.
3. Determine the unarchived entry range that is about to leave working context.
4. Apply the content policy and deterministic chunking.
5. Atomically create missing archive chunks.
6. Return without replacing or cancelling Pi's compaction.

Capture failures are fail-open. The extension reports a bounded warning and lets
Pi continue because Pi's own session remains intact.

The trigger reason (`manual`, `threshold`, or `overflow`) is recorded. An overflow
retry must not cause duplicate chunks.

### After compaction

On `session_compact`, write an immutable checkpoint containing:

```json
{
  "type": "checkpoint",
  "schemaVersion": 1,
  "checkpointId": "c001",
  "sessionId": "session-1",
  "compactionEntryId": "e088",
  "reason": "threshold",
  "willRetry": false,
  "summary": "...",
  "sourceEntryRange": {
    "firstEntryId": "e001",
    "lastEntryId": "e087"
  },
  "archiveFiles": ["20260804T101500-e001-e087-a3f2.jsonl"],
  "firstKeptEntryId": "e080",
  "createdAt": "2026-08-04T10:15:05.000Z"
}
```

The checkpoint is a derived navigation aid, not a replacement for archive
evidence.

### Session shutdown

On `session_shutdown`, capture only the unarchived tail of the active branch. An
empty tail creates no file. Shutdown capture uses a bounded deadline and must not
hang Pi indefinitely.

### Explicit capture

`/memory capture` performs the same incremental operation. It does not introduce a
separate persistence path.

## Branching and provenance

Capture follows the current session leaf and active branch. A fork may reuse
existing chunks whose entry ranges and hashes match, but new branch entries are
stored under the new session identity.

Every recalled excerpt includes:

- project key;
- session ID;
- archive filename;
- source entry ID or range;
- source timestamp;
- whether source content was complete or excerpted.

The model must be able to distinguish a checkpoint summary from source evidence.

## Recall

The first version performs lazy, two-stage retrieval without persisted indexes:

1. List and read small checkpoint files for the current project.
2. Rank checkpoints in memory using query terms, paths, symbols, timestamps, and
   recency.
3. Read only archive files referenced by the best checkpoint candidates.
4. Rank matching records in memory.
5. Return bounded excerpts with provenance.

An enabled project exposes a single `memory_recall` tool:

```text
memory_recall
  query: string
  max_results?: number
  max_characters?: number
  since?: string
```

The tool is active only when external memory is configured and enabled. It should
be used when the current task depends on decisions or facts from earlier sessions
that are not present in the current context. Recall results are not automatically
inserted into every request.

User commands:

```text
/memory status
/memory search <query>
/memory capture
/memory on
/memory off
```

The in-memory candidate cache is discarded at process exit. No SQLite database,
embedding file, or full-text index is written.

## Failure behavior

- Missing configuration: memory is disabled and no tool is activated.
- Missing or read-only root: notify once per session; Pi continues normally.
- Partial temporary file: ignore it; a later capture may remove it.
- Existing final file with the same hash: treat capture as successful.
- Existing conflicting file: keep both immutable inputs under distinct hashes and
  report the conflict.
- Cloud-only placeholder unavailable offline: recall returns a bounded unavailable
  result instead of blocking indefinitely.
- Provider out of space or sync failure: local capture may succeed; status must not
  claim cloud durability.
- Malformed archive or checkpoint: skip that file, report its path, and continue
  with other candidates.

## Provider notes

### iCloud Drive

Users may mark the memory folder as Keep Downloaded when predictable offline recall
is more important than local space. Otherwise old archives may be evicted and
downloaded on demand. The extension does not attempt to control iCloud hydration or
infer upload completion.

### Google Drive for desktop

Mirrored folders provide predictable local access; streamed folders may hydrate
files on demand. Authentication and synchronization belong to Google Drive for
desktop, not this extension.

### Ordinary filesystem

A local folder is valid for development and testing. It provides persistence but
not external synchronization.

## Security and privacy

- Capture is opt-in per project and disabled by default.
- The synchronized root is never sent to the model.
- Paths are resolved before use; writes must remain below the configured root.
- Symlink traversal outside the root is rejected.
- Provider credentials and tokens are out of scope and must never enter archives.
- Tool output and reasoning remain excluded by default.
- `/memory off` does not delete data.
- Forget or retention operations require a separate design and explicit user
  confirmation.
- Recall never searches another project unless a future explicit cross-project
  mode is designed and authorized.

## Implementation sequence

1. Add schema types, project identity, content policy, deterministic chunking, and
   the synced-folder adapter.
2. Implement the deep `ExternalMemory` module and verify capture through its
   interface.
3. Integrate `session_before_compact`, `session_compact`, and `session_shutdown`.
4. Add lazy checkpoint/archive recall and the bounded `memory_recall` tool.
5. Add `/memory` commands, project opt-in, documentation, and security guidance.
6. Run the automated and manual checks in the test plan before enabling the
   extension by default in any project.

## Acceptance criteria

- Ordinary conversation turns produce no external-memory files.
- Each capture writes only entries not already represented by completed chunks.
- Completed archive and checkpoint files are never modified.
- Repeated events and retries are idempotent.
- Reasoning, binary content, and tool-result bodies are absent by default.
- No persistent embedding or full-text index is created.
- Recall reads checkpoint metadata before hydrating archive candidates.
- Every result includes source provenance and completeness state.
- External-memory failures do not cancel Pi compaction or prevent shutdown.
- Project isolation, root confinement, and content limits are enforced.
