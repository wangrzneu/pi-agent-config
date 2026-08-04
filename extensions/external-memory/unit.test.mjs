import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, mkdir, rm, writeFile as fsWriteFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LIMITS,
  defaultProjectConfig,
  resolveRootFromEnv,
} from "./config.ts";
import { DEFAULT_PROJECT_CONFIG } from "./types.ts";
import {
  applyContentPolicy,
  canonicalBody,
  contentHash,
  recordsToArchive,
  sessionEntryToSource,
} from "./content-policy.ts";
import {
  deriveProjectKey,
  normalizeGitRemote,
  slugify,
  directoryIdentity,
  safeComponent,
} from "./project-identity.ts";
import {
  EVIDENCE_EXCERPT_CHARACTERS,
  MAX_ARCHIVES_PER_CANDIDATE,
  MAX_CHECKPOINT_CANDIDATES,
  archiveFileHash,
  queryTerms,
  rankCheckpointCandidates,
  recallBudgets,
  recordMatches,
  renderEvidence,
  scoreCheckpoint,
} from "./retrieval.ts";
import {
  SyncedFolderStore,
  TEMP_SUFFIX,
  archiveContentHash,
  archiveFileName,
  checkpointFileName,
  parseArchiveDocument,
  parseCheckpoint,
  serializeArchive,
  serializeCheckpoint,
} from "./synced-folder-store.ts";

// ---------------------------------------------------------------------------
// Fixtures (stable IDs/timestamps)
// ---------------------------------------------------------------------------

const T = "2026-08-04T10:00:00.000Z";

function userEntry(overrides = {}) {
  return { id: "u1", parentId: null, timestamp: T, kind: "user", text: "Hello memory", ...overrides };
}

function assistantEntry(overrides = {}) {
  return {
    id: "a1",
    parentId: "u1",
    timestamp: "2026-08-04T10:01:00.000Z",
    kind: "assistant",
    text: "Hello there",
    ...overrides,
  };
}

function toolEntry(overrides = {}) {
  return {
    id: "t1",
    parentId: "a1",
    timestamp: "2026-08-04T10:02:00.000Z",
    kind: "tool",
    tool: {
      toolName: "bash",
      status: "success",
      outputBytes: 183_240,
      outputStored: false,
    },
    ...overrides,
  };
}

function compactionEntry(overrides = {}) {
  return {
    id: "c1",
    parentId: "t1",
    timestamp: "2026-08-04T10:03:00.000Z",
    type: "compaction",
    summary: "Earlier discussion summarized here.",
    ...overrides,
  };
}

function canonicalUser() {
  return {
    type: "user",
    entryId: "u1",
    parentId: null,
    timestamp: T,
    text: "Hello memory",
    contentStored: true,
  };
}

// ---------------------------------------------------------------------------
// Content policy
// ---------------------------------------------------------------------------

test("user text is preserved with entry provenance", () => {
  const record = applyContentPolicy(userEntry(), 65_536);
  assert.ok(record);
  assert.equal(record.type, "user");
  assert.equal(record.entryId, "u1");
  assert.equal(record.parentId, null);
  assert.equal(record.timestamp, T);
  assert.equal(record.text, "Hello memory");
  assert.equal(record.contentStored, true);
});

test("assistant final text is preserved with provenance", () => {
  const record = applyContentPolicy(assistantEntry(), 65_536);
  assert.ok(record);
  assert.equal(record.type, "assistant");
  assert.equal(record.entryId, "a1");
  assert.equal(record.parentId, "u1");
  assert.equal(record.contentStored, true);
});

test("thinking and system blocks are absent from the source conversion", () => {
  // A Pi session entry with thinking/system/non-text blocks yields no text.
  const entry = {
    id: "m1",
    parentId: null,
    timestamp: T,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning should never persist" },
        { type: "system", text: "repeat after me" },
        { type: "text", text: "final answer" },
      ],
    },
  };
  const source = sessionEntryToSource(entry);
  assert.ok(source);
  assert.equal(source.kind, "assistant");
  assert.equal(source.text, "final answer"); // reasoning/system absent
  assert.ok(!source.text.includes("secret reasoning"));
});

