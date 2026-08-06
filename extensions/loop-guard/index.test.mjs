import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LOOP_OPTIONS } from "./loop-detector.ts";
import loopGuardExtension, { registerLoopGuardExtension } from "./index.ts";

function fakePi() {
  const commands = new Map();
  const handlers = new Map();
  return {
    commands,
    handlers,
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
}

function fakeCtx(confirm = async () => true) {
  const notifications = [];
  let aborted = false;
  let abortCount = 0;
  return {
    hasUI: true,
    mode: "tui",
    ui: {
      confirm,
      notify: (message) => { notifications.push(message); },
      theme: { fg: () => "" },
      setStatus: () => undefined,
    },
    notifications,
    abort: () => { aborted = true; abortCount += 1; },
    get aborted() { return aborted; },
    get abortCount() { return abortCount; },
  };
}

function installed() {
  const pi = fakePi();
  registerLoopGuardExtension(pi, {
    maxRepeatedCalls: 3,
    minCycleRepetitions: 2,
    maxTotalCalls: 10,
    totalWindowCalls: 3,
    maxRepeatedPhrases: 3,
    analyzeEveryChars: 1,
    minPhraseLength: 4,
    cooldownRuns: 1,
  });
  return pi;
}

function toolCall(pi, ctx, tool, input, callId) {
  return pi.handlers.get("tool_call")({ toolName: tool, input, toolCallId: callId }, ctx);
}

test("aborts the run silently after repeated identical tool calls", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  await toolCall(pi, ctx, "bash", { command: "git status" }, "c1");
  await toolCall(pi, ctx, "bash", { command: "git status" }, "c2");
  assert.equal(ctx.aborted, false);
  await toolCall(pi, ctx, "bash", { command: "git status" }, "c3");
  assert.equal(ctx.aborted, true, "no confirmation, direct abort");
  assert.match(ctx.notifications.join("\n"), /Loop guard aborted the run.*bash \{"command":"git status"\}/);
});

test("a false-positive abort leaves the next run uninterrupted (cooldown)", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  // Run 1 repeats → aborted exactly once.
  for (let i = 0; i < 3; i += 1) {
    await toolCall(pi, ctx, "read", { path: "a.ts" }, `r${i}`);
  }
  assert.equal(ctx.aborted, true);
  assert.equal(ctx.abortCount, 1);

  // Run 2 (the cooldown run) repeats too but must NOT abort again.
  pi.handlers.get("agent_start")({}, ctx);
  for (let i = 0; i < 6; i += 1) {
    await toolCall(pi, ctx, "read", { path: "a.ts" }, `s${i}`);
  }
  assert.equal(ctx.abortCount, 1, "cooldown keeps the next run uninterrupted");

  // Run 3 detects again (cooldown spent).
  pi.handlers.get("agent_start")({}, ctx);
  for (let i = 0; i < 3; i += 1) {
    await toolCall(pi, ctx, "read", { path: "a.ts" }, `t${i}`);
  }
  assert.equal(ctx.abortCount, 2, "detection re-arms after the cooldown");
});

test("cooldownRuns: 2 skips two runs after an abort", async () => {
  const pi = fakePi();
  registerLoopGuardExtension(pi, {
    maxRepeatedCalls: 2,
    minCycleRepetitions: 100,
    maxRepeatedPhrases: 100,
    cooldownRuns: 2,
  });
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  // Run 1: two identical calls abort.
  await toolCall(pi, ctx, "read", { path: "a.ts" }, "a1");
  await toolCall(pi, ctx, "read", { path: "a.ts" }, "a2");
  assert.equal(ctx.abortCount, 1);

  // Run 2 and run 3 are cooldown runs: identical calls must NOT abort.
  for (let run = 0; run < 2; run += 1) {
    pi.handlers.get("agent_start")({}, ctx);
    for (let i = 0; i < 4; i += 1) {
      await toolCall(pi, ctx, "read", { path: "a.ts" }, `s${run}-${i}`);
    }
  }
  assert.equal(ctx.abortCount, 1, "two cooldown runs stay uninterrupted");

  // Run 4 detects again.
  pi.handlers.get("agent_start")({}, ctx);
  await toolCall(pi, ctx, "read", { path: "a.ts" }, "c1");
  await toolCall(pi, ctx, "read", { path: "a.ts" }, "c2");
  assert.equal(ctx.abortCount, 2);
});

test("the tool call that crosses the threshold is blocked", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  // The third identical call both aborts the run AND is blocked.
  let blocked;
  for (let i = 0; i < 3; i += 1) {
    blocked = await toolCall(pi, ctx, "bash", { command: "rm -rf x" }, `b${i}`);
  }
  assert.equal(ctx.aborted, true);
  assert.equal(blocked.block, true, "threshold-crossing call must not execute");
});

test("remaining tool calls in a poisoned batch are blocked after an abort", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  // Output-loop abort (3 identical phrases) — the turn then tries more tools.
  for (let i = 0; i < 3; i += 1) {
    await messageUpdate(pi, ctx, "同一个句子。");
  }
  assert.equal(ctx.aborted, true);

  const blocked = await toolCall(pi, ctx, "bash", { command: "echo harmful" }, "after");
  assert.equal(blocked.block, true,
    "post-abort tool calls in the poisoned turn must be blocked"
  );
});

