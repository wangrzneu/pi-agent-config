/**
 * Content policy for external memory.
 *
 * Default `conversation` policy stores:
 *   - user text
 *   - assistant final text
 *   - entry IDs, parent IDs, roles, timestamps
 *   - model and provider identifiers when available
 *   - bounded tool metadata: name, completion status, output size, omission flag
 *
 * It excludes:
 *   - reasoning/thinking blocks
 *   - system prompts and repeated instructions
 *   - tool arguments and tool-result stdout/stderr
 *   - compiler/test/package-manager/install logs
 *   - image/audio/video/base64/data URLs and other binary content
 *   - attachment contents
 *   - embeddings/persistent indexes
 *
 * Oversized messages are stored as a byte count, content hash, and bounded
 * beginning/end excerpts with `contentStored: false`. The archive always states
 * the content is partial and never presents an excerpt as a complete source.
 */

import {
  createHash,
  type BinaryLike,
} from "node:crypto";
import type {
  CanonicalRecord,
  PartialContent,
  SourceEntry,
  ToolMetadata,
} from "./types.ts";

const EXCERPT_CHARACTERS = 300;
/** Binary/control markers plus embedded data-URL schemes. Base64 runs are
 *  detected separately (hasBase64Run) so long alphanumeric text is not
 *  misclassified as a binary payload. */
const BINARY_MARKERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u0080-\u009f\u{fffd}]|(?:data:image|data:audio|data:video)/u;

const BASE64_RUN = /[A-Za-z0-9+/]{400,}(?:={0,2})/;

/** True when a text run looks like an embedded base64 payload: long, and
 *  mixing letters with digits or +/. A run of a single repeated character
 *  (emphatic text, test data) is not treated as binary. */
function hasBase64Run(text: string): boolean {
  const match = BASE64_RUN.exec(text);
  if (!match) return false;
  const blob = match[0].replace(/=+$/, "");
  const mixedChars = new Set(blob).size >= 2;
  const hasLetters = /[A-Za-z]/.test(blob);
  const hasDigitsOrSymbol = /[0-9+/]/.test(blob);
  return mixedChars && hasLetters && hasDigitsOrSymbol;
}

const TOOL_LOG_PATTERN =
  /(?:^|\s)(?:npm|yarn|pnpm|gradle|maven|make|cargo|go\s+build|pip|pip3|node\s+(?:--test|test)|jest|vitest|pytest|tsc|eslint|prettier|docker|kubectl|terraform|ansible|gcc|clang|rustc)(?:\s|$)/i;

/** Deterministic content hash used for partial-message provenance. */
export function contentHash(value: string): string {
  return createHash("sha256").update(value.normalize("NFKC")).digest("hex");
}

function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
  }
  return texts;
}

function containsBinary(content: unknown): boolean {
  if (typeof content === "string" && (BINARY_MARKERS.test(content) || hasBase64Run(content))) return true;
  if (Array.isArray(content)) {
    return content.some((block) => {
      if (!block || typeof block !== "object") return false;
      const b = block as Record<string, unknown>;
      if (b.type === "image" || b.type === "audio" || b.type === "video") return true;
      if (b.type === "text" && typeof b.text === "string" && (BINARY_MARKERS.test(b.text) || hasBase64Run(b.text))) {
        return true;
      }
      return false;
    });
  }
  return false;
}

function isToolLog(text: string): boolean {
  return TOOL_LOG_PATTERN.test(text.slice(0, 400));
}

function excerpt(text: string, limit = EXCERPT_CHARACTERS): { excerptStart: string; excerptEnd: string } {
  if (text.length <= limit) return { excerptStart: text, excerptEnd: "" };
  const half = Math.floor(limit / 2);
  const start = text.slice(0, half);
  const end = text.slice(-half);
  return { excerptStart: start, excerptEnd: end };
}

/**
 * Apply the `conversation` content policy to a raw source entry.
 * Returns the canonical record to persist, or `null` when the entry is excluded.
 */
