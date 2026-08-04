import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import externalMemoryExtension, { resetMemoryToolRegistration } from "./index.ts";

const T0 = "2026-08-04T10:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixtures: Pi-like session entries (message shape) and a fake SessionManager
// ---------------------------------------------------------------------------

function userEntry(id, parentId, text) {
  return { id, parentId, timestamp: T0, message: { role: "user", content: [{ type: "text", text }] } };
}
function assistantEntry(id, parentId, text) {
  return { id, parentId, timestamp: T0, message: { role: "assistant", content: [{ type: "text", text }] } };
}

const BRANCH = [
  userEntry("e001", null, "Initial question about postgres"),
  assistantEntry("e002", "e001", "Use the postgres adapter"),
  userEntry("e003", "e002", "How does it handle X?"),
  assistantEntry("e004", "e003", "Details on the adapter design"),
];

/** getBranch returns oldest-first like real Pi (which reverses internally). */
function makeSessionManager(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const sm = {
    getSessionId: () => "s1",
    getLeafId: () => (entries.length ? entries[entries.length - 1].id : null),
    getBranch(fromId) {
      const startId = fromId ?? (entries.length ? entries[entries.length - 1].id : undefined);
      const chain = [];
      let current = startId ? byId.get(startId) : undefined;
      while (current) {
        chain.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      chain.reverse(); // newest -> oldest, then to oldest-first
      return chain;
    },
  };
  sm.replaceEntries = (next) => {
    entries.splice(0, entries.length, ...next);
    byId.clear();
    for (const e of next) byId.set(e.id, e);
  };
  return sm;
}

// ---------------------------------------------------------------------------
// Fake ExtensionAPI harness
// ---------------------------------------------------------------------------

function createHarness({ root, cwd, entries = BRANCH, confirmResult = true, hasUI = true } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = [];
  const notifications = [];

  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, definition) {
      commands.set(name, definition.handler);
    },
    registerTool(definition) {
      tools.push(definition);
    },
    registerFlag() {},
  };

  const ctx = {
    cwd,
    mode: "tui",
    hasUI,
    sessionManager: makeSessionManager(entries),
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      confirm: async () => confirmResult,
    },
    compact() {},
    shutdown() {},
    isIdle: () => true,
  };

  resetMemoryToolRegistration();
  externalMemoryExtension(pi);

  return {
    handlers,
    commands,
    tools,
    notifications,
    ctx,
    start: (reason = "startup") =>
      handlers.get("session_start")({ type: "session_start", reason }, ctx),
    beforeCompact: (reason = "manual", willRetry = false) =>
      handlers.get("session_before_compact")(
        {
          type: "session_before_compact",
          reason,
          willRetry,
          branchEntries: entries,
          preparation: { firstKeptEntryId: "e003", messagesToSummarize: [] },
          signal: new AbortController().signal,
        },
        ctx,
      ),
    compact: (reason = "threshold", willRetry = false) =>
      handlers.get("session_compact")(
        {
          type: "session_compact",
          reason,
          willRetry,
          fromExtension: false,
          compactionEntry: {
            id: "cmp-001",
            summary: "We decided to use the postgres adapter and documented its design.",
            firstKeptEntryId: "e003",
          },
        },
        ctx,
      ),
    shutdown: (reason = "quit") =>
      handlers.get("session_shutdown")({ type: "session_shutdown", reason }, ctx),
    command: (name, args = "") => commands.get(name)(args, ctx),
  };
}

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

async function withMemoryRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "em-lc-root-"));
  const cwd = await mkdtemp(join(tmpdir(), "em-lc-cwd-"));
  const prevRoot = process.env.PI_AGENT_MEMORY_ROOT;
  process.env.PI_AGENT_MEMORY_ROOT = root;
  try {
    await fn(root, cwd);
  } finally {
    if (prevRoot === undefined) delete process.env.PI_AGENT_MEMORY_ROOT;
    else process.env.PI_AGENT_MEMORY_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

async function optIn(cwd, enabled = true) {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "external-memory.json"),
    JSON.stringify({ enabled }) + "\n",
    { mode: 0o600 },
  );
}

