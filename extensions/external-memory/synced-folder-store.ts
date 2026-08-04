/**
 * Synced-folder persistence adapter.
 *
 * Persistence seam: write an immutable file via a temporary file in the same
 * directory, close it, then rename to the final name. A stale temporary file is
 * ignored during discovery and may be cleaned during a later capture or status
 * operation.
 *
 * All paths are resolved below the configured root. Symlinks that escape the
 * root are rejected. Completed archive/checkpoint files are never modified.
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
  canonicalBody,
  canonicalRecord,
} from "./content-policy.ts";
import type {
  ArchiveHeader,
  ArchiveDocument,
  CanonicalRecord,
  CheckpointDocument,
  ConflictReport,
  DiscoveredArchive,
  DiscoveredCheckpoint,
  MemoryStore,
} from "./types.ts";

export const TEMP_SUFFIX = ".pi-external-memory-tmp";

export type {
  DiscoveredArchive,
  DiscoveredCheckpoint,
  ConflictReport,
};

/**
 * Filesystem adapter confined to one absolute root. All relative paths are
 * resolved against the root and must remain below it.
 */
export class SyncedFolderStore implements MemoryStore {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) {
      throw new Error(`External memory root must be an absolute path: ${root}`);
    }
    this.root = resolve(root);
  }

  /** Resolve a relative path below the root, rejecting traversal. */
  resolve(relativePath: string): string {
    const target = resolve(this.root, relativePath);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error("Path escapes external memory root.");
    }
    return target;
  }

  async assertConfined(filePath: string): Promise<string> {
    // Dereference to reject symlinks that point outside the root.
    const real = await realpath(resolve(dirname(filePath)));
    const rootReal = await realpath(this.root);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) {
      throw new Error("Symlink escapes external memory root.");
    }
    return filePath;
  }

  async writeFile(fileName: string, content: string | Uint8Array): Promise<void> {
    const finalPath = this.resolve(fileName);
    // Create the parent first so realpath checks can run.
    await mkdir(dirname(finalPath), { recursive: true });
    // Guard against writes that would escape via symlinked parent dirs.
    const parentReal = await realpath(dirname(finalPath));
    const rootReal = await realpath(this.root);
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
      throw new Error("Symlink traversal outside memory root is rejected.");
    }

    const temporary = `${finalPath}${TEMP_SUFFIX}`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, finalPath);
  }

  async readFile(fileName: string): Promise<string> {
    const target = this.resolve(fileName);
    await this.assertConfined(target);
    // Reject symlinked files that resolve outside the root, not just
    // symlinked parents.
    const fileReal = await realpath(target);
    const rootReal = await realpath(this.root);
    if (fileReal !== rootReal && !fileReal.startsWith(rootReal + sep)) {
      throw new Error("Symlink escapes external memory root.");
    }
    return readFile(target, "utf8");
  }

  async listFiles(dir: string): Promise<string[]> {
    const target = this.resolve(dir);
    const entries = await readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  }

  async listDirs(dir: string): Promise<string[]> {
    const target = this.resolve(dir);
    const entries = await readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  async cleanupTemp(dir: string, fileName: string): Promise<boolean> {
    const target = this.resolve(join(dir, fileName));
    await this.assertConfined(target);
    await rm(target, { force: true });
    return true;
  }

  /** Remove only recognized stale temporary files. Never follows symlinks. */
  async cleanupStaleTemps(dir: string): Promise<number> {
    const target = this.resolve(dir);
    let entries: { name: string; isFile: boolean }[];
    try {
      const dirents = await readdir(target, { withFileTypes: true });
      entries = dirents.map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith(TEMP_SUFFIX)) continue;
      try {
        const full = this.resolve(join(dir, entry.name));
        const real = await realpath(dirname(full));
        const rootReal = await realpath(this.root);
        if (real !== rootReal && !real.startsWith(rootReal + sep)) continue;
        await rm(full, { force: true });
        removed++;
      } catch {
        // Leave unknown stale files alone.
      }
    }
    return removed;
  }

  /** Discover completed archive chunks under a project/session directory. */
  async discoverArchives(dir: string): Promise<DiscoveredArchive[]> {
    const target = this.resolve(dir);
    let names: string[];
    try {
      names = await this.listFiles(dir);
    } catch {
      return [];
    }
    const archives: DiscoveredArchive[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        const body = await this.readFile(join(dir, name));
        const header = parseArchiveHeader(body);
        if (header) archives.push({ fileName: name, header });
      } catch {
        // Malformed archive: skip; the caller reports bounded diagnostics.
      }
    }
    return archives;
  }

  /** Discover checkpoint JSON files under a project/session directory. */
  async discoverCheckpoints(dir: string): Promise<DiscoveredCheckpoint[]> {
    const target = this.resolve(dir);
    let names: string[];
    try {
      names = await this.listFiles(dir);
    } catch {
      return [];
    }
    const checkpoints: DiscoveredCheckpoint[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(TEMP_SUFFIX)) continue;
      try {
        const body = await this.readFile(join(dir, name));
        const checkpoint = parseCheckpoint(body);
        if (checkpoint) checkpoints.push({ fileName: name, checkpoint });
      } catch {
        // Malformed checkpoint: skip.
      }
    }
    return checkpoints;
  }

  /** Count stale temporary files for status reporting. */
  async countStaleTemps(dir: string): Promise<number> {
    try {
      const names = await this.listFiles(dir);
      return names.filter((name) => name.endsWith(TEMP_SUFFIX)).length;
    } catch {
      return 0;
    }
  }

}

