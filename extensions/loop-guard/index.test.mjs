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
    abort: () => { aborted = true; },
    get aborted() { return aborted; },
  };
}

function installed() {
  const pi = fakePi();
  registerLoopGuardExtension(pi, {
    maxRepeatedCalls: 3,
    minCycleRepetitions: 2,
    maxTotalCalls: 10,
    maxRepeatedPhrases: 3,
    analyzeEveryChars: 1,
  });
  return pi;
}

function toolCall(pi, ctx, tool, input, callId) {
  return pi.handlers.get("tool_call")({ toolName: tool, input, toolCallId: callId }, ctx);
}

test("aborts the run after repeated identical tool calls (with confirmation)", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  await toolCall(pi, ctx, "bash", { command: "git status" }, "c1");
  await toolCall(pi, ctx, "bash", { command: "git status" }, "c2");
  assert.equal(ctx.aborted, false);
  await toolCall(pi, ctx, "bash", { command: "git status" }, "c3");
  assert.equal(ctx.aborted, true);
  assert.match(ctx.notifications.join("\n"), /Aborted agent run.*bash \{"command":"git status"\}/);
});

test("does not abort when the user declines, and snoozes until the next run", async () => {
  const pi = installed();
  let approve = false;
  const ctx = fakeCtx(async () => approve);
  pi.handlers.get("agent_start")({}, ctx);

  for (let i = 0; i < 3; i += 1) {
    await toolCall(pi, ctx, "read", { path: "a.ts" }, `r${i}`);
  }
  assert.equal(ctx.aborted, false);
  assert.match(ctx.notifications.join("\n"), /paused until the next agent run/);

  // Snoozed: even more repeats do not abort within the same run.
  await toolCall(pi, ctx, "read", { path: "a.ts" }, "r3");
  assert.equal(ctx.aborted, false);

  // A new agent run resets the snooze; approving now aborts.
  approve = true;
  pi.handlers.get("agent_start")({}, ctx);
  for (let i = 0; i < 3; i += 1) {
    await toolCall(pi, ctx, "read", { path: "a.ts" }, `s${i}`);
  }
  assert.equal(ctx.aborted, true);
});

test("aborts directly without UI when no interactive confirmation is possible", async () => {
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

test("aborts on a verbal loop in streamed output (with confirmation)", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  // Two repeats are not enough (custom threshold 3).
  await messageUpdate(pi, ctx, "现在执行 lldb。");
  await messageUpdate(pi, ctx, "现在执行 lldb。");
  assert.equal(ctx.aborted, false);

  await messageUpdate(pi, ctx, "现在执行 lldb。");
  assert.equal(ctx.aborted, true);
  assert.match(ctx.notifications.join("\n"), /Aborted agent run.*现在执行 lldb/);
});

test("verbal loop abort works without UI and with snooze", async () => {
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

test("argument key order does not evade detection", async () => {
  const pi = installed();
  const ctx = fakeCtx();
  pi.handlers.get("agent_start")({}, ctx);

  await toolCall(pi, ctx, "bash", { command: "npm test", timeout: 10 }, "k1");
  await toolCall(pi, ctx, "bash", { timeout: 10, command: "npm test" }, "k2");
  await toolCall(pi, ctx, "bash", { command: "npm test", timeout: 10 }, "k3");
  assert.equal(ctx.aborted, true);
});