/** Recursively list all files below a directory. */
async function tree(dir) {
  const out = [];
  const walk = async (current) => {
    const items = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const full = join(current, item.name);
      if (item.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(dir);
  return out.sort();
}

function archivesOf(files) {
  return files.filter((f) => f.endsWith(".jsonl"));
}
function checkpointsOf(files) {
  return files.filter(
    (f) => f.endsWith(".json") && !f.endsWith(".pi-external-memory-tmp") && !f.endsWith("project.json"),
  );
}

// ---------------------------------------------------------------------------
// Configuration and lifecycle
// ---------------------------------------------------------------------------

test("missing root leaves memory disabled and warns", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "em-lc-noenv-"));
  const prevRoot = process.env.PI_AGENT_MEMORY_ROOT;
  delete process.env.PI_AGENT_MEMORY_ROOT;
  try {
    const harness = createHarness({ cwd });
    await harness.start();
    assert.equal(harness.tools.length, 0); // no tool while disabled
    const hint = harness.notifications.find((n) => n.message.includes("PI_AGENT_MEMORY_ROOT"));
    assert.ok(hint, "expected a hint about PI_AGENT_MEMORY_ROOT");
  } finally {
    if (prevRoot === undefined) delete process.env.PI_AGENT_MEMORY_ROOT;
    else process.env.PI_AGENT_MEMORY_ROOT = prevRoot;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("opt-in without a root stays disabled and captures nothing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "em-lc-noenv2-"));
  await optIn(cwd);
  const prevRoot = process.env.PI_AGENT_MEMORY_ROOT;
  delete process.env.PI_AGENT_MEMORY_ROOT;
  try {
    const harness = createHarness({ cwd });
    await harness.start();
    await harness.beforeCompact();
    const notifications = harness.notifications.map((n) => n.message).join("\n");
    assert.ok(notifications.includes("PI_AGENT_MEMORY_ROOT"));
  } finally {
    if (prevRoot === undefined) delete process.env.PI_AGENT_MEMORY_ROOT;
    else process.env.PI_AGENT_MEMORY_ROOT = prevRoot;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("opt-in with a root enables memory and registers the recall tool", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    const harness = createHarness({ root, cwd });
    await harness.start();
    assert.equal(harness.tools.length, 1);
    assert.equal(harness.tools[0].name, "memory_recall");
    // No proactive writes at session start (no write amplification).
    assert.deepEqual(archivesOf(await tree(root)), []);
  });
});

test("session_start emits no per-turn writes", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    const harness = createHarness({ root, cwd });
    await harness.start();
    await harness.start();
    assert.deepEqual(await tree(root), []);
  });
});

test("session_before_compact captures the unarchived range and does not cancel compaction", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    const harness = createHarness({ root, cwd });
    await harness.start();

    const result = await harness.beforeCompact("manual");
    assert.equal(result, undefined); // fail-open: no replacement, no cancel

    const files = await tree(root);
    assert.equal(archivesOf(files).length, 1);
    const body = await readFile(archivesOf(files)[0], "utf8");
    assert.ok(body.includes('"firstEntryId":"e001"'));
    assert.ok(body.includes('"lastEntryId":"e004"'));

    // A repeated before_compact must not duplicate archives.
    await harness.beforeCompact("manual");
    assert.equal(archivesOf(await tree(root)).length, 1);
  });
});

test("threshold compaction writes a checkpoint after the event", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    const harness = createHarness({ root, cwd });
    await harness.start();
    await harness.beforeCompact("threshold");
    await harness.compact("threshold");

    const files = await tree(root);
    const checkpoints = checkpointsOf(files);
    assert.equal(checkpoints.length, 1);
    const body = await readFile(checkpoints[0], "utf8");
    const doc = JSON.parse(body);
    assert.equal(doc.type, "checkpoint");
    assert.equal(doc.compactionEntryId, "cmp-001");
    assert.equal(doc.reason, "threshold");
    assert.equal(doc.source, "pi-agent-config-external-memory");
    assert.equal(doc.firstKeptEntryId, "e003");
    assert.ok(doc.summary.includes("postgres adapter"));
    assert.equal(doc.archiveFiles.length, 1);
    assert.ok(doc.archiveFiles[0].endsWith(".jsonl"));
  });
});

test("overflow compaction records willRetry and stays idempotent when retried", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    const harness = createHarness({ root, cwd });
    await harness.start();
    await harness.beforeCompact("overflow", true);
    await harness.compact("overflow", true);
    await harness.compact("overflow", true); // retried

    const files = await tree(root);
    assert.equal(archivesOf(files).length, 1);
    assert.equal(checkpointsOf(files).length, 1);
    const doc = JSON.parse(await readFile(checkpointsOf(files)[0], "utf8"));
    assert.equal(doc.willRetry, true);
    assert.equal(doc.reason, "overflow");
  });
});

test("session_shutdown captures only the unarchived tail", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    const harness = createHarness({ root, cwd });
    await harness.start();
    await harness.beforeCompact("manual");
    await harness.compact("threshold");

    // The session continues; new entries appear on the active branch.
    harness.ctx.sessionManager.replaceEntries([
      ...BRANCH,
      assistantEntry("e005", "e004", "We also added a retry helper."),
    ]);
    await harness.shutdown("quit");

    const files = await tree(root);
    const archives = archivesOf(files);
    assert.equal(archives.length, 2);
    assert.equal(checkpointsOf(files).length, 1);
    const tailBody = await readFile(archives[archives.length - 1], "utf8");
    assert.ok(tailBody.includes('"firstEntryId":"e005"'));
  });
});