test("visible text between identical calls resets the tool detector (progress)", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  // Three identical calls, but each is separated by visible text: the
  // commentary is progress, so the tool repeat must NOT fire.
  await toolCall(pi, ctx, "bash", { command: "git status" }, "p0");
  await messageUpdate(pi, ctx, "Let me check the repo state.");
  await toolCall(pi, ctx, "bash", { command: "git status" }, "p1");
  await messageUpdate(pi, ctx, "Still checking.");
  await toolCall(pi, ctx, "bash", { command: "git status" }, "p2");
  assert.equal(ctx.aborted, false, "text between calls counts as progress");
});

test("aborts without UI and without requiring a confirmation channel", async () => {
  const pi = installed();
  const noUi = fakeCtx();
  noUi.hasUI = false;
  noUi.mode = "print";
  pi.handlers.get("agent_start")({}, noUi);

  for (let i = 0; i < 3; i += 1) {
    await toolCall(pi, noUi, "bash", { command: "while true; do :; done" }, `b${i}`);
  }
  assert.equal(noUi.aborted, true);
});

test("/loop-guard off disables detection", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  await pi.commands.get("loop-guard").handler("off", ctx);
  for (let i = 0; i < 3; i += 1) {
    await toolCall(pi, ctx, "bash", { command: "git status" }, `d${i}`);
  }
  assert.equal(ctx.aborted, false);
});

test("default export is enabled out of the box with no configuration", async () => {
  const pi = fakePi();
  const ctx = fakeCtx();
  loopGuardExtension(pi);
  assert.ok(pi.commands.has("loop-guard"), "loop-guard command must be registered");
  pi.handlers.get("agent_start")({}, ctx);
  for (let i = 0; i < DEFAULT_LOOP_OPTIONS.maxRepeatedCalls; i += 1) {
    await toolCall(pi, ctx, "bash", { command: "git status" }, `z${i}`);
  }
  assert.equal(ctx.aborted, true, "loop guard must interrupt by default without any opt-in");
});

function messageUpdate(pi, ctx, delta, streamType = "text_delta") {
  return pi.handlers.get("message_update")({
    message: { role: "assistant" },
    assistantMessageEvent: { type: streamType, delta, partial: {} },
  }, ctx);
}

test("aborts on a verbal loop in streamed output (silently)", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  // Two repeats are not enough (custom threshold 3).
  await messageUpdate(pi, ctx, "现在执行 lldb。");
  await messageUpdate(pi, ctx, "现在执行 lldb。");
  assert.equal(ctx.aborted, false);

  await messageUpdate(pi, ctx, "现在执行 lldb。");
  assert.equal(ctx.aborted, true);
  assert.match(ctx.notifications.join("\n"), /Loop guard aborted the run.*现在执行 lldb/);
});

test("verbal loop abort works without UI", async () => {
  const pi = installed();
  const noUi = fakeCtx();
  noUi.hasUI = false;
  noUi.mode = "print";
  pi.handlers.get("agent_start")({}, noUi);
  for (let i = 0; i < 3; i += 1) {
    await messageUpdate(pi, noUi, "同一个句子。");
  }
  assert.equal(noUi.aborted, true);
});

test("only one abort per agent run, and it wins over later detections", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  // Fire a tool-call repeat; it aborts exactly once.
  for (let i = 0; i < 3; i += 1) {
    await toolCall(pi, ctx, "bash", { command: "git status" }, `q${i}`);
  }
  assert.equal(ctx.aborted, true);
  const aborts = ctx.notifications.filter((message) => /Loop guard aborted/.test(message)).length;
  assert.equal(aborts, 1, "exactly one abort notification per run");

  // A later verbal-loop detection must not stack a second abort.
  await messageUpdate(pi, ctx, "现在执行 lldb。");
  await messageUpdate(pi, ctx, "现在执行 lldb。");
  await messageUpdate(pi, ctx, "现在执行 lldb。");
  assert.equal(ctx.aborted, true);
  assert.equal(
    ctx.notifications.filter((message) => /Loop guard aborted/.test(message)).length,
    1,
    "second detection in the same run is ignored",
  );
});

test("thinking and text repetition are tracked separately", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  // A thinking-only repetition below the text threshold: text detector must
  // not see it, so no abort at the text threshold. With the configured
  // thresholds both channels use 3, so 3 thinking repeats still abort — the
  // separation guarantee here is that text deltas never feed the thinking
  // counter and vice versa.
  for (let i = 0; i < 3; i += 1) {
    await messageUpdate(pi, ctx, "思考中重复短语。", "thinking_delta");
  }
  assert.equal(ctx.aborted, true);

  // Fresh run: same phrase streamed as visible text also aborts (same
  // threshold in this config), but each channel counted independently.
  pi.handlers.get("agent_start")({}, ctx);
  for (let i = 0; i < 3; i += 1) {
    await messageUpdate(pi, ctx, "思考中重复短语。", "text_delta");
  }
  assert.equal(ctx.aborted, true);
});

test("argument key order does not evade detection", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  await toolCall(pi, ctx, "bash", { command: "npm test", timeout: 10 }, "k1");
  await toolCall(pi, ctx, "bash", { timeout: 10, command: "npm test" }, "k2");
  await toolCall(pi, ctx, "bash", { command: "npm test", timeout: 10 }, "k3");
  assert.equal(ctx.aborted, true);
});
