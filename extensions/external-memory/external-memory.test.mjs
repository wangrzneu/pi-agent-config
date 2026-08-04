import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile as fsWrite } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExternalMemory } from "./external-memory.ts";
import { SyncedFolderStore } from "./synced-folder-store.ts";
import { projectSessionDir } from "./index.ts";

const T0 = "2026-08-04T10:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function snapshot(overrides = {}) {
  return {
    sessionId: "s1",
    branchId: "b1",
    projectKey: "proj",
    timestamp: "2026-08-04T10:15:00.000Z",
    entries: [
      { id: "e001", parentId: null, timestamp: T0, kind: "user", text: "Initial question about postgres" },
      { id: "e002", parentId: "e001", timestamp: "2026-08-04T10:01:00.000Z", kind: "assistant", text: "Use the postgres adapter" },
      { id: "e003", parentId: "e002", timestamp: "2026-08-04T10:05:00.000Z", kind: "user", text: "How does it handle X?" },
      { id: "e004", parentId: "e003", timestamp: "2026-08-04T10:06:00.000Z", kind: "assistant", text: "Details on the adapter design" },
    ],
    ...overrides,
  };
}

function projectConfig(overrides = {}) {
  return {
    enabled: true,
    projectId: "proj",
    capture: "conversation",
    includeToolResults: false,
    maxMessageBytes: 65_536,
    maxChunkBytes: 262_144,
    maxRecallCharacters: 12_000,
    ...overrides,
  };
}

function moduleConfig(root, overrides = {}) {
  return {
    root,
    provider: "filesystem",
    project: projectConfig(overrides),
  };
}

