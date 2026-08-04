/**
 * Session snapshot adapter: converts Pi session data into the ExternalMemory
 * `SessionSnapshot` input format.
 *
 * This is the Pi-specific integration seam. It understands `SessionEntry`,
 * `SessionManager`, and compaction `CompactionPreparation` shapes so the deep
 * `ExternalMemory` module stays generic.
 */

import { sessionEntryToSource } from "./content-policy.ts";
import type { SessionSnapshot, SourceEntry } from "./types.ts";

export interface SessionAdapter {
  sessionId(): string | undefined;
  branchId(): string | undefined;
  /** Active branch entries, oldest first. */
  branchEntries(): unknown[];
  ancestorSessionIds?(): string[];
  timestamp(): string;
}

/**
 * Build a SessionSnapshot from a Pi bootstrap function.
 * Never throws: entries that fail to convert are skipped.
 */
export function buildSnapshot(
  adapter: SessionAdapter,
  options: {
    reason?: SessionSnapshot["reason"];
    projectKey: string;
    preparation?: SessionSnapshot["preparation"];
  },
): SessionSnapshot {
  const entries: SourceEntry[] = [];
  for (const raw of adapter.branchEntries()) {
    const source = sessionEntryToSource(raw);
    if (source) entries.push(source);
  }
  return {
    sessionId: adapter.sessionId() ?? "ephemeral",
    branchId: adapter.branchId() ?? "branch",
    projectKey: options.projectKey,
    entries,
    reason: options.reason,
    preparation: options.preparation,
    timestamp: adapter.timestamp(),
  };
}

/** Capture-time timestamp: entry ISO when available, else current time. */
export function latestEntryTimestamp(entries: SourceEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const timestamp = entries[index].timestamp;
    if (timestamp) return timestamp;
  }
  return new Date().toISOString();
}
