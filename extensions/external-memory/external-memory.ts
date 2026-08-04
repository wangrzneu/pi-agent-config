/**
 * External memory: the deep module behind Pi's synced-folder memory extension.
 *
 * The interface is intentionally small:
 *
 *   capture(snapshot) -> CaptureResult
 *   recall(query)     -> MemoryEvidence[]
 *   status()          -> MemoryStatus
 *
 * Everything else — entry selection, content policy, deterministic chunking,
 * hashing, atomic writes, idempotency, lazy candidate selection, ranking, and
 * result budgets — is hidden behind this interface.
 *
 * Failure behavior is fail-open: capture and lifecycle errors are bounded,
 * never throw into Pi compaction or shutdown.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

import { applyContentPolicy, recordsToArchive } from "./content-policy.ts";
import {
  archiveFileHash,
  DEFAULT_RECALL_CHARACTERS,
  MAX_ARCHIVES_PER_CANDIDATE,
  MAX_CHECKPOINT_CANDIDATES,
  queryTerms,
  rankCheckpointCandidates,
  recallBudgets,
  recordMatches,
  renderEvidence,
} from "./retrieval.ts";
import type { ExternalMemoryConfig, MemoryStore } from "./types.ts";
import type {
  ArchiveHeader,
  CanonicalRecord,
  CaptureResult,
  CheckpointDocument,
  ConflictReport,
  MemoryEvidence,
  MemoryStatus,
  RecallQuery,
  SessionSnapshot,
} from "./types.ts";
import {
  archiveContentHash,
  archiveFileName,
  checkpointFileName,
  parseArchiveDocument,
  serializeArchive,
  serializeCheckpoint,
  SyncedFolderStore,
  type DiscoveredArchive,
  type DiscoveredCheckpoint,
} from "./synced-folder-store.ts";

export interface CaptureContext {
  sessionId: string;
  branchId: string;
  projectKey: string;
  /** Ancestor session IDs (from /fork or /clone) whose archives may be reused. */
  ancestorSessionIds?: string[];
}

export interface CapturedChunkInfo {
  fileName: string;
  firstEntryId: string;
  lastEntryId: string;
  hash: string;
}

export class ExternalMemory {
  readonly #config: ExternalMemoryConfig;
  readonly #store: MemoryStore;
  /** In-memory candidate cache; discarded at process exit. Never persisted. */
  readonly #candidateCache = new Map<string, CheckpointDocument[]>();
  /** Per-session write serialization for overlapping lifecycle events. */
  readonly #sessionLocks = new Map<string, Promise<void>>();
  /** Diagnostic callbacks for bounded warnings. */
  onDiag?: (message: string) => void;

  constructor(config: ExternalMemoryConfig, store: MemoryStore = new SyncedFolderStore(config.root)) {
    this.#config = config;
    this.#store = store;
  }

  get store(): MemoryStore {
    return this.#store;
  }

  get config(): ExternalMemoryConfig {
    return this.#config;
  }

  /** Versioned storage root: v1/<projects>/<key>/sessions/<id>. */
  #sessionDir(sessionId: string): string {
    return join("v1", "projects", this.#config.project.projectId ?? "project", "sessions", sessionId);
  }

  #projectDir(): string {
    return join("v1", "projects", this.#config.project.projectId ?? "project");
  }