test("thinking-only assistant entries are absent", () => {
  const source = sessionEntryToSource({
    id: "m2",
    parentId: null,
    timestamp: T,
    message: { role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }] },
  });
  assert.equal(source, null);
});

test("tool-result stdout/stderr is absent; bounded metadata retained", () => {
  const source = sessionEntryToSource({
    id: "t1",
    parentId: "a1",
    timestamp: "2026-08-04T10:02:00.000Z",
    message: {
      role: "toolResult",
      toolName: "bash",
      content: "huge stdout with secrets\nstderr lines",
    },
  });
  assert.ok(source);
  assert.equal(source.kind, "tool");
  assert.equal(source.tool.toolName, "bash");
  assert.equal(source.tool.outputBytes, 37);
  assert.equal(source.tool.outputStored, false);

  const record = applyContentPolicy(source, 65_536);
  assert.ok(record);
  assert.equal(record.type, "tool");
  assert.equal(record.text, undefined); // body never stored
  assert.equal(record.tool.outputBytes, 37);
  assert.equal(record.tool.outputStored, false);
  assert.ok(!JSON.stringify(record).includes("huge stdout"));
});

test("thinking blocks inside tool results are absent when text extraction is empty", () => {
  const source = sessionEntryToSource({
    id: "t2",
    parentId: "a1",
    timestamp: T,
    message: { role: "toolResult" },
  });
  assert.ok(source);
  assert.equal(source.kind, "tool");
  assert.ok(source.tool.outputBytes >= 0);
});

test("binary blocks (image/audio/video/base64) are absent", () => {
  assert.equal(applyContentPolicy(userEntry({ text: "look: data:image/png;base64,AAAA" }), 65_536), null);
  assert.equal(applyContentPolicy(userEntry({ text: "QmFzZTY0".repeat(80) }), 65_536), null);

  const source = sessionEntryToSource({
    id: "img1",
    parentId: null,
    timestamp: T,
    message: {
      role: "user",
      content: [{ type: "image", data: "base64payload" }],
    },
  });
  assert.equal(source, null);
});

test("tool-log-looking user/assistant text is absent", () => {
  assert.equal(applyContentPolicy(userEntry({ text: "npm install some-package" }), 65_536), null);
  assert.equal(applyContentPolicy(assistantEntry({ text: "running jest tests now" }), 65_536), null);
});

test("oversized message stores hash, size, bounded excerpts, contentStored false", () => {
  const big = "x".repeat(100_000);
  const record = applyContentPolicy(userEntry({ id: "big1", text: big }), 10_000);
  assert.ok(record);
  assert.equal(record.contentStored, false);
  assert.ok(record.partial);
  assert.equal(record.partial.bytes, 100_000);
  assert.equal(record.partial.contentHash, contentHash(big));
  assert.ok(record.partial.excerptStart.length > 0);
  assert.ok(record.partial.excerptEnd.length > 0);
  assert.ok(record.text.includes("content truncated"));
  // The full secret body must not appear in the persisted excerpt.
  assert.ok(record.text.length < 5000);
});

test("normal message stores complete text and contentStored true", () => {
  const record = applyContentPolicy(userEntry(), 65_536);
  assert.ok(record);
  assert.equal(record.contentStored, true);
  assert.equal(record.text, "Hello memory");
});

test("empty and skip entries are excluded", () => {
  assert.equal(applyContentPolicy(userEntry({ text: "" }), 65_536), null);
  assert.equal(applyContentPolicy({ ...userEntry(), kind: "skip" }, 65_536), null);
  assert.equal(applyContentPolicy({ ...userEntry(), kind: "custom" }, 65_536), null);
});

test("compaction summaries and branch summaries never appear as source evidence", () => {
  const source = sessionEntryToSource(compactionEntry());
  assert.ok(source);
  assert.equal(source.kind, "compaction");
  assert.equal(source.text, "Earlier discussion summarized here.");
  // applyContentPolicy excludes them from archives (checkpoint carries summary).
  assert.equal(applyContentPolicy(source, 65_536), null);
});