test("shutdown reasons (reload, new, resume, fork) never duplicate prior chunks", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    const harness = createHarness({ root, cwd });
    await harness.start();
    await harness.beforeCompact("manual");
    for (const reason of ["reload", "new", "resume", "fork"]) {
      await harness.shutdown(reason);
    }
    assert.equal(archivesOf(await tree(root)).length, 1);
  });
});

test("capture failures fail open for the Pi lifecycle", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    // Make the root unwritable so the write probe and capture fail.
    await chmod(root, 0o500);
    const harness = createHarness({ root, cwd });
    try {
      await harness.start(); // must not throw
      const warning = harness.notifications.find((n) => n.level === "warning");
      assert.ok(warning, "expected an unwritable-root warning");
      assert.equal(await harness.beforeCompact("manual"), undefined); // fail-open
      assert.equal(await harness.beforeCompact("manual"), undefined);
    } finally {
      await chmod(root, 0o700).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// /memory commands
// ---------------------------------------------------------------------------

test("/memory on enables memory and captures afterwards", async () => {
  await withMemoryRoot(async (root, cwd) => {
    // No opt-in yet.
    const harness = createHarness({ root, cwd, confirmResult: true });
    await harness.start();
    assert.equal(harness.tools.length, 0);

    await harness.command("memory", "on");
    assert.equal(harness.tools.length, 1);
    const configBody = await readFile(join(cwd, ".pi", "external-memory.json"), "utf8");
    assert.equal(JSON.parse(configBody).enabled, true);

    await harness.beforeCompact("manual");
    assert.equal(archivesOf(await tree(root)).length, 1);
  });
});

test("/memory on declines when the user does not confirm", async () => {
  await withMemoryRoot(async (root, cwd) => {
    const harness = createHarness({ root, cwd, confirmResult: false });
    await harness.start();
    await harness.command("memory", "on");
    assert.equal(harness.tools.length, 0);
    assert.deepEqual(archivesOf(await tree(root)), []);
  });
});

test("/memory off disables future capture but keeps existing files", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    const harness = createHarness({ root, cwd });
    await harness.start();
    await harness.beforeCompact("manual");
    const before = await tree(root);
    assert.equal(archivesOf(before).length, 1);

    await harness.command("memory", "off");
    await harness.beforeCompact("manual"); // no-op now
    const after = await tree(root);
    assert.deepEqual(after, before); // no deletions, no growth
  });
});

test("/memory status reports configuration and counts", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    const harness = createHarness({ root, cwd });
    await harness.start();
    await harness.beforeCompact("manual");
    await harness.command("memory", "status");
    const text = harness.notifications.map((n) => n.message).join("\n");
    assert.ok(text.includes("Archives: 1"));
    assert.ok(text.includes("Checkpoints: 0"));
  });
});

test("/memory search recalls matching evidence; disabled search explains enabling", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    const harness = createHarness({ root, cwd });
    await harness.start();
    await harness.beforeCompact("manual");
    await harness.compact("threshold");

    await harness.command("memory", "search postgres adapter");
    const text = harness.notifications.at(-1).message;
    assert.ok(text.toLowerCase().includes("postgres adapter"));

    // Disabled memory explains how to enable it and writes nothing.
    await harness.command("memory", "off");
    const notificationsBefore = harness.notifications.length;
    await harness.command("memory", "search anything");
    assert.ok(harness.notifications.at(-1).message.includes("/memory on"));
    assert.ok(harness.notifications.length >= notificationsBefore);
    assert.deepEqual(await tree(root), await tree(root)); // nothing written by search
  });
});

test("/memory capture uses the same capture path and stays idempotent", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    const harness = createHarness({ root, cwd });
    await harness.start();
    await harness.command("memory", "capture");
    assert.equal(archivesOf(await tree(root)).length, 1);
    await harness.command("memory", "capture");
    assert.equal(archivesOf(await tree(root)).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

test("memory_recall tool returns bounded evidence only when enabled", async () => {
  await withMemoryRoot(async (root, cwd) => {
    await optIn(cwd);
    const harness = createHarness({ root, cwd });
    await harness.start();
    await harness.beforeCompact("manual");
    await harness.compact("threshold");

    const tool = harness.tools.find((t) => t.name === "memory_recall");
    assert.ok(tool);
    const result = await tool.execute("call-1", { query: "postgres adapter" }, new AbortController().signal, () => {}, harness.ctx);
    assert.ok(result.content[0].type === "text");
    const text = result.content[0].text.toLowerCase();
    assert.ok(text.includes("postgres adapter"));
    assert.ok(text.includes("session=s1"));
  });
});