  /** Serialize overlapping writes for one session (best-effort mutex). */
  async #withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#sessionLocks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.#sessionLocks.set(sessionId, next as Promise<void>);
    try {
      return await next;
    } finally {
      if (this.#sessionLocks.get(sessionId) === (next as Promise<void>)) {
        this.#sessionLocks.delete(sessionId);
      }
    }
  }

  #diag(message: string): void {
    this.onDiag?.(message);
  }

  /**
   * Capture selected conversation evidence incrementally.
   *
   * - Filters entries through the content policy.
   * - Discovers completed chunks to compute the unarchived range.
   * - Writes only missing chunks, atomically (temp + rename).
   * - Idempotent: repeating the same range produces no duplicate file.
   */
  async capture(snapshot: SessionSnapshot): Promise<CaptureResult> {
    if (!this.#config.project.enabled) {
      return { captured: false, chunksCreated: [], checkpointsCreated: [], message: "disabled" };
    }
    if (!this.#store) {
      return { captured: false, chunksCreated: [], checkpointsCreated: [], message: "no-store" };
    }

    return this.#withSessionLock(snapshot.sessionId, () => this.#captureInner(snapshot));
  }

  async #captureInner(snapshot: SessionSnapshot): Promise<CaptureResult> {
    const sessionIds = [snapshot.sessionId, ...(snapshot.ancestorSessionIds ?? [])].filter(
      (id, index, all) => id && all.indexOf(id) === index,
    );
    const existing = await this.#discoverSessionArchives(snapshot.projectKey, sessionIds);
    const capturedIds = new Set<string>();
    const byId = new Map<string, string>(); // entryId -> fileName
    for (const arch of existing) {
      for (const record of arch.records) {
        capturedIds.add(record.entryId);
        byId.set(record.entryId, arch.fileName);
      }
    }

    await this.#ensureProjectMarker(snapshot);

    // Filter entries through the content policy; keep only persisted kinds.
    const eligible = snapshot.entries
      .filter((entry) => entry.kind !== "skip")
      .map((entry) => applyContentPolicy(entry, this.#config.project.maxMessageBytes))
      .filter((record): record is CanonicalRecord => record !== null);

    // Split into chunks at entry boundaries, bounded by maxChunkBytes.
    const groups = recordsToArchive(eligible, this.#config.project.maxChunkBytes);
    const chunkWritten: string[] = [];
    const conflicts: ConflictReport[] = [];
    const reportedPairs = new Set<string>();
    let firstCreated: string | undefined;
    let lastCreated: string | undefined;

    for (const group of groups) {
      if (group.length === 0) continue;
      const firstEntryId = group[0].entryId;
      const lastEntryId = group[group.length - 1].entryId;

      // Report immutable conflicts: the same entry range already archived
      // under a different content hash. Both files are kept; this is a
      // signal that content diverged outside the normal capture path.
      const sameRange = existing.filter(
        (arch) => arch.header.firstEntryId === firstEntryId && arch.header.lastEntryId === lastEntryId,
      );
      const distinctHashes = new Set(sameRange.map((arch) => archiveFileHash(arch.fileName)));
      if (sameRange.length > 0 && distinctHashes.size > 1) {
        for (const arch of sameRange) {
          const pairKey = [arch.fileName, firstEntryId].sort().join("|");
          if (reportedPairs.has(pairKey)) continue;
          reportedPairs.add(pairKey);
          const hash = archiveContentHash(group);
          const fileName = archiveFileName(snapshot.timestamp, firstEntryId, lastEntryId, hash);
          conflicts.push({
            existingFile: arch.fileName,
            newFile: fileName,
            reason: `Range ${firstEntryId}-${lastEntryId} is archived with different content`,
          });
        }
      }

      // Skip the whole group when every record is already captured.
      if (group.every((record) => capturedIds.has(record.entryId))) {
        continue;
      }
      // Skip records already captured; create a file only for the new ones.
      const missing = group.filter((record) => !capturedIds.has(record.entryId));
      if (missing.length === 0) continue;

      const hash = archiveContentHash(missing);
      const createdAt = snapshot.timestamp;
      const fileName = archiveFileName(createdAt, missing[0].entryId, missing[missing.length - 1].entryId, hash);

      // Deterministic idempotency: same content hash already on disk => success.
      const already = existing.find(
        (arch) => arch.header.projectKey === this.#projectKey(snapshot.projectKey) && arch.fileName === fileName,
      );
      const existingByHash = existing.find(
        (arch) => archiveFileHash(arch.fileName) === hash && arch.header.lastEntryId === lastEntryId,
      );
      if (already || existingByHash) {
        continue;
      }

      const result = await this.#writeArchive(snapshot, missing, fileName);
      if (result) {
        chunkWritten.push(result.fileName);
        if (!firstCreated) firstCreated = result.firstEntryId;
        lastCreated = result.lastEntryId;
        for (const record of missing) capturedIds.add(record.entryId);
        existing.push({
          fileName: result.fileName,
          header: {
            type: "archive",
            schemaVersion: 1,
            projectKey: this.#projectKey(snapshot.projectKey),
            sessionId: snapshot.sessionId,
            firstEntryId: result.firstEntryId,
            lastEntryId: result.lastEntryId,
            createdAt: snapshot.timestamp,
          },
        });
      }
    }
    return {
      captured: chunkWritten.length > 0,
      chunksCreated: chunkWritten,
      checkpointsCreated: [],
      conflicts: conflicts.length > 0 ? conflicts : undefined,
      entryRange: chunkWritten.length > 0
        ? { firstEntryId: firstCreated!, lastEntryId: lastCreated! }
        : undefined,
      message: chunkWritten.length > 0 ? `Captured ${chunkWritten.length} archive chunk(s).` : undefined,
    };
  }

  /** Write the per-project marker file once, atomically, fail-open. */
  async #ensureProjectMarker(snapshot: SessionSnapshot): Promise<void> {
    try {
      const projectDir = this.#projectDir();
      // The directory may not exist yet; writeFile creates parents, so only
      // skip when we can confirm the marker is already present.
      const names = await this.#store.listFiles(projectDir).catch(() => undefined);
      if (names?.includes("project.json")) return;
      const marker = JSON.stringify({
        type: "project",
        schemaVersion: 1,
        projectKey: this.#projectKey(snapshot.projectKey),
        createdAt: snapshot.timestamp,
      }) + "\n";
      await this.#store.writeFile(join(projectDir, "project.json"), marker);
    } catch (error) {
      this.#diag(boundedError("project marker write failed", error));
    }
  }

  async #writeArchive(
    snapshot: SessionSnapshot,
    records: CanonicalRecord[],
    fileName: string,
  ): Promise<CapturedChunkInfo | null> {
    const content = serializeArchive(
      this.#projectKey(snapshot.projectKey),
      snapshot.sessionId,
      {
        firstEntryId: records[0].entryId,
        lastEntryId: records[records.length - 1].entryId,
        createdAt: snapshot.timestamp,
      },
      records,
    );
    try {
      await this.#store.writeFile(join(this.#sessionDir(snapshot.sessionId), fileName), content);
      return {
        fileName,
        firstEntryId: records[0].entryId,
        lastEntryId: records[records.length - 1].entryId,
        hash: archiveContentHash(records),
      };
    } catch (error) {
      this.#diag(boundedError("capture archive write failed", error));
      return null;
    }
  }


  /** Discover archives across the session and ancestor session directories. */
  async #discoverSessionArchives(projectKey: string, sessionIds: string[]): Promise<DiscoverArchiveRecord[]> {
    const all: DiscoverArchiveRecord[] = [];
    for (const sessionId of sessionIds) {
      const dir = this.#sessionDir(sessionId);
      const archives = await this.#store.discoverArchives(dir);
      for (const archive of archives) {
        if (archive.header.projectKey !== this.#projectKey(projectKey)) continue;
        try {
          const body = await this.#store.readFile(join(dir, archive.fileName));
          const parsed = parseArchiveDocument(body);
          if (!parsed) {
            this.#diag(`Malformed archive skipped: ${sessionId}/${archive.fileName}`);
            continue;
          }
          all.push({
            sessionId,
            fileName: archive.fileName,
            header: archive.header,
            records: parsed.records,
          });
        } catch (error) {
          this.#diag(`Archive read failed: ${sessionId}/${archive.fileName}`);
        }
      }
    }
    return all;
  }

  #projectKey(key: string): string {
    return this.#config.project.projectId ?? key;
  }

  /**
   * Write an immutable checkpoint after a successful compaction.
   * Idempotent per compaction entry: duplicates produce no extra file.
   */
  async writeCheckpoint(
    sessionId: string,
    projectKey: string,
    info: {
      compactionEntryId: string;
      reason: "manual" | "threshold" | "overflow";
      willRetry: boolean;
      summary: string;
      sourceRange: { firstEntryId: string; lastEntryId: string };
      archiveFiles: string[];
      firstKeptEntryId: string;
      /** Wall-clock createdAt; deterministically overridable for `since` recall. */
      createdAt?: string;
    },
  ): Promise<CaptureResult> {
    if (!this.#config.project.enabled) {
      return { captured: false, chunksCreated: [], checkpointsCreated: [], message: "disabled" };
    }
    return this.#withSessionLock(sessionId, () => this.#writeCheckpointInner(sessionId, projectKey, info));
  }

  async #writeCheckpointInner(
    sessionId: string,
    projectKey: string,
    info: {
      compactionEntryId: string;
      reason: "manual" | "threshold" | "overflow";
      willRetry: boolean;
      summary: string;
      sourceRange: { firstEntryId: string; lastEntryId: string };
      archiveFiles: string[];
      firstKeptEntryId: string;
      createdAt?: string;
    },
  ): Promise<CaptureResult> {
    const dir = this.#sessionDir(sessionId);
    const existing = await this.#store.discoverCheckpoints(dir);
    const duplicate = existing.find(
      (cp) => cp.checkpoint.compactionEntryId === info.compactionEntryId,
    );
    if (duplicate) {
      return {
        captured: false,
        chunksCreated: [],
        checkpointsCreated: [],
        message: "checkpoint already exists",
      };
    }

    const checkpointId = checkpointHashId(sessionId, info.compactionEntryId);
    const createdAt = info.createdAt ?? new Date().toISOString();
    const document: CheckpointDocument = {
      type: "checkpoint",
      schemaVersion: 1,
      checkpointId,
      sessionId,
      compactionEntryId: info.compactionEntryId,
      reason: info.reason,
      willRetry: info.willRetry,
      summary: info.summary,
      sourceEntryRange: info.sourceRange,
      archiveFiles: info.archiveFiles,
      firstKeptEntryId: info.firstKeptEntryId,
      createdAt,
      source: "pi-agent-config-external-memory",
    };
    const fileName = checkpointFileName(createdAt, checkpointId);
    try {
      await this.#store.writeFile(join(dir, fileName), serializeCheckpoint(document));
    } catch (error) {
      this.#diag(boundedError("checkpoint write failed", error));
      return { captured: false, chunksCreated: [], checkpointsCreated: [], message: "write-failed" };
    }
    return {
      captured: true,
      chunksCreated: [],
      checkpointsCreated: [fileName],
      message: "checkpoint written",
    };
  }

  /**
   * Lazy two-stage recall without a persisted index.
   * 1. List small checkpoint files for the current project.
   * 2. Rank checkpoints by query, paths, symbols, timestamps, recency.
   * 3. Read only archive files referenced by the best candidates.
   * 4. Rank matching records; return bounded excerpts with provenance.
   */
  async recall(query: RecallQuery): Promise<MemoryEvidence[]> {
    if (!this.#config.project.enabled) return [];
    const budgets = recallBudgets(query, this.#config.project.maxRecallCharacters ?? DEFAULT_RECALL_CHARACTERS);
    const maxResults = budgets.maxResults;
    const maxCharacters = budgets.maxCharacters;
    const since = query.since ? new Date(query.since) : undefined;

    const projectDir = this.#projectDir();
    const sessionDirs = await this.#listSessionDirs(projectDir);
    const candidates: { checkpoint: CheckpointDocument; sessionId: string; fileName: string }[] = [];

    for (const sessionId of sessionDirs) {
      const dir = join(projectDir, "sessions", sessionId);
      const cached = this.#candidateCache.get(sessionId);
      const checkpoints = cached ?? (await this.#store.discoverCheckpoints(dir));
      if (!cached) this.#candidateCache.set(sessionId, checkpoints);

      for (const discovered of checkpoints) {
        if (since && new Date(discovered.checkpoint.createdAt) < since) continue;
        candidates.push({ checkpoint: discovered.checkpoint, sessionId, fileName: discovered.fileName });
      }
    }

    if (candidates.length === 0) return [];

    const terms = queryTerms(query.query);
    const rankedCheckpoints = rankCheckpointCandidates(candidates, terms, since, MAX_CHECKPOINT_CANDIDATES);

    const evidence: MemoryEvidence[] = [];
    let budget = maxCharacters;

    for (const candidate of rankedCheckpoints) {
      const sessionDir = join(this.#projectDir(), "sessions", candidate.sessionId);
      const archiveFiles = candidate.checkpoint.archiveFiles.slice(
        0,
        MAX_ARCHIVES_PER_CANDIDATE,
      );
      for (const fileName of archiveFiles) {
        if (evidence.length >= maxResults || budget <= 0) break;
        try {
          const body = await this.#store.readFile(join(sessionDir, fileName));
          const parsed = parseArchiveDocument(body);
          if (!parsed) {
            this.#diag(`Malformed archive skipped during recall: ${candidate.sessionId}/${fileName}`);
            continue;
          }
          const matches = parsed.records.filter((record) => {
            if (since && new Date(record.timestamp).getTime() < since.getTime()) return false;
            return recordMatches(record, terms);
          });
          if (matches.length === 0) continue;
          const excerpt = renderEvidence(parsed.header, candidate.sessionId, matches, fileName);
          const size = Buffer.byteLength(excerpt.content, "utf8");
          if (budget - size < 0 && evidence.length > 0) break;
          budget -= size;
          evidence.push(excerpt);
          if (evidence.length >= maxResults) break;
        } catch (error) {
          this.#diag(`Archive unavailable during recall: ${candidate.sessionId}/${fileName}`);
        }
      }
      if (evidence.length >= maxResults) break;
    }

    return evidence.slice(0, maxResults);
  }

  async #listSessionDirs(projectDir: string): Promise<string[]> {
    try {
      const sessionsRoot = join(projectDir, "sessions");
      return await this.#store.listDirs(sessionsRoot);
    } catch {
      return [];
    }
  }

  /** Invalidating the in-memory candidate cache (used on reload). */
  invalidateCache(): void {
    this.#candidateCache.clear();
  }

  /** Report status: local writability probe + bounded library summary. */
  async status(): Promise<MemoryStatus> {
    const project = this.#config.project;
    let localWritable = false;
    let rootMessage: string | undefined;

    const probeFile = join("v1", "projects", ".probe", "write-probe");
    try {
      await this.#store.writeFile(probeFile, "probe");
      // Cleanup probe only if we created it; never remove unrelated files.
      await this.#store.cleanupTemp(join("v1", "projects", ".probe"), "write-probe");
      localWritable = true;
    } catch {
      localWritable = false;
    }

    const projectDir = this.#projectDir();
    const sessionDirs = await this.#listSessionDirs(projectDir);
    let archiveFiles = 0;
    let checkpointFiles = 0;
    let staleTemporaryFiles = 0;
    for (const sessionId of sessionDirs) {
      const dir = join(projectDir, "sessions", sessionId);
      const archives = await this.#store.discoverArchives(dir);
      const checkpoints = await this.#store.discoverCheckpoints(dir);
      archiveFiles += archives.length;
      checkpointFiles += checkpoints.length;
      staleTemporaryFiles += await this.#store.countStaleTemps(dir);
    }

    return {
      configured: true,
      enabled: project.enabled,
      root: this.#config.root,
      provider: this.#config.provider,
      localWritable,
      cloudSynced: this.#config.provider === "filesystem" ? "not-syncing" : "unknown",
      libraries: {
        archiveFiles,
        checkpointFiles,
        staleTemporaryFiles,
      },
    };
  }

  /** Clean stale temporary files below the project/session hierarchy. */
  async cleanupStaleTemps(): Promise<number> {
    const projectDir = this.#projectDir();
    const sessionDirs = await this.#listSessionDirs(projectDir);
    let removed = 0;
    for (const sessionId of sessionDirs) {
      removed += await this.#store.cleanupStaleTemps(join(projectDir, "sessions", sessionId));
    }
    return removed;
  }
}

interface DiscoverArchiveRecord {
  sessionId: string;
  fileName: string;
  header: ArchiveHeader;
  records: CanonicalRecord[];
}

function checkpointHashId(sessionId: string, compactionEntryId: string): string {
  const hash = createHash("sha256")
    .update(`${sessionId}:${compactionEntryId}`)
    .digest("hex")
    .slice(0, 10);
  return `c${hash}`;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function boundedError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const bounded = message.slice(0, 200);
  return `${prefix}: ${bounded}`;
}
