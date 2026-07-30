import assert from "node:assert/strict";
import test from "node:test";
import workStatus from "./index.ts";
import { setPlanModeActive } from "./plan-mode-state.ts";
import {
  classifyToolActivity,
  classifyWork,
  describeToolActivity,
  summarizeWork,
} from "./work-status.ts";

test("classifies common work types in Chinese and English", () => {
  assert.equal(classifyWork("设计一个新的 API"), "design");
  assert.equal(classifyWork("先给出实现计划"), "plan");
  assert.equal(classifyWork("Add directory navigation"), "implement");
  assert.equal(classifyWork("运行回归测试"), "test");
  assert.equal(classifyWork("Review the current branch"), "review");
  assert.equal(classifyWork("修复启动失败问题"), "fix");
  assert.equal(classifyWork("了解这个仓库"), "explore");
});

test("summarizes prompts without leaking multiline or fenced details into the footer", () => {
  assert.equal(summarizeWork("  # Add status\n\nwith tests  "), "Add status with tests");
  assert.equal(summarizeWork("Inspect this\n```ts\nconst secret = 1;\n```"), "Inspect this");
  assert.equal(summarizeWork("2026 release plan"), "2026 release plan");
  assert.equal(summarizeWork("abcdefghij", 6), "abcde…");
  assert.equal(summarizeWork("优化终端状态显示", 8), "优化终…");
  assert.equal(summarizeWork("   "), "Current task");
});

test("uses high-signal tools to update the current phase", () => {
  assert.equal(classifyToolActivity("edit", { path: "index.ts" }, "design"), "implement");
  assert.equal(classifyToolActivity("edit", { path: "index.ts" }, "fix"), "fix");
  assert.equal(classifyToolActivity("bash", { command: "npm test" }, "implement"), "test");
  assert.equal(classifyToolActivity("bash", { command: "git diff --check" }, "implement"), "review");
  assert.equal(classifyToolActivity("read", { path: "index.ts" }, "plan"), "plan");
});

test("describes tool activity with compact useful details", () => {
  assert.equal(
    describeToolActivity("read", { path: "/workspace/extensions/work-status/index.ts" }),
    "Reading work-status/index.ts",
  );
  assert.equal(describeToolActivity("grep", { pattern: "setStatus" }), "Searching for setStatus");
  assert.equal(describeToolActivity("custom_tool", {}), "Running custom tool");
});

function createHarness() {
  const handlers = new Map();
  const statuses = [];
  const workingMessages = [];

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key, text) {
        statuses.push([key, text]);
      },
      setWorkingMessage(message) {
        workingMessages.push(message);
      },
      theme: {
        fg(_color, text) {
          return text;
        },
      },
    },
  };

  workStatus(pi);

  return {
    statuses,
    workingMessages,
    emit(name, event = {}) {
      return handlers.get(name)(event, ctx);
    },
  };
}

test("shows task type and content, follows tool phases, then clears when settled", async () => {
  const harness = createHarness();

  await harness.emit("before_agent_start", { prompt: "优化 TUI 状态显示" });
  assert.deepEqual(harness.statuses.at(-1), [
    "work-status",
    " Implement · 优化 TUI 状态显示",
  ]);
  assert.equal(harness.workingMessages.at(-1), "Implement · 优化 TUI 状态显示");

  await harness.emit("tool_execution_start", {
    toolCallId: "test-1",
    toolName: "bash",
    args: { command: "npm test" },
  });
  assert.match(harness.statuses.at(-1)[1], / Test · 优化 TUI 状态显示$/);
  assert.equal(harness.workingMessages.at(-1), "Test · npm test");

  await harness.emit("tool_execution_end", { toolCallId: "test-1" });
  assert.match(harness.statuses.at(-1)[1], / Implement · 优化 TUI 状态显示$/);

  await harness.emit("agent_settled");
  assert.deepEqual(harness.statuses.at(-1), ["work-status", undefined]);
  assert.equal(harness.workingMessages.at(-1), undefined);
});

test("keeps a remaining parallel tool visible when another tool finishes", async () => {
  const harness = createHarness();

  await harness.emit("before_agent_start", { prompt: "实现状态扩展" });
  await harness.emit("tool_execution_start", {
    toolCallId: "edit-1",
    toolName: "edit",
    args: { path: "index.ts" },
  });
  await harness.emit("tool_execution_start", {
    toolCallId: "test-1",
    toolName: "bash",
    args: { command: "npm test" },
  });
  await harness.emit("tool_execution_end", { toolCallId: "test-1" });

  assert.equal(harness.workingMessages.at(-1), "Implement · Editing index.ts");
});

test("shows Plan while read-only plan mode is active", async () => {
  const harness = createHarness();
  setPlanModeActive(true);

  try {
    await harness.emit("before_agent_start", { prompt: "实现新的状态扩展" });
    assert.match(harness.statuses.at(-1)[1], / Plan · 实现新的状态扩展$/);
  } finally {
    setPlanModeActive(false);
  }
});
