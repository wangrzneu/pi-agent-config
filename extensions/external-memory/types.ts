/**
 * Shared schema types for the synced-folder external-memory extension.
 *
 * The storage format is provider-neutral. Provider hints are display hints only
 * and must not alter persistence semantics.
 */

export interface ExternalMemoryConfig {
  /** Absolute path to the synchronized root directory. */
  root: string;
  /** Optional display hint: icloud | google-drive | filesystem */
  provider?: string;
  /** Project-local opt-in state. */
  project: ProjectMemoryConfig;
}

export interface ProjectMemoryConfig {
  enabled: boolean;
  projectId?: string;
  /** "conversation" is the only policy in the first version. */
  capture: "conversation";
  includeToolResults: boolean;
  maxMessageBytes: number;
  maxChunkBytes: number;
  maxRecallCharacters: number;
}

export const DEFAULT_PROJECT_CONFIG = {
  enabled: true,
  capture: "conversation" as const,
  includeToolResults: false,
  maxMessageBytes: 65_536,
  maxChunkBytes: 262_144,
  maxRecallCharacters: 12_000,
};

/** Component of a Pi session entry that is eligible for capture. */
export interface SourceEntry {
  /** Stable entry ID from the Pi session. */
  id: string;
  /** Parent entry ID, when available. */
  parentId: string | null;
  /** ISO timestamp of the entry. */
  timestamp: string;
  /** Pi session role or entry kind. */
  kind: SessionEntryKind;
  /** User or assistant final text, when present. */
  text?: string;
  /** Model/provider identifiers, when available. */
  model?: string;
  provider?: string;
  /** Tool metadata (bounded). */
  tool?: ToolMetadata;
  /** Set when the message exceeded maxMessageBytes. */
  partial?: PartialContent;
}

export type SessionEntryKind =
  | "user"
  | "assistant"
  | "tool"
  | "compaction"
  | "branch_summary"
  | "custom"
  | "skip";

export interface ToolMetadata {
  toolName: string;
  status: "success" | "error" | "cancelled";
  /** Output byte count (always recorded, even when the body is omitted). */
  outputBytes: number;
  /** Whether the tool-result body was stored (never true in v1). */
  outputStored: boolean;
  startedAt?: string;
}

export interface PartialContent {
  contentHash: string;
  bytes: number;
  excerptStart: string;
  excerptEnd: string;
}

/** Records produced by the content policy, persisted into archive JSONL. */
export interface ArchiveRecord {
  type: "user" | "assistant" | "tool" | "compaction" | "branch_summary" | "custom";
  entryId: string;
  parentId: string | null;
  timestamp: string;
  role?: "user" | "assistant" | "tool" | "compaction" | "branch_summary" | "custom";
  text?: string;
  model?: string;
  provider?: string;
  tool?: ToolMetadata;
  /** True when text is complete; false when excerpted/partial. */
  contentStored: boolean;
  partial?: PartialContent;
}

/** Deterministic canonical form produced by content-policy filtering. */
export interface CanonicalRecord {
  type: ArchiveRecord["type"];
  entryId: string;
  parentId: string | null;
  timestamp: string;
  text?: string;
  model?: string;
  provider?: string;
  tool?: ToolMetadata;
  contentStored: boolean;
  partial?: PartialContent;
}

/** One immutable archive JSONL chunk. */
export interface ArchiveDocument {
  header: ArchiveHeader;
  records: CanonicalRecord[];
}

export interface ArchiveHeader {
  type: "archive";
  schemaVersion: 1;
  projectKey: string;
  sessionId: string;
  firstEntryId: string;
  lastEntryId: string;
  createdAt: string;
}

/** One immutable checkpoint JSON document. */
export interface CheckpointDocument {
  type: "checkpoint";
  schemaVersion: 1;
  checkpointId: string;
  sessionId: string;
  compactionEntryId: string;
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  summary: string;
  sourceEntryRange: {
    firstEntryId: string;
    lastEntryId: string;
  };
  archiveFiles: string[];
  firstKeptEntryId: string;
  createdAt: string;
  /** Stable identifier linking the checkpoint to the capturing module version. */
  source: "pi-agent-config-external-memory";
}

