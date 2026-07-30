import assert from "node:assert/strict";
import test from "node:test";
import { registerWorkStatus } from "./index.ts";
import {
  classifyWorkWithModel,
  parseClassification,
} from "./model-classifier.ts";
import { setPlanModeActive } from "./plan-mode-state.ts";
import {
  describeToolActivity,
  summarizeWork,
} from "./work-status.ts";

test("accepts only a strict successful model classification", () => {
  assert.deepEqual(
    parseClassification({
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: '{"type":"design","summary":"设计新的 API"}',
        },
      ],
    }),
    { type: "design", summary: "设计新的 API" },
  );
  assert.equal(
    parseClassification({
      stopReason: "stop",
      content: [{ type: "text", text: "```json\n{}\n```" }],
    }),
    undefined,
  );
  assert.equal(
    parseClassification({
      stopReason: "stop",
      content: [{ type: "text", text: '{"type":"unknown","summary":"Task"}' }],
    }),
    undefined,
  );
  assert.equal(
    parseClassification({
      stopReason: "length",
      content: [{ type: "text", text: '{"type":"test","summary":"Test"}' }],
    }),
    undefined,
  );
});

test("summarizes prompts without leaking multiline or fenced details into the footer", () => {
  assert.equal(summarizeWork("  # Add status\n\nwith tests  "), "Add status with tests");
  assert.equal(summarizeWork("Inspect this\n```ts\nconst secret = 1;\n```"), "Inspect this");
  assert.equal(summarizeWork("2026 release plan"), "2026 release plan");
  assert.equal(summarizeWork("abcdefghij", 6), "abcde…");
  assert.equal(summarizeWork("优化终端状态显示", 8), "优化终…");
  assert.equal(summarizeWork("   "), "Current task");
});

test("describes tool activity with compact useful details", () => {
  assert.equal(
    describeToolActivity("read", { path: "/workspace/extensions/work-status/index.ts" }),
    "Reading work-status/index.ts",
  );
  assert.equal(describeToolActivity("grep", { pattern: "setStatus" }), "Searching for setStatus");
  assert.equal(describeToolActivity("custom_tool", {}), "Running custom tool");
});

function createHarness(
  classifyWork = async (prompt) => ({
    type: "implement",
    summary: prompt,
  }),
  mode = "tui",
) {
  const handlers = new Map();
  const statuses = [];
  const workingMessages = [];

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  const ctx = {
    mode,
    hasUI: mode === "tui",
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

  registerWorkStatus(pi, classifyWork);

  return {
    statuses,
    workingMessages,
    emit(name, event = {}) {
      return handlers.get(name)(event, ctx);
    },
  };
}

test("shows model type and content, follows tool details, then clears when settled", async () => {
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
  assert.match(harness.statuses.at(-1)[1], / Implement · 优化 TUI 状态显示$/);
  assert.equal(harness.workingMessages.at(-1), "Implement · npm test");

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

test("shows nothing when model classification fails", async () => {
  const harness = createHarness(async () => undefined);

  await harness.emit("before_agent_start", { prompt: "实现新的状态扩展" });

  assert.equal(
    harness.statuses.some(([, text]) => text !== undefined),
    false,
  );
  assert.equal(
    harness.workingMessages.some((message) => message !== undefined),
    false,
  );
});

test("does not classify outside TUI mode", async () => {
  let calls = 0;
  const harness = createHarness(
    async () => {
      calls++;
      return { type: "implement", summary: "Task" };
    },
    "print",
  );
  await harness.emit("before_agent_start", { prompt: "Task" });

  assert.equal(calls, 0);
});

test("model classifier disables reasoning and returns undefined on failure", async () => {
  let options;
  const ctx = {
    model: {
      provider: "test-provider",
      id: "test-model",
      reasoning: true,
      thinkingLevelMap: { off: "none" },
    },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return {
          ok: true,
          apiKey: "test-key",
          headers: { authorization: "test" },
          env: {},
        };
      },
    },
    signal: undefined,
  };

  const classification = await classifyWorkWithModel(
    "Classify unique model task 1",
    ctx,
    async (_model, _context, receivedOptions) => {
      options = receivedOptions;
      return {
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: '{"type":"review","summary":"Review model output"}',
          },
        ],
      };
    },
  );

  assert.deepEqual(classification, {
    type: "review",
    summary: "Review model output",
  });
  assert.equal("reasoning" in options, false);
  assert.equal("temperature" in options, false);
  assert.equal(options.maxRetries, 0);

  assert.equal(
    await classifyWorkWithModel(
      "Classify unique model task 2",
      ctx,
      async () => {
        throw new Error("provider unavailable");
      },
    ),
    undefined,
  );
});

test("model classifier skips models that cannot disable reasoning", async () => {
  let called = false;
  const classification = await classifyWorkWithModel(
    "Classify unique model task 3",
    {
      model: {
        provider: "test-provider",
        id: "always-reasoning",
        reasoning: true,
        thinkingLevelMap: { off: null },
      },
      modelRegistry: {
        async getApiKeyAndHeaders() {
          throw new Error("should not resolve auth");
        },
      },
      signal: undefined,
    },
    async () => {
      called = true;
      return {};
    },
  );

  assert.equal(classification, undefined);
  assert.equal(called, false);
});