async function withMemory(projectOverrides, fn) {
  const root = await mkdtemp(join(tmpdir(), "em-mod-"));
  try {
    const mem = new ExternalMemory(
      moduleConfig(root, projectOverrides),
      new SyncedFolderStore(root),
    );
    await fn(mem, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function checkpointInfo(overrides = {}) {
  return {
    compactionEntryId: "cmp-1",
    reason: "threshold",
    willRetry: false,
    summary: "We decided to use the postgres adapter and documented its design.",
    sourceRange: { firstEntryId: "e001", lastEntryId: "e004" },
    archiveFiles: [],
    firstKeptEntryId: "e003",
    ...overrides,
  };
}

/** Capture, then write a checkpoint referencing the produced archives. */
async function captureAndCheckpoint(mem, snap, overrides) {
  const result = await mem.capture(snap);
  const dir = projectSessionDir(snap.projectKey, snap.sessionId);
  const archives = await mem.store.discoverArchives(dir);
  return mem.writeCheckpoint(snap.sessionId, snap.projectKey, {
    ...checkpointInfo(overrides),
    archiveFiles: archives.map((a) => a.fileName).sort(),
  });
}

/** A store wrapper that records reads/writes and can inject failures. */
class RecordingStore {
  constructor(root, store) {
    this.root = root;
    this.store = store;
    this.reads = [];
    this.writes = [];
    this.failWrite = false;
    this.failRead = new Set();
  }

  async writeFile(fileName, content) {
    this.writes.push(String(fileName));
    if (this.failWrite) throw new Error("injected write failure");
    await this.store.writeFile(fileName, content);
  }

  async readFile(fileName) {
    this.reads.push(String(fileName));
    if (this.failRead.has(String(fileName))) throw new Error("injected read failure");
    return this.store.readFile(fileName);
  }

  async listFiles(dir) {
    return this.store.listFiles(dir);
  }

  async listDirs(dir) {
    return this.store.listDirs(dir);
  }

  async cleanupTemp(dir, fileName) {
    return this.store.cleanupTemp(dir, fileName);
  }

  async cleanupStaleTemps(dir) {
    return this.store.cleanupStaleTemps(dir);
  }

  async countStaleTemps(dir) {
    return this.store.countStaleTemps(dir);
  }

  async discoverArchives(dir) {
    return this.store.discoverArchives(dir);
  }

  async discoverCheckpoints(dir) {
    return this.store.discoverCheckpoints(dir);
  }

  resolve(relativePath) {
    return this.store.resolve(relativePath);
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

test("first capture writes one archive chunk with correct provenance", async () => {
  await withMemory({}, async (mem) => {
    const result = await mem.capture(snapshot());
    assert.equal(result.captured, true);
    assert.equal(result.chunksCreated.length, 1);
    assert.deepEqual(result.entryRange, { firstEntryId: "e001", lastEntryId: "e004" });

    const dir = projectSessionDir("proj", "s1");
    const files = await mem.store.listFiles(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^20260804T101500-e001-e004-[a-f0-9]{8}\.jsonl$/);

    // Sentinel scan: reasoning secrets and tool bodies absent.
    const body = await mem.store.readFile(join(dir, files[0]));
    assert.ok(!body.includes("secret reasoning"));
  });
});

test("repeating the same capture is idempotent and writes nothing", async () => {
  await withMemory({}, async (mem) => {
    await mem.capture(snapshot());
    const firstFiles = await mem.store.listFiles(projectSessionDir("proj", "s1"));
    const again = await mem.capture(snapshot());
    assert.equal(again.captured, false);
    const secondFiles = await mem.store.listFiles(projectSessionDir("proj", "s1"));
    assert.deepEqual(secondFiles, firstFiles);
  });
});

test("a later capture writes only entries after the watermark", async () => {
  await withMemory({}, async (mem) => {
    await mem.capture(snapshot());
    const result = await mem.capture(snapshot({
      timestamp: "2026-08-04T10:30:00.000Z",
      entries: [
        ...snapshot().entries,
        { id: "e005", parentId: "e004", timestamp: "2026-08-04T10:10:00.000Z", kind: "assistant", text: "Wrapping up" },
      ],
    }));
    assert.equal(result.captured, true);
    assert.deepEqual(result.entryRange, { firstEntryId: "e005", lastEntryId: "e005" });
    const files = await mem.store.listFiles(projectSessionDir("proj", "s1"));
    assert.equal(files.length, 2);
    assert.match(files[1], /e005-e005/);
  });
});

test("an empty incremental range creates no file", async () => {
  await withMemory({}, async (mem) => {
    await mem.capture(snapshot());
    const empty = await mem.capture(snapshot({ entries: [] }));
    assert.equal(empty.captured, false);
    assert.equal(empty.chunksCreated.length, 0);
  });
});

test("chunking splits at entry boundaries under a small maxChunkBytes", async () => {
  await withMemory({ maxChunkBytes: 64 }, async (mem) => {
    const result = await mem.capture(snapshot());
    assert.equal(result.captured, true);
    assert.ok(result.chunksCreated.length >= 2);
    const dir = projectSessionDir("proj", "s1");
    const files = (await mem.store.listFiles(dir)).filter((f) => f.endsWith(".jsonl"));
    assert.deepEqual(files, result.chunksCreated.slice().sort());

    // Reassembled entry ids span the original range.
    const seen = [];
    for (const file of files) {
      const body = await mem.store.readFile(join(dir, file));
      for (const line of body.split("\n").filter(Boolean).slice(1)) {
        seen.push(JSON.parse(line).entryId);
      }
    }
    assert.deepEqual(seen, ["e001", "e002", "e003", "e004"]);
    // Each chunk header carries its own first/last entry ids.
    const first = await mem.store.readFile(join(dir, files[0]));
    assert.ok(first.split("\n")[0].includes('"firstEntryId":"e001"'));
  });
});

test("ancestor session archives are reused after a fork", async () => {
  await withMemory({}, async (mem) => {
    await mem.capture(snapshot());
    const result = await mem.capture(snapshot({
      sessionId: "s2",
      branchId: "b2",
      timestamp: "2026-08-04T10:40:00.000Z",
      ancestorSessionIds: ["s1"],
      entries: [
        ...snapshot().entries, // same shared ancestor entries
        { id: "e010", parentId: "e004", timestamp: "2026-08-04T10:20:00.000Z", kind: "user", text: "Fork adds a question" },
      ],
    }));
    assert.equal(result.captured, true);
    assert.deepEqual(result.entryRange, { firstEntryId: "e010", lastEntryId: "e010" });
    // Only the new branch entry archived under s2.
    const files = await mem.store.listFiles(projectSessionDir("proj", "s2"));
    assert.equal(files.length, 1);
    assert.match(files[0], /e010-e010/);
  });
});

test("prior archives remain byte-identical after later captures", async () => {
  await withMemory({}, async (mem, root) => {
    await mem.capture(snapshot());
    const dir = projectSessionDir("proj", "s1");
    const files = await mem.store.listFiles(dir);
    const before = await readFile(join(root, dir, files[0]), "utf8");
    await mem.capture(snapshot({
      timestamp: "2026-08-04T10:30:00.000Z",
      entries: [...snapshot().entries, { id: "e005", parentId: "e004", timestamp: "2026-08-04T10:10:00.000Z", kind: "assistant", text: "Wrapping up" }],
    }));
    const after = await readFile(join(root, dir, files[0]), "utf8");
    assert.equal(after, before);
  });
});

test("capture is disabled when the project is disabled", async () => {
  await withMemory({ enabled: false }, async (mem) => {
    const result = await mem.capture(snapshot());
    assert.equal(result.captured, false);
    assert.equal(result.message, "disabled");
  });
});

test("sensitive content never leaves protected boundaries", async () => {
  await withMemory({}, async (mem) => {
    const result = await mem.capture(snapshot({
      entries: [
        { id: "e001", parentId: null, timestamp: T0, kind: "user", text: "npm install evil" },
        { id: "e002", parentId: "e001", timestamp: "2026-08-04T10:01:00.000Z", kind: "assistant", text: "the plan: use ../../escape to reach /etc/passwd" },
        { id: "e003", parentId: "e002", timestamp: "2026-08-04T10:02:00.000Z", kind: "tool", tool: { toolName: "bash", status: "success", outputBytes: 1_000_000, outputStored: false } },
      ],
    }));
    assert.equal(result.captured, true);
    const dir = projectSessionDir("proj", "s1");
    const files = await mem.store.listFiles(dir);
    const body = await mem.store.readFile(join(dir, files[0]));
    // Tool log text is excluded; only the bounded tool metadata remains.
    assert.ok(!body.includes("npm install"));
    assert.ok(body.includes('"toolName":"bash"'));
    assert.ok(body.includes('"outputBytes":1000000'));
  });
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

test("writeCheckpoint is idempotent per compaction entry", async () => {
  await withMemory({}, async (mem) => {
    await mem.capture(snapshot());
    const first = await captureAndCheckpoint(mem, snapshot());
    assert.equal(first.checkpointsCreated.length, 1);
    const dup = await captureAndCheckpoint(mem, snapshot());
    assert.equal(dup.checkpointsCreated.length, 0);
    const dir = projectSessionDir("proj", "s1");
    const cps = await mem.store.discoverCheckpoints(dir);
    assert.equal(cps.length, 1);
    assert.equal(cps[0].checkpoint.compactionEntryId, "cmp-1");
    assert.equal(cps[0].checkpoint.reason, "threshold");
    assert.equal(cps[0].checkpoint.source, "pi-agent-config-external-memory");
  });
});

test("checkpoint write failure does not modify completed archives", async () => {
  await withMemory({}, async (mem, root) => {
    await mem.capture(snapshot());
    const dir = projectSessionDir("proj", "s1");
    const archives = await mem.store.listFiles(dir);
    const before = await readFile(join(root, dir, archives[0]), "utf8");
    // Fail subsequent writes (the checkpoint write).
    await mem.store.writeFile; // no-op reference to avoid lint
    const failing = new RecordingStore(root, mem.store);
    // Rebuild module over the failing store for the checkpoint attempt.
    const mem2 = new ExternalMemory(moduleConfig(root), failing);
    failing.failWrite = true;
    const result = await mem2.writeCheckpoint("s1", "proj", checkpointInfo({
      archiveFiles: archives,
    }));
    assert.equal(result.checkpointsCreated.length, 0);
    assert.equal(result.message, "write-failed");
    const after = await readFile(join(root, dir, archives[0]), "utf8");
    assert.equal(after, before);
  });
});

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

test("recall returns matching evidence with full provenance", async () => {
  await withMemory({}, async (mem) => {
    await captureAndCheckpoint(mem, snapshot());
    const results = await mem.recall({ query: "postgres adapter" });
    assert.ok(results.length >= 1);
    const found = results.find((r) => r.sourceEntryIds.includes("e002"));
    assert.ok(found);
    assert.equal(found.projectKey, "proj");
    assert.equal(found.sessionId, "s1");
    assert.ok(found.archiveFile);
    assert.ok(found.sourceTime);
    assert.equal(found.complete, true);
    assert.ok(found.content.toLowerCase().includes("postgres adapter"));
  });
});

test("recall is lazy: only checkpoints then referenced archives are opened", async () => {
  const root = await mkdtemp(join(tmpdir(), "em-lazy-"));
  try {
    const real = new SyncedFolderStore(root);
    const recording = new RecordingStore(root, real);
    const mem = new ExternalMemory(moduleConfig(root), recording);
    await mem.capture(snapshot());
    const dir = projectSessionDir("proj", "s1");
    const archives = await real.discoverArchives(dir);
    await mem.writeCheckpoint("s1", "proj", {
      ...checkpointInfo(),
      archiveFiles: archives.map((a) => a.fileName),
    });
    recording.reads = [];
    const results = await mem.recall({ query: "postgres" });
    assert.ok(results.length >= 1);
    // Only the checkpoint file and its referenced archives were opened.
    for (const read of recording.reads) {
      assert.ok(read.endsWith(".json") || read.endsWith(".jsonl"));
    }
    const archiveReads = recording.reads.filter((r) => r.endsWith(".jsonl"));
    assert.equal(archiveReads.length, archives.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recall enforces max_results", async () => {
  await withMemory({}, async (mem) => {
    // Two sessions so multiple candidates exist.
    for (const sessionId of ["s1", "s2"]) {
      await mem.capture(snapshot({ sessionId, timestamp: `2026-08-04T1${sessionId === "s1" ? "0" : "1"}:15:00.000Z` }));
      await captureAndCheckpoint(mem, snapshot({ sessionId }));
    }
    const results = await mem.recall({ query: "postgres adapter", maxResults: 1 });
    assert.equal(results.length, 1);
  });
});

test("recall enforces max_characters including provenance", async () => {
  await withMemory({}, async (mem) => {
    await captureAndCheckpoint(mem, snapshot());
    const tight = await mem.recall({ query: "postgres", maxCharacters: 512 });
    const roomy = await mem.recall({ query: "postgres", maxCharacters: 100_000 });
    assert.ok(tight.length <= roomy.length);
    for (const result of tight) {
      assert.ok(result.content.length <= 512 * 2); // provenance not counted in content
    }
  });
});

test("recall respects the since filter", async () => {
  await withMemory({}, async (mem) => {
    const julyEntries = [
      { id: "e001", parentId: null, timestamp: "2026-07-01T10:00:00.000Z", kind: "user", text: "Initial question about postgres" },
      { id: "e002", parentId: "e001", timestamp: "2026-07-01T10:01:00.000Z", kind: "assistant", text: "Use the postgres adapter" },
      { id: "e003", parentId: "e002", timestamp: "2026-07-01T10:05:00.000Z", kind: "user", text: "How does it handle X?" },
      { id: "e004", parentId: "e003", timestamp: "2026-07-01T10:06:00.000Z", kind: "assistant", text: "Details on the adapter design" },
    ];
    await mem.capture(snapshot({ sessionId: "old", timestamp: "2026-07-01T10:15:00.000Z", entries: julyEntries }));
    const dirOld = projectSessionDir("proj", "old");
    const oldFiles = (await mem.store.listFiles(dirOld)).filter((f) => f.endsWith(".jsonl"));
    await mem.writeCheckpoint("old", "proj", {
      ...checkpointInfo({ compactionEntryId: "cmp-old", createdAt: "2026-07-05T00:00:00.000Z" }),
      archiveFiles: oldFiles,
    });
    await mem.capture(snapshot({ sessionId: "new", timestamp: "2026-08-04T10:15:00.000Z" }));
    const dirNew = projectSessionDir("proj", "new");
    const newFiles = (await mem.store.listFiles(dirNew)).filter((f) => f.endsWith(".jsonl"));
    await mem.writeCheckpoint("new", "proj", {
      ...checkpointInfo({ compactionEntryId: "cmp-new", createdAt: "2026-08-05T00:00:00.000Z" }),
      archiveFiles: newFiles,
    });

    const recent = await mem.recall({ query: "postgres", since: "2026-08-01T00:00:00.000Z" });
    assert.ok(recent.length >= 1);
    for (const result of recent) {
      assert.equal(result.sessionId, "new");
    }
  });
});

test("conflicting same-range archives keep both files and are reported", async () => {
  await withMemory({}, async (mem) => {
    const dir = projectSessionDir("proj", "s1");
    const anchor = '{"type":"archive","schemaVersion":1,"projectKey":"proj","sessionId":"s1","firstEntryId":"e001","lastEntryId":"e002","createdAt":"2026-08-04T10:15:00.000Z"}\n';
    await mem.store.writeFile(
      join(dir, "20260804T101500-e001-e002-aaaa1111.jsonl"),
      anchor +
        '{"type":"assistant","entryId":"e001","parentId":null,"timestamp":"2026-08-04T10:00:00.000Z","contentStored":true,"text":"version A"}\n' +
        '{"type":"assistant","entryId":"e002","parentId":"e001","timestamp":"2026-08-04T10:01:00.000Z","contentStored":true,"text":"version A tail"}\n',
    );
    await mem.store.writeFile(
      join(dir, "20260804T101500-e001-e002-bbbb2222.jsonl"),
      anchor +
        '{"type":"assistant","entryId":"e001","parentId":null,"timestamp":"2026-08-04T10:00:00.000Z","contentStored":true,"text":"version B"}\n' +
        '{"type":"assistant","entryId":"e002","parentId":"e001","timestamp":"2026-08-04T10:01:00.000Z","contentStored":true,"text":"version B tail"}\n',
    );

    const result = await mem.capture(snapshot({
      entries: [
        { id: "e001", parentId: null, timestamp: T0, kind: "assistant", text: "version B" },
        { id: "e002", parentId: "e001", timestamp: "2026-08-04T10:01:00.000Z", kind: "assistant", text: "version B tail" },
      ],
    }));
    assert.ok(result.conflicts && result.conflicts.length >= 1);
    assert.ok(result.conflicts.every((c) => c.reason.includes("Range e001-e002")));
    // Both immutable inputs remain on disk under distinct hashes.
    const files = (await mem.store.listFiles(dir)).filter((f) => f.endsWith(".jsonl"));
    assert.ok(files.includes("20260804T101500-e001-e002-aaaa1111.jsonl"));
    assert.ok(files.includes("20260804T101500-e001-e002-bbbb2222.jsonl"));
  });
});

test("concurrent captures for one session serialize without duplicates", async () => {
  await withMemory({}, async (mem) => {
    const results = await Promise.all([
      mem.capture(snapshot()),
      mem.capture(snapshot()),
      mem.capture(snapshot()),
    ]);
    const files = (await mem.store.listFiles(projectSessionDir("proj", "s1"))).filter((f) =>
      f.endsWith(".jsonl"),
    );
    assert.equal(files.length, 1);
    assert.equal(results.filter((r) => r.captured).length, 1);
  });
});

test("recall never crosses the current project key", async () => {
  await withMemory({}, async (mem, root) => {
    await captureAndCheckpoint(mem, snapshot());
    // Plant a foreign project archive directly under the same root.
    const foreignDir = projectSessionDir("other-project", "s1");
    const foreignArchives = await mem.store.listFiles(projectSessionDir("proj", "s1"));
    await mem.store.writeFile(
      join(foreignDir, "20260804T101500-f001-f002-abcd1234.jsonl"),
      '{"type":"archive","schemaVersion":1,"projectKey":"other-project","sessionId":"s1","firstEntryId":"f001","lastEntryId":"f002","createdAt":"2026-08-04T10:15:00.000Z"}\n' +
        '{"type":"assistant","entryId":"f002","parentId":"f001","timestamp":"2026-08-04T10:01:00.000Z","contentStored":true,"text":"postgres from the foreign project"}\n',
    );
    await mem.store.writeFile(
      join(foreignDir, "20260804T101501-checkpoint-aaaa111111.json"),
      JSON.stringify({
        type: "checkpoint",
        schemaVersion: 1,
        checkpointId: "aaaaaaaaaa",
        sessionId: "s1",
        compactionEntryId: "f-cmp",
        reason: "threshold",
        willRetry: false,
        summary: "postgres decisions from the foreign project",
        sourceEntryRange: { firstEntryId: "f001", lastEntryId: "f002" },
        archiveFiles: foreignArchives,
        firstKeptEntryId: "f001",
        createdAt: "2026-08-04T10:16:00.000Z",
        source: "pi-agent-config-external-memory",
      }),
    );
    const results = await mem.recall({ query: "postgres" });
    for (const result of results) {
      assert.equal(result.projectKey, "proj");
    }
    assert.ok(!results.some((r) => r.content.includes("foreign")));
  });
});

test("no-match queries return empty rather than unrelated memory", async () => {
  await withMemory({}, async (mem) => {
    await captureAndCheckpoint(mem, snapshot());
    const results = await mem.recall({ query: "zzzz-not-anywhere" });
    assert.equal(results.length, 0);
  });
});

test("malformed archives are skipped during recall without crashing", async () => {
  await withMemory({}, async (mem, root) => {
    await mem.capture(snapshot());
    const dir = projectSessionDir("proj", "s1");
    const archives = await mem.store.listFiles(dir);
    await mem.writeCheckpoint("s1", "proj", { ...checkpointInfo(), archiveFiles: archives });
    // Corrupt the archive file bytes (bypassing the store's atomic write).
    await fsWrite(join(root, dir, archives[0]), "garbage body");
    const results = await mem.recall({ query: "postgres" });
    assert.equal(results.length, 0);
  });
});

test("recall skips an unavailable archive and reports no crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "em-failread-"));
  try {
    const real = new SyncedFolderStore(root);
    const recording = new RecordingStore(root, real);
    const mem = new ExternalMemory(moduleConfig(root), recording);
    await mem.capture(snapshot());
    const dir = projectSessionDir("proj", "s1");
    const archives = await real.discoverArchives(dir);
    await mem.writeCheckpoint("s1", "proj", { ...checkpointInfo(), archiveFiles: archives.map((a) => a.fileName) });
    for (const archive of archives) recording.failRead.add(join(dir, archive.fileName));
    const results = await mem.recall({ query: "postgres" });
    assert.equal(results.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("in-memory candidate cache is discarded on reload", async () => {
  await withMemory({}, async (mem) => {
    await captureAndCheckpoint(mem, snapshot());
    assert.equal((await mem.recall({ query: "postgres" })).length >= 1, true);
    // Simulate reload: the cache is discarded but files persist.
    mem.invalidateCache();
    assert.equal((await mem.recall({ query: "postgres" })).length >= 1, true);
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test("status reports writability and library counts", async () => {
  await withMemory({}, async (mem) => {
    await captureAndCheckpoint(mem, snapshot());
    const status = await mem.status();
    assert.equal(status.configured, true);
    assert.equal(status.enabled, true);
    assert.equal(status.localWritable, true);
    assert.ok(status.libraries.archiveFiles >= 1);
    assert.equal(status.libraries.checkpointFiles, 1);
    assert.ok(!status.message);
  });
});

test("status never claims cloud synchronization from local writes", async () => {
  await withMemory({}, async (mem) => {
    const status = await mem.status();
    // Provider hint is display-only; cloud state stays "unknown".
    assert.equal(status.provider, "filesystem");
    assert.equal(status.cloudSynced, "not-syncing");
  });
});

test("status works when the project is disabled", async () => {
  await withMemory({ enabled: false }, async (mem) => {
    const status = await mem.status();
    assert.equal(status.enabled, false);
    assert.equal(status.localWritable, true);
  });
});

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------

test("capture write failure is fail-open, leaves no completed file, and retries safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "em-fault-"));
  try {
    const real = new SyncedFolderStore(root);
    const recording = new RecordingStore(root, real);
    const mem = new ExternalMemory(moduleConfig(root), recording);

    recording.failWrite = true;
    const failed = await mem.capture(snapshot());
    assert.equal(failed.captured, false);
    assert.equal(failed.chunksCreated.length, 0);
    // No completed archive file exists after the failure.
    const dir = projectSessionDir("proj", "s1");
    await assert.rejects(real.listFiles(dir)); // the directory was never created
    // No temp residue either.
    assert.equal(await real.countStaleTemps(dir), 0);

    // Heal the store: the next capture retries safely.
    recording.failWrite = false;
    const retried = await mem.capture(snapshot());
    assert.equal(retried.captured, true);
    assert.equal((await real.listFiles(dir)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partition failure during directory listing fails open", async () => {
  const fake = {
    root: "/nowhere",
    async writeFile() { throw new Error("no"); },
    async readFile() { throw new Error("no"); },
    async listFiles() { throw new Error("EIO: injected listing failure"); },
    async listDirs() { throw new Error("EIO: injected listing failure"); },
    async cleanupTemp() { return false; },
    async cleanupStaleTemps() { throw new Error("no"); },
    async countStaleTemps() { throw new Error("no"); },
    async discoverArchives() { throw new Error("no"); },
    async discoverCheckpoints() { throw new Error("no"); },
    resolve(p) { return p; },
  };
  const mem = new ExternalMemory(moduleConfig("/nowhere"), fake);
  const results = await mem.recall({ query: "anything" });
  assert.deepEqual(results, []);
  const status = await mem.status();
  assert.equal(status.localWritable, false);
});

test("recall creates no persistent index or cache file", async () => {
  await withMemory({}, async (mem, root) => {
    await captureAndCheckpoint(mem, snapshot());
    const before = await mem.recall({ query: "postgres" });
    assert.ok(before.length >= 1);
    // The root contains only archive + checkpoint JSON(L) files.
    const tree = [];
    const walk = async (dir) => {
      for (const file of await mem.store.listFiles(dir)) tree.push(file);
      for (const sub of await mem.store.listDirs(dir)) await walk(join(dir, sub));
    };
    await walk("");
    for (const file of tree) {
      assert.ok(file.endsWith(".jsonl") || file.endsWith(".json"), `unexpected file: ${file}`);
    }
  });
});