/** Immutable captured content stored under the memory root. */
export type ArchivedFile =
  | { kind: "archive"; header: ArchiveHeader; fileName: string }
  | { kind: "checkpoint"; checkpoint: CheckpointDocument; fileName: string };

/** Result of a capture operation. */
export interface CaptureResult {
  captured: boolean;
  chunksCreated: string[];
  checkpointsCreated: string[];
  /** Range of entry IDs represented by this capture, when incremental data existed. */
  entryRange?: { firstEntryId: string; lastEntryId: string };
  /** Immutable conflicts detected while capturing (same range, different hash). */
  conflicts?: ConflictReport[];
  message?: string;
}

/** A detected conflict between two immutable files covering the same range. */
export interface ConflictReport {
  existingFile: string;
  newFile: string;
  reason: string;
}

/** A bounded recalled excerpt with full provenance. */
export interface MemoryEvidence {
  projectKey: string;
  sessionId: string;
  archiveFile: string;
  sourceEntryIds: string[];
  sourceTimestamps: string[];
  sourceTime?: string;
  content: string;
  complete: boolean;
  kind: "evidence" | "checkpoint";
  relevance?: number;
}

export interface RecallQuery {
  query: string;
  maxResults?: number;
  maxCharacters?: number;
  since?: string;
}

export interface MemoryStatus {
  configured: boolean;
  enabled: boolean;
  root?: string;
  provider?: string;
  localWritable: boolean;
  cloudSynced: "unknown" | "not-syncing";
  libraries: {
    sessionId?: string;
    projectKey?: string;
    archiveFiles: number;
    checkpointFiles: number;
    staleTemporaryFiles: number;
  };
  message?: string;
}

/** Snapshot of the Pi session handed to ExternalMemory.capture. */
export interface SessionSnapshot {
  sessionId: string;
  branchId: string;
  projectKey: string;
  /** Active branch entries, oldest first. */
  entries: SourceEntry[];
  /** Reason for capture, when triggered by a lifecycle event. */
  reason?: "manual" | "threshold" | "overflow" | "shutdown" | "explicit";
  /** Pre-compaction source range (set for session_before_compact). */
  preparation?: {
    firstKeptEntryId?: string;
    messagesToSummarize?: unknown[];
  };
  /** Ancestor session IDs (from /fork or /clone) whose archives may be reused. */
  ancestorSessionIds?: string[];
  timestamp: string;
}

/** Storage adapter seam used by SyncedFolderStore (and by tests). */
export interface MemoryStore {
  /** Absolute path of the synchronized root this store is confined to. */
  readonly root: string;
  /** Write an immutable file destination-atomic: temp write + rename. */
  writeFile(fileName: string, content: string | Uint8Array): Promise<void>;
  /** Read a file as utf8 text. */
  readFile(fileName: string): Promise<string>;
  /** List files directly under the given subdirectory (not recursive). */
  listFiles(dir: string): Promise<string[]>;
  /** List subdirectories directly under the given directory. */
  listDirs(dir: string): Promise<string[]>;
  /** Remove one stale temporary file. Returns false when missing. */
  cleanupTemp(dir: string, fileName: string): Promise<boolean>;
  /** Remove all recognized stale temporary files under a directory. */
  cleanupStaleTemps(dir: string): Promise<number>;
  /** Count recognized stale temporary files under a directory. */
  countStaleTemps(dir: string): Promise<number>;
  /** Discover completed archive chunks (header parsed). */
  discoverArchives(dir: string): Promise<DiscoveredArchive[]>;
  /** Discover checkpoint documents. */
  discoverCheckpoints(dir: string): Promise<DiscoveredCheckpoint[]>;
  /** Resolve a path relative to the store root, rejecting escapes. */
  resolve(relativePath: string): string;
}

export interface DiscoveredArchive {
  fileName: string;
  header: ArchiveHeader;
}

export interface DiscoveredCheckpoint {
  fileName: string;
  checkpoint: CheckpointDocument;
}