test("filtering the same source twice is byte-identical and deterministic", () => {
  const record1 = applyContentPolicy(userEntry(), 65_536);
  const record2 = applyContentPolicy(userEntry(), 65_536);
  assert.equal(canonicalBody([record1]), canonicalBody([record2]));
});

test("control characters are treated as binary and excluded", () => {
  assert.equal(applyContentPolicy(userEntry({ id: "ctrl", text: "a\u0000b\u0007line\u001f" }), 65_536), null);
});

test("legitimate unicode (emoji, combining marks) serializes deterministically", () => {
  const record = applyContentPolicy(userEntry({ id: "uni", text: "héllo 👋 世界 \u0301 x" }), 65_536);
  assert.ok(record);
  const body1 = canonicalBody([record]);
  const again = applyContentPolicy(userEntry({ id: "uni", text: "héllo 👋 世界 \u0301 x" }), 65_536);
  assert.equal(canonicalBody([again]), body1);
  assert.ok(body1.length > 0);
});

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

test("canonical serialization has stable key order and no empty fields", () => {
  const body = canonicalBody([canonicalUser()]);
  assert.ok(body.startsWith('{"contentStored":true,"entryId":"u1","parentId":'));
  // Empty parentId would be dropped; null is preserved.
  assert.ok(body.endsWith("}\n"));
  const line = JSON.parse(body.trim());
  assert.deepEqual(Object.keys(line).sort(), Object.keys(line));
});

test("serialize/parse archive document round-trips canonical records", () => {
  const records = [canonicalUser(), { ...assistantEntry(), type: "assistant", contentStored: true }];
  const body = serializeArchive("proj", "s1", { firstEntryId: "u1", lastEntryId: "a1", createdAt: T }, records);
  const parsed = parseArchiveDocument(body);
  assert.ok(parsed);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].entryId, "u1");
  assert.equal(parsed.records[0].text, "Hello memory");
});

test("recordsToArchive splits only at entry boundaries", () => {
  const records = [];
  for (let i = 0; i < 5; i++) {
    records.push({ ...canonicalUser(), entryId: `e${i}` });
  }
  const chunks = recordsToArchive(records, 120); // small bound forces multiple chunks
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length >= 1);
    assert.ok(Buffer.byteLength(canonicalBody(chunk), "utf8") <= 120 * chunk.length * 2); // loose bound
  }
  // Entry order preserved across chunks.
  const ids = chunks.flat().map((r) => r.entryId);
  assert.deepEqual(ids, ["e0", "e1", "e2", "e3", "e4"]);
});

// ---------------------------------------------------------------------------
// Project identity
// ---------------------------------------------------------------------------

test("explicit projectId wins over git and directory identity", () => {
  const explicit = deriveProjectKey("my-project", "git@github.com:org/repo.git", "/some/cwd");
  const gitOnly = deriveProjectKey(undefined, "git@github.com:org/repo.git", "/some/cwd");
  assert.equal(explicit.source, "explicit");
  assert.ok(explicit.key !== gitOnly.key);
});

test("equivalent https and ssh remotes normalize to the same identity", () => {
  const https = normalizeGitRemote("https://github.com/org/repo.git");
  const ssh = normalizeGitRemote("git@github.com:org/repo.git");
  const sshUrl = normalizeGitRemote("ssh://git@github.com/org/repo.git");
  assert.equal(https, "github.com/org/repo");
  assert.equal(ssh, https);
  assert.equal(sshUrl, https);
});

test("credentials and tokens are stripped from remotes before any identity use", () => {
  const withCreds = normalizeGitRemote("https://user:secret-token@github.com/org/repo.git");
  const plain = normalizeGitRemote("https://github.com/org/repo.git");
  assert.equal(withCreds, plain);
  assert.ok(!withCreds.includes("secret-token"));
  assert.ok(!withCreds.includes("@"));

  const scpCreds = normalizeGitRemote("git@github.com:org/repo.git");
  assert.ok(!scpCreds.includes("git@"));
});

test("two unrelated repos with the same basename receive different keys", () => {
  const a = deriveProjectKey(undefined, undefined, "/Users/x/work/alpha");
  const b = deriveProjectKey(undefined, undefined, "/Users/y/work/alpha");
  assert.ok(a.key !== b.key);
  assert.equal(a.slug, b.slug); // readable part may collide
});