export function applyContentPolicy(
  source: SourceEntry,
  maxMessageBytes: number,
): CanonicalRecord | null {
  const kind = source.kind;
  if (kind === "skip") return null;

  const base = {
    type: kind === "compaction" ? "compaction" : kind === "branch_summary" ? "branch_summary" : kind,
    entryId: source.id,
    parentId: source.parentId,
    timestamp: source.timestamp,
  };

  switch (kind) {
    case "user":
    case "assistant": {
      const text = source.text ?? "";
      if (containsBinary(text)) return null;
      if (isToolLog(text)) return null;
      if (text.length === 0) return null;

      if (Buffer.byteLength(text, "utf8") > maxMessageBytes) {
        const { excerptStart, excerptEnd } = excerpt(text);
        return {
          ...base,
          text: `${excerptStart}${excerptEnd ? "\n… (content truncated)" : ""}`,
          model: source.model,
          provider: source.provider,
          contentStored: false,
          partial: {
            contentHash: contentHash(text),
            bytes: Buffer.byteLength(text, "utf8"),
            excerptStart,
            excerptEnd,
          },
        } satisfies CanonicalRecord;
      }

      return {
        ...base,
        text,
        model: source.model,
        provider: source.provider,
        contentStored: true,
      } satisfies CanonicalRecord;
    }
    case "tool": {
      if (!source.tool) return null;
      // Bounded metadata only; tool-result bodies are never stored in v1.
      return {
        ...base,
        type: "tool",
        tool: metadataOnly(source.tool),
        contentStored: false,
      } satisfies CanonicalRecord;
    }
    default:
      return null;
  }
}

/** Bounded tool metadata: name, status, byte count, omission flag; never args/bodies. */
function metadataOnly(tool: ToolMetadata): ToolMetadata {
  return {
    toolName: tool.toolName.slice(0, 120),
    status: tool.status,
    outputBytes: Number.isSafeInteger(tool.outputBytes) ? tool.outputBytes : 0,
    outputStored: false,
    startedAt: tool.startedAt,
  };
}

/** Canonical serialization of one record: stable key order, no trailing whitespace. */
export function canonicalRecord(record: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    // Preserve explicit null (e.g. parentId: null); drop undefined/empty.
    if (value === undefined || value === "") continue;
    out[key] = value;
  }
  return JSON.stringify(out);
}

/** Deterministic byte-identical canonical form for a whole archive body. */
export function canonicalBody(records: CanonicalRecord[]): string {
  return records.map((record) => canonicalRecord(record)).join("\n") + "\n";
}

/** Build the record list from filtered canonical records, applying the chunk limit. */
export function recordsToArchive(records: CanonicalRecord[], maxChunkBytes: number): CanonicalRecord[][] {
  const chunks: CanonicalRecord[][] = [];
  let current: CanonicalRecord[] = [];
  let size = 0;
  for (const record of records) {
    const recordSize = Buffer.byteLength(canonicalRecord(record), "utf8");
    if (current.length > 0 && size + recordSize > maxChunkBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(record);
    size += recordSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Convert a raw Pi session-like entry into a SourceEntry for capture. */
export function sessionEntryToSource(entry: unknown): SourceEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;

  const id = typeof e.id === "string" ? e.id : "";
  const parentId = typeof e.parentId === "string" ? e.parentId : null;
  const timestamp = typeof e.timestamp === "string" ? e.timestamp : "";

  const message = e.message as Record<string, unknown> | undefined;
  const role = message?.role;

  if (typeof role === "string" && (role === "user" || role === "assistant")) {
    const content = message.content;
    if (containsBinary(content)) return null;
    const text = extractTextBlocks(content).join("\n").trim();
    if (!text) return null;
    return {
      id,
      parentId,
      timestamp,
      kind: role,
      text,
      model: typeof message.model === "string" ? message.model : undefined,
      provider: typeof message.provider === "string" ? message.provider : undefined,
    };
  }

  if (role === "toolResult" || e.role === "toolResult") {
    const toolName = typeof message?.toolName === "string" ? message.toolName : "tool";
    const status = message?.isError === true ? "error" : "success";
    const outputBytes = estimateOutputBytes(message?.content);
    return {
      id,
      parentId,
      timestamp,
      kind: "tool",
      tool: {
        toolName,
        status,
        outputBytes,
        outputStored: false,
      },
    };
  }

  if (e.type === "compaction") {
    return {
      id,
      parentId,
      timestamp,
      kind: "compaction",
      text: typeof e.summary === "string" ? e.summary : undefined,
    };
  }

  if (e.type === "branch_summary") {
    return {
      id,
      parentId,
      timestamp,
      kind: "branch_summary",
      text: typeof e.summary === "string" ? e.summary : undefined,
    };
  }

  if (e.type === "custom" && typeof e.customType === "string") {
    // Extension state entries are not conversation evidence; skip by default.
    return null;
  }

  // model_change, thinking_level_change, label, session_info, session header, etc.
  return null;
}

function estimateOutputBytes(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  if (Array.isArray(content)) {
    let bytes = 0;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") bytes += Buffer.byteLength(b.text, "utf8");
      if (b.type === "image" && typeof b.data === "string") bytes += b.data.length;
    }
    return bytes;
  }
  return 0;
}

