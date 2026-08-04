/**
 * Lazy two-stage retrieval primitives.
 *
 * No persisted index: ranking happens in memory over checkpoint metadata, then
 * only referenced archives are hydrated. All functions here are pure and
 * independently testable; the orchestrating recall loop lives in
 * external-memory.ts behind the ExternalMemory interface.
 */

import type {
  ArchiveHeader,
  CanonicalRecord,
  CheckpointDocument,
  MemoryEvidence,
  RecallQuery,
} from "./types.ts";

export const DEFAULT_RECALL_RESULTS = 5;
export const DEFAULT_RECALL_CHARACTERS = 12_000;
export const MAX_CHECKPOINT_CANDIDATES = 8;
export const MAX_ARCHIVES_PER_CANDIDATE = 4;
export const EVIDENCE_EXCERPT_CHARACTERS = 1200;

/** Parse and bound query terms: lowercase-ish symbols, paths, code terms. */
export function queryTerms(query: string): string[] {
  if (!query || typeof query !== "string") return [];
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_./-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 16);
}

/** Rank a checkpoint against query terms, range symbols, timestamps, recency. */
export function scoreCheckpoint(
  checkpoint: CheckpointDocument,
  terms: string[],
  since?: Date,
): number {
  let score = 0;
  const summary = checkpoint.summary.toLowerCase();
  const range = [
    checkpoint.sourceEntryRange.firstEntryId,
    checkpoint.sourceEntryRange.lastEntryId,
    checkpoint.firstKeptEntryId,
  ].join(" ").toLowerCase();
  for (const term of terms) {
    if (summary.includes(term)) score += 4;
    if (range.includes(term)) score += 2;
  }
  if (since) {
    const created = new Date(checkpoint.createdAt).getTime();
    if (created >= since.getTime()) score += 2;
  }
  // Small monotonic recency bump: newer checkpoints score slightly higher,
  // which avoids ties always being won by older content.
  const created = new Date(checkpoint.createdAt).getTime();
  if (Number.isFinite(created)) {
    score += Math.max(0, created / 4e12);
  }
  return score;
}

/** Rank archives candidates: term overlap and recency, with a budget cap. */
export function rankCheckpointCandidates<T extends { checkpoint: CheckpointDocument }>(
  candidates: T[],
  terms: string[],
  since?: Date,
  limit = MAX_CHECKPOINT_CANDIDATES,
): T[] {
  return [...candidates]
    .map((candidate) => ({
      candidate,
      score: scoreCheckpoint(candidate.checkpoint, terms, since),
    }))
    .filter((entry) => entry.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score || timeDesc(candidateTime(b), candidateTime(a)))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

function candidateTime(candidate: { checkpoint: CheckpointDocument }): number {
  return new Date(candidate.checkpoint.createdAt).getTime() || 0;
}

function timeDesc(a: number, b: number): number {
  return b - a;
}

/** Case-insensitive word-ish match against text, ids, and tool names. */
export function recordMatches(record: CanonicalRecord, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [
    record.text ?? "",
    record.entryId,
    record.parentId ?? "",
    record.timestamp,
    record.tool?.toolName ?? "",
    record.model ?? "",
  ].join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Bound recall budgets from a query with documented defaults. */
export function recallBudgets(
  query: RecallQuery,
  fallbackCharacters: number,
): { maxResults: number; maxCharacters: number } {
  const maxResults = query.maxResults === undefined
    ? DEFAULT_RECALL_RESULTS
    : Math.min(50, Math.max(1, Math.round(query.maxResults)));
  const maxCharacters = query.maxCharacters === undefined
    ? fallbackCharacters || DEFAULT_RECALL_CHARACTERS
    : Math.min(100_000, Math.max(512, Math.round(query.maxCharacters)));
  return { maxResults, maxCharacters };
}

/** Build a provenance-bearing evidence excerpt from matching records. */
export function renderEvidence(
  header: ArchiveHeader,
  sessionId: string,
  records: CanonicalRecord[],
  fileName: string,
): MemoryEvidence {
  const text = records.map(renderRecord).join("\n\n");
  const truncated = text.length > EVIDENCE_EXCERPT_CHARACTERS;
  const content = truncated
    ? `${text.slice(0, EVIDENCE_EXCERPT_CHARACTERS)}\n… (excerpted)`
    : text;
  const complete = records.every((record) => record.contentStored) && !truncated;
  return {
    projectKey: header.projectKey,
    sessionId,
    archiveFile: fileName,
    sourceEntryIds: records.map((record) => record.entryId),
    sourceTimestamps: records.map((record) => record.timestamp),
    sourceTime: records[0]?.timestamp,
    content,
    complete,
    kind: "evidence",
  };
}

/** Render one record to plain text for an evidence excerpt. */
export function renderRecord(record: CanonicalRecord): string {
  const label =
    record.type === "assistant"
      ? "assistant"
      : record.type === "user"
        ? "user"
        : record.type;
  const prefix = `[${record.timestamp}] ${label}${record.tool ? ` (${record.tool.toolName})` : ""}`;
  if (record.type === "tool") {
    const tool = record.tool!;
    return `${prefix} status=${tool.status} outputBytes=${tool.outputBytes} outputStored=${tool.outputStored}`;
  }
  if (record.partial) {
    return `${prefix} contentStored=false hash=${record.partial.contentHash} bytes=${record.partial.bytes} excerpt=${record.partial.excerptStart}…`;
  }
  const body = record.contentStored && record.text ? record.text : "(content omitted)";
  return `${prefix}: ${body}`;
}

/** Extract an archive filename's 8-char content hash. */
export function archiveFileHash(fileName: string): string | undefined {
  return fileName.match(/-([a-f0-9]{8})\.jsonl$/)?.[1];
}