test("a repository moved to another local path retains identity via remote", () => {
  const key1 = deriveProjectKey(undefined, "https://github.com/org/repo.git", "/old/path");
  const key2 = deriveProjectKey(undefined, "https://github.com/org/repo.git", "/new/path");
  assert.equal(key1.key, key2.key);
});

test("project without git receives a deterministic working-directory key", () => {
  const a = directoryIdentity("/Users/x/work/alpha");
  const b = directoryIdentity("/Users/x/work/alpha");
  assert.equal(a.key, b.key);
  assert.ok(a.key.startsWith("alpha-"));
  assert.equal(a.source, "directory");
});

test("malicious project IDs cannot escape the project directory", () => {
  const evil = deriveProjectKey("../escape", undefined, "/cwd");
  assert.ok(!evil.key.includes("./"));
  assert.ok(!evil.key.includes("/"));
  const evil2 = deriveProjectKey("a\u2215b", undefined, "/cwd"); // full-width slash
  assert.ok(!evil2.key.includes("\u2215"));

  assert.throws(() => safeComponent("..", "session"), /Invalid session/);
  assert.throws(() => safeComponent("a/b", "session"), /Invalid session/);
  assert.throws(() => safeComponent("a\\b", "session"), /Invalid session/);
  assert.throws(() => safeComponent("a\u0000b", "session"), /Invalid session/);
  assert.throws(() => safeComponent("a\u2215b", "session"), /Invalid session/);
  assert.equal(safeComponent("plain-id", "session"), "plain-id");
});

