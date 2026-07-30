import assert from "node:assert/strict";
import test from "node:test";
import planMode from "./index.ts";
import { isPlanModeActive } from "../work-status/plan-mode-state.ts";

function createHarness(initialTools) {
  let activeTools = [...initialTools];
  const commands = new Map();

  const pi = {
    registerFlag() {},
    registerCommand(name, definition) {
      commands.set(name, definition.handler);
    },
    on() {},
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
    ui: {
      notify() {},
      setStatus() {},
      theme: {
        fg(_color, text) {
          return text;
        },
      },
    },
  };

  planMode(pi);

  return {
    async togglePlan() {
      await commands.get("plan")("", ctx);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names) {
      activeTools = [...names];
    },
  };
}

test("plan mode restores the exact active tool set from before entry", async () => {
  const harness = createHarness(["read", "bash", "custom-search"]);

  await harness.togglePlan();
  assert.deepEqual(harness.getActiveTools(), ["read", "bash"]);
  assert.equal(isPlanModeActive(), true);

  await harness.togglePlan();
  assert.deepEqual(harness.getActiveTools(), ["read", "bash", "custom-search"]);
  assert.equal(isPlanModeActive(), false);
});

test("each plan mode entry captures a fresh tool snapshot", async () => {
  const harness = createHarness(["read", "custom-one"]);

  await harness.togglePlan();
  await harness.togglePlan();

  harness.setActiveTools(["read", "grep", "custom-two"]);
  await harness.togglePlan();
  assert.deepEqual(harness.getActiveTools(), ["read", "grep"]);

  await harness.togglePlan();
  assert.deepEqual(harness.getActiveTools(), ["read", "grep", "custom-two"]);
});