export function parseArchiveHeader(body: string): ArchiveHeader | null {
  const firstLine = body.split("\n", 1)[0];
  if (!firstLine) return null;
  try {
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    if (
      parsed.type !== "archive" ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.projectKey !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.firstEntryId !== "string" ||
      typeof parsed.lastEntryId !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return {
      type: "archive",
      schemaVersion: 1,
      projectKey: parsed.projectKey,
      sessionId: parsed.sessionId,
      firstEntryId: parsed.firstEntryId,
      lastEntryId: parsed.lastEntryId,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export function parseCheckpoint(body: string): CheckpointDocument | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (
      parsed.type !== "checkpoint" ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.checkpointId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.compactionEntryId !== "string" ||
      typeof parsed.summary !== "string" ||
      typeof parsed.firstKeptEntryId !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    const sourceEntryRange = parsed.sourceEntryRange as Record<string, unknown> | undefined;
    if (
      !sourceEntryRange ||
      typeof sourceEntryRange.firstEntryId !== "string" ||
      typeof sourceEntryRange.lastEntryId !== "string"
    ) {
      return null;
    }
    return {
      type: "checkpoint",
      schemaVersion: 1,
      checkpointId: String(parsed.checkpointId),
      sessionId: String(parsed.sessionId),
      compactionEntryId: String(parsed.compactionEntryId),
      reason: (parsed.reason === "manual" || parsed.reason === "threshold" || parsed.reason === "overflow")
        ? parsed.reason
        : "threshold",
      willRetry: parsed.willRetry === true,
      summary: String(parsed.summary),
      sourceEntryRange: {
        firstEntryId: String(sourceEntryRange.firstEntryId),
        lastEntryId: String(sourceEntryRange.lastEntryId),
      },
      archiveFiles: Array.isArray(parsed.archiveFiles)
        ? parsed.archiveFiles.map(String)
        : [],
      firstKeptEntryId: String(parsed.firstKeptEntryId),
      createdAt: String(parsed.createdAt),
      source: "pi-agent-config-external-memory",
    };
  } catch {
    return null;
  }
}

/** Deterministic hash over canonical serialized records for the archive filename. */
export function archiveContentHash(records: CanonicalRecord[]): string {
  const body = canonicalBody(records);
  return createHash("sha256").update(body).digest("hex").slice(0, 8);
}

/** Build the final archive file name: <timestamp>-<first>-<last>-<hash>.jsonl */
export function archiveFileName(
  createdAt: string,
  firstEntryId: string,
  lastEntryId: string,
  hash: string,
): string {
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace(/Z$/, "");
  return `${stamp}-${firstEntryId}-${lastEntryId}-${hash}.jsonl`;
}

/** Build the checkpoint file name: <timestamp>-checkpoint-<id>.json */
export function checkpointFileName(createdAt: string, checkpointId: string): string {
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace(/Z$/, "");
  return `${stamp}-checkpoint-${checkpointId}.json`;
}

/** Serialize an archive document: header record + canonical records + newline. */
export function serializeArchive(
  projectKey: string,
  sessionId: string,
  headers: { firstEntryId: string; lastEntryId: string; createdAt: string },
  records: CanonicalRecord[],
): string {
  const header: ArchiveHeader = {
    type: "archive",
    schemaVersion: 1,
    projectKey,
    sessionId,
    firstEntryId: headers.firstEntryId,
    lastEntryId: headers.lastEntryId,
    createdAt: headers.createdAt,
  };
  const lines = [JSON.stringify(header), ...records.map((record) => canonicalRecord(record))];
  return lines.join("\n") + "\n";
}

export function serializeCheckpoint(checkpoint: CheckpointDocument): string {
  return JSON.stringify(checkpoint, null, 2) + "\n";
}

/** Read an archive document body, returning header + records (or null). */
export function parseArchiveDocument(body: string): ArchiveDocument | null {
  const lines = body.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return null;
  const header = parseArchiveHeader(lines[0]);
  if (!header) return null;
  const records: CanonicalRecord[] = [];
  for (const line of lines.slice(1)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const record: CanonicalRecord = {
        type: parsed.type as CanonicalRecord["type"],
        entryId: String(parsed.entryId),
        parentId: parsed.parentId === null ? null : String(parsed.parentId ?? ""),
        timestamp: String(parsed.timestamp),
        contentStored: parsed.contentStored !== false,
      };
      if (typeof parsed.text === "string") record.text = parsed.text;
      if (typeof parsed.model === "string") record.model = parsed.model;
      if (typeof parsed.provider === "string") record.provider = parsed.provider;
      if (parsed.tool && typeof parsed.tool === "object") {
        const tool = parsed.tool as Record<string, unknown>;
        record.tool = {
          toolName: String(tool.toolName ?? "tool"),
          status: tool.status === "error" ? "error" : tool.status === "cancelled" ? "cancelled" : "success",
          outputBytes: Number(tool.outputBytes ?? 0),
          outputStored: tool.outputStored === true,
        };
      }
      records.push(record);
    } catch {
      return null;
    }
  }
  return { header, records };
}