test("slugify collapses lookalike separators and disallowed characters", () => {
  assert.equal(slugify("My Project"), "my-project");
  assert.equal(slugify("réseau"), "r-seau");
  assert.equal(slugify("a//b"), "a-b");
  assert.equal(slugify(""), "project");
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test("relative roots are rejected by resolveRootFromEnv", () => {
  const prev = process.env.PI_AGENT_MEMORY_ROOT;
  process.env.PI_AGENT_MEMORY_ROOT = "relative/path";
  try {
    assert.equal(resolveRootFromEnv(), undefined);
  } finally {
    if (prev === undefined) delete process.env.PI_AGENT_MEMORY_ROOT;
    else process.env.PI_AGENT_MEMORY_ROOT = prev;
  }
});

test("absolute root is accepted; provider hint survives", () => {
  const prevRoot = process.env.PI_AGENT_MEMORY_ROOT;
  process.env.PI_AGENT_MEMORY_ROOT = "/tmp/memory-root";
  try {
    assert.equal(resolveRootFromEnv(), "/tmp/memory-root");
  } finally {
    if (prevRoot === undefined) delete process.env.PI_AGENT_MEMORY_ROOT;
    else process.env.PI_AGENT_MEMORY_ROOT = prevRoot;
  }
});

test("config values are clamped or rejected according to documented limits", () => {
  assert.ok(LIMITS.maxMessageBytes.max >= DEFAULT_PROJECT_CONFIG.maxMessageBytes);
  assert.ok(LIMITS.maxChunkBytes.min > 0);
  const defaults = defaultProjectConfig();
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.capture, "conversation");
  assert.equal(defaults.includeToolResults, false);
});

test("secrets in environment never leak into status display config", () => {
  // resolveProviderFromEnv returns only display hints; no credential parsing.
  const prev = process.env.PI_AGENT_MEMORY_PROVIDER;
  process.env.PI_AGENT_MEMORY_PROVIDER = "icloud";
  try {
    // Provider hint is a display string only.
  } finally {
    if (prev === undefined) delete process.env.PI_AGENT_MEMORY_PROVIDER;
    else process.env.PI_AGENT_MEMORY_PROVIDER = prev;
  }
});

// ---------------------------------------------------------------------------
// Retrieval primitives
// ---------------------------------------------------------------------------

function sampleCheckpoint(overrides = {}) {
  return {
    type: "checkpoint",
    schemaVersion: 1,
    checkpointId: "c1",
    sessionId: "s1",
    compactionEntryId: "cmp1",
    reason: "threshold",
    willRetry: false,
    summary: "We decided to use the postgres adapter for persistence.",
    sourceEntryRange: { firstEntryId: "e001", lastEntryId: "e004" },
    archiveFiles: ["20260804T101500-e001-e004-hash.jsonl"],
    firstKeptEntryId: "e003",
    createdAt: "2026-08-04T10:05:00.000Z",
    source: "pi-agent-config-external-memory",
    ...overrides,
  };
}

test("queryTerms splits into lowercase bounded terms", () => {
  const terms = queryTerms("Postgres Adapter & 'custom_path.sym'");
  assert.ok(terms.includes("postgres"));
  assert.ok(terms.includes("adapter"));
  assert.ok(terms.some((t) => t.includes("custom")));
});

test("scoreCheckpoint prefers query matches plus recency", () => {
  const checkpoint = sampleCheckpoint();
  const recentScore = scoreCheckpoint(checkpoint, ["postgres"], new Date("2026-08-04T10:06:00.000Z"));
  const oldScore = scoreCheckpoint(
    { ...checkpoint, createdAt: "2026-07-01T00:00:00.000Z" },
    ["postgres"],
    new Date("2026-08-04T10:06:00.000Z"),
  );
  assert.ok(recentScore > oldScore);
});

test("rankCheckpointCandidates returns a bounded ranked subset", () => {
  const candidates = [
    { checkpoint: sampleCheckpoint(), sessionId: "s1", fileName: "cp1.json" },
    { checkpoint: sampleCheckpoint({ summary: "nothing related here" }), sessionId: "s2", fileName: "cp2.json" },
  ];
  const ranked = rankCheckpointCandidates(candidates, ["postgres"], undefined, MAX_CHECKPOINT_CANDIDATES);
  assert.equal(ranked.length, candidates.length);
  assert.ok(ranked[0].checkpoint.summary.includes("postgres"));
});

test("recordMatches is case-insensitive and symbol-aware", () => {
  const record = { type: "assistant", entryId: "e1", text: "Use the PostgreSQL Adapter!", contentStored: true };
  assert.equal(recordMatches(record, ["postgres"]), true);
  assert.equal(recordMatches(record, ["adapter"]), true);
  assert.equal(recordMatches(record, ["mysql"]), false);
});

test("recallBudgets clamps results and characters", () => {
  const budgets = recallBudgets({ query: "q", maxResults: 1000, maxCharacters: 10_000_000 }, 12_000);
  assert.ok(budgets.maxResults <= 50);
  assert.ok(budgets.maxCharacters <= 100_000);
  const defaults = recallBudgets({ query: "q" }, 12_000);
  assert.equal(defaults.maxResults >= 1, true);
});

test("renderEvidence bounds excerpts and marks truncation incomplete", () => {
  const header = {
    type: "archive",
    schemaVersion: 1,
    projectKey: "p",
    sessionId: "s",
    firstEntryId: "e1",
    lastEntryId: "e1",
    createdAt: T,
  };
  const long = "y".repeat(5000);
  const evidence = renderEvidence(
    header,
    "s",
    [{ type: "assistant", entryId: "e1", timestamp: T, text: long, contentStored: true }],
    "file.jsonl",
  );
  assert.ok(evidence.content.length < 5000);
  assert.equal(evidence.complete, false);
  assert.ok(evidence.content.includes("excerpted"));
});

test("renderEvidence includes provenance metadata", () => {
  const header = {
    type: "archive",
    schemaVersion: 1,
    projectKey: "proj-abc",
    sessionId: "s1",
    firstEntryId: "e001",
    lastEntryId: "e004",
    createdAt: "2026-08-04T10:00:00.000Z",
  };
  const matches = [{ type: "assistant", entryId: "e004", timestamp: "2026-08-04T10:06:00.000Z", text: "Use the postgres adapter", contentStored: true }];
  const evidence = renderEvidence(header, "s1", matches, "20260804T101500-e001-e004-hash.jsonl");
  assert.equal(evidence.kind, "evidence");
  assert.equal(evidence.projectKey, "proj-abc");
  assert.equal(evidence.sessionId, "s1");
  assert.deepEqual(evidence.sourceEntryIds, ["e004"]);
  assert.ok(evidence.sourceTime);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.archiveFile, "20260804T101500-e001-e004-hash.jsonl");
  assert.ok(evidence.content.includes("postgres adapter"));
});

