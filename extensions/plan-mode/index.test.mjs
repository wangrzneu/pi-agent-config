import assert from "node:assert/strict";
import test from "node:test";
import planMode from "./index.ts";
import { isPlanModeActive } from "../work-status/plan-mode-state.ts";
import { extractPlan, isSafeCommand } from "./utils.ts";

function createHarness(initialTools, entries = []) {
  let activeTools = [...initialTools];
  const commands = new Map();
  const shortcuts = new Map();
  const handlers = new Map();
  const appended = [];
  let widget;

  const pi = {
    registerFlag() {},
    registerCommand(name, definition) {
      commands.set(name, definition.handler);
    },
    registerShortcut(shortcut, definition) {
      shortcuts.set(shortcut, definition.handler);
    },
    appendEntry(customType, data) {
      appended.push({ type: "custom", customType, data });
    },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    getFlag() {
      return false;
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names) {
      activeTools = [...names];
    },
  };

  const ctx = {
    hasUI: true,
    sessionManager: {
      getEntries() {
        return [...entries, ...appended];
      },
    },
    ui: {
      notify() {},
      setStatus() {},
      setWidget(_key, content) {
        widget = content;
      },
      theme: {
        fg(_color, text) {
          return text;
        },
      },
    },
  };

  planMode(pi);

  return {
    appended,
    shortcuts,
    getWidget: () => widget,
    async togglePlan() {
      await commands.get("plan")("", ctx);
    },
    async shortcut() {
      await shortcuts.get("ctrl+alt+p")(ctx);
    },
    async start() {
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({ type: "session_start" }, ctx);
      }
    },
    async agentEnd(messages) {
      for (const handler of handlers.get("agent_end") ?? []) {
        await handler({ messages }, ctx);
      }
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names) {
      activeTools = [...names];
    },
  };
}

function assertSameTools(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

test("plan mode preserves non-write tools and restores only write tools", async () => {
  const harness = createHarness([
    "read",
    "bash",
    "edit",
    "write",
    "custom-search",
    "sandbox_authorize_read",
  ]);

  await harness.togglePlan();
  assertSameTools(harness.getActiveTools(), [
    "read",
    "bash",
    "custom-search",
    "sandbox_authorize_read",
  ]);
  assert.equal(isPlanModeActive(), true);

  await harness.togglePlan();
  assertSameTools(harness.getActiveTools(), [
    "read",
    "bash",
    "edit",
    "write",
    "custom-search",
    "sandbox_authorize_read",
  ]);
  assert.equal(isPlanModeActive(), false);
});

test("tools activated during plan mode survive exit", async () => {
  const harness = createHarness(["read", "edit"]);

  await harness.togglePlan();
  assertSameTools(harness.getActiveTools(), ["read"]);

  harness.setActiveTools(["read", "grep", "custom-two"]);
  await harness.togglePlan();
  assertSameTools(harness.getActiveTools(), ["read", "grep", "custom-two", "edit"]);
});

test("plan state is persisted and restored on session start", async () => {
  const harness = createHarness(["read", "edit"]);
  await harness.togglePlan();

  assert.equal(harness.appended.at(-1).customType, "plan-mode");
  assert.equal(harness.appended.at(-1).data.enabled, true);

  // A fresh extension instance restores the saved enabled state.
  const restored = createHarness(["read", "edit"], harness.appended);
  await restored.start();
  assertSameTools(restored.getActiveTools(), ["read"]);
  assert.equal(isPlanModeActive(), true);
  await restored.togglePlan();
  assertSameTools(restored.getActiveTools(), ["read", "edit"]);
});

test("agent_end extracts and persists the last numbered plan", async () => {
  const harness = createHarness(["read", "edit"]);
  await harness.togglePlan();

  await harness.agentEnd([
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Draft plan:\n1. Wrong step\n\nFinal:\nPlan:\n1. Inspect auth\n2. Add test\n\nDone.",
        },
      ],
    },
  ]);

  assert.deepEqual(harness.appended.at(-1).data.plan, ["Inspect auth", "Add test"]);
  assert.deepEqual(harness.getWidget(), ["1. Inspect auth", "2. Add test"]);
});

test("registers the plan/todos commands and the toggle shortcut", () => {
  const harness = createHarness(["read"]);
  assert.ok(harness.shortcuts.has("ctrl+alt+p"));
});

test("extractPlan uses the last Plan section and stops at prose", () => {
  assert.deepEqual(
    extractPlan("Plan:\n1. First\n2. Second\n\nSome prose\n1. Not a plan"),
    ["First", "Second"],
  );
  assert.deepEqual(
    extractPlan("Plan:\n1. Draft\n\nPlan:\n1. Final"),
    ["Final"],
  );
  assert.deepEqual(extractPlan("No plan here"), []);
});

test("safe command allowlist rejects mutating read-command flags", () => {
  assert.equal(isSafeCommand("tree -o /tmp/tree.txt"), false);
  assert.equal(isSafeCommand("less -o /tmp/less.log file.md"), false);
  assert.equal(isSafeCommand("find . -fprint /tmp/out"), false);
  assert.equal(isSafeCommand("date -s 2026-01-01"), false);
  assert.equal(isSafeCommand("rg --pre cat pattern"), false);
  assert.equal(isSafeCommand("fd -x rm {}"), false);

  assert.equal(isSafeCommand("tree"), true);
  assert.equal(isSafeCommand("less file.md"), true);
  assert.equal(isSafeCommand("find . -name main.ts"), true);
  assert.equal(isSafeCommand("date"), true);
  assert.equal(isSafeCommand("rg pattern"), true);
  assert.equal(isSafeCommand("fd -e ts"), true);
});