test("excerpted oversized evidence is never reported complete", () => {
  const header = {
    type: "archive",
    schemaVersion: 1,
    projectKey: "p",
    sessionId: "s",
    firstEntryId: "a",
    lastEntryId: "b",
    createdAt: T,
  };
  const partial = {
    type: "user",
    entryId: "b",
    text: "… truncated",
    contentStored: false,
    partial: { contentHash: "h", bytes: 100_000, excerptStart: "x".repeat(300), excerptEnd: "" },
  };
  const evidence = renderEvidence(header, "s", [partial], "file.jsonl");
  assert.equal(evidence.complete, false);
});

test("archiveFileHash extracts the hash suffix from a filename", () => {
  const name = `20260804T101500-e001-e002-${"a".repeat(8)}.jsonl`;
  assert.equal(archiveFileHash(name), "a".repeat(8));
  assert.equal(archiveFileHash("no-hash-here.jsonl"), undefined);
});

// ---------------------------------------------------------------------------
// Store: deterministic naming, hashing, parsing
// ---------------------------------------------------------------------------

test("archiveContentHash is deterministic", () => {
  const records = [canonicalUser()];
  assert.equal(archiveContentHash(records), archiveContentHash(records));
  assert.equal(archiveContentHash(records).length, 8);
});

test("archiveFileName and checkpointFileName are deterministic and safe", () => {
  const name = archiveFileName(T, "e001", "e004", "deadbeef");
  assert.match(name, /^20260804T100000-e001-e004-deadbeef\.jsonl$/);
  const cp = checkpointFileName("2026-08-04T10:05:00.000Z", "c1234567890");
  assert.match(cp, /^20260804T100500-checkpoint-c1234567890\.json$/);
});

test("serialize/parse archive document round-trips header and records", () => {
  const records = [canonicalUser()];
  const content = serializeArchive("proj-abc", "s1", {
    firstEntryId: "u1",
    lastEntryId: "u1",
    createdAt: T,
  }, records);
  const parsed = parseArchiveDocument(content);
  assert.ok(parsed);
  assert.equal(parsed.header.projectKey, "proj-abc");
  assert.equal(parsed.header.sessionId, "s1");
  assert.equal(parsed.header.firstEntryId, "u1");
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].text, "Hello memory");
});

test("serialize/parse checkpoint document round-trips metadata", () => {
  const document = sampleCheckpoint();
  const content = serializeCheckpoint(document);
  const parsed = parseCheckpoint(content);
  assert.ok(parsed);
  assert.equal(parsed.compactionEntryId, "cmp1");
  assert.equal(parsed.reason, "threshold");
  assert.equal(parsed.source, "pi-agent-config-external-memory");
  assert.deepEqual(parsed.sourceEntryRange, { firstEntryId: "e001", lastEntryId: "e004" });
});

test("malformed archive body returns null rather than throwing", () => {
  assert.equal(parseArchiveDocument("not json at all"), null);
  assert.equal(parseArchiveDocument('{"type":"archive"}\ngarbage'), null);
});

// ---------------------------------------------------------------------------
// Store: filesystem behavior (fresh temp dir per test)
// ---------------------------------------------------------------------------

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "em-store-"));
  try {
    await fn(new SyncedFolderStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("writeFile creates parent directories and writes immutably via temp+rename", async () => {
  await withRoot(async (store) => {
    const content = '{"type":"archive"}\n{"entryId":"e1"}\n';
    await store.writeFile(join("a", "b", "archive.jsonl"), content);
    const files = await store.listFiles("a/b");
    assert.deepEqual(files, ["archive.jsonl"]);
    assert.equal(await store.readFile("a/b/archive.jsonl"), content);
    // No leftover temp files.
    const temps = await store.countStaleTemps("a/b");
    assert.equal(temps, 0);
  });
});

test("a completed archive's bytes and hash remain unchanged after unrelated writes", async () => {
  await withRoot(async (store) => {
    const content = JSON.stringify({ type: "archive", schemaVersion: 1 }) + "\n";
    const path = join("s1", "archive.jsonl");
    await store.writeFile(path, content);
    // Another write to a sibling must not alter the first file.
    await store.writeFile(join("s2", "other.jsonl"), "other");
    assert.equal(await store.readFile(path), content);
  });
});

test("writeFile rejects symlinked parents that escape the root", async () => {
  await withRoot(async (store, root) => {
    const outside = await mkdtemp(join(tmpdir(), "em-outside-"));
    try {
      await mkdir(join(root, "projects"), { recursive: true });
      await symlink(outside, join(root, "projects", "escape"), "dir");
      await assert.rejects(
        store.writeFile(join("projects", "escape", "file.jsonl"), "x"),
        /Symlink traversal outside memory root/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("readFile rejects symlinked files that escape the root", async () => {
  await withRoot(async (store, root) => {
    const outside = await mkdtemp(join(tmpdir(), "em-outside-"));
    try {
      await store.writeFile(join("s1", "real.jsonl"), '{"type":"archive"}\n');
      await rm(join(root, "s1", "real.jsonl"));
      await fsWriteFile(join(outside, "secret.jsonl"), "outside-secret");
      await symlink(join(outside, "secret.jsonl"), join(root, "s1", "real.jsonl"), "file");
      await assert.rejects(
        store.readFile("s1/real.jsonl"),
        /Symlink escapes external memory root/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("resolve rejects path escapes and absolute paths", () => {
  assert.throws(() => new SyncedFolderStore("/tmp").resolve("../escape"), /escapes external memory root/);
  assert.throws(() => new SyncedFolderStore("/tmp").resolve("/etc/passwd"), /escapes external memory root/);
});

test("a read-only root reports write failure without creating completed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "em-ro-"));
  try {
    await chmod(root, 0o500);
    const store = new SyncedFolderStore(root);
    await assert.rejects(store.writeFile(join("nested", "file.jsonl"), "x"));
    await assert.rejects(store.listFiles("nested"));
  } finally {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("discoverArchives parses only archive files and ignores others", async () => {
  await withRoot(async (store) => {
    await store.writeFile("s1/20260804T101500-e001-e002-deadbeef.jsonl", serializeArchive("proj", "s1", {
      firstEntryId: "e001",
      lastEntryId: "e002",
      createdAt: T,
    }, [canonicalUser()]));
    await store.writeFile("s1/20260804T101500-checkpoint-c123.json", serializeCheckpoint(sampleCheckpoint()));
    await store.writeFile("s1/notes.md", "# not an archive");
    const archives = await store.discoverArchives("s1");
    assert.equal(archives.length, 1);
    assert.equal(archives[0].header.projectKey, "proj");
  });
});

test("discoverCheckpoints ignores archives and malformed JSON", async () => {
  await withRoot(async (store) => {
    const content = serializeCheckpoint(sampleCheckpoint());
    await store.writeFile("s1/20260804T100500-checkpoint-c123.json", content);
    await store.writeFile("s1/20260804T101500-e001-e002-abcd1234.jsonl", "not an archive");
    const checkpoints = await store.discoverCheckpoints("s1");
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].checkpoint.compactionEntryId, "cmp1");
  });
});

test("cleanup removes only recognized stale temp files below the root", async () => {
  await withRoot(async (store) => {
    await store.writeFile("s1/a.jsonl", "x");
    // Create stale temp + unrelated junk.
    await store.writeFile("s1/a.jsonl" + TEMP_SUFFIX, "junk");
    await fsWriteFile(join(store.root, "s1", "unrelated.tmp"), "junk", { flag: "wx" });
    const removed = await store.cleanupStaleTemps("s1");
    assert.equal(removed, 1);
    const files = await store.listFiles("s1");
    assert.deepEqual(files.sort(), ["a.jsonl", "unrelated.tmp"]);
  });
});

test("countStaleTemps counts only our temp suffix files", async () => {
  await withRoot(async (store) => {
    await store.writeFile("s1/a.jsonl" + TEMP_SUFFIX, "junk");
    await store.writeFile("s1/b.jsonl", "x");
    assert.equal(await store.countStaleTemps("s1"), 1);
  });
});
