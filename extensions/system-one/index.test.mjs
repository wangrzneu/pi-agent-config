import assert from "node:assert/strict";
import test from "node:test";
import {
  HINT_CUSTOM_TYPE,
  registerChangeRisk,
  registerCompletionCheck,
  registerContextTool,
  registerWorkflowRouting,
  RISK_CUSTOM_TYPE,
  SELF_CHECK_CUSTOM_TYPE,
  toWorkflowHint,
} from "./index.ts";
import { createWorkflowService } from "./service.ts";

function fakeClient(result, noulResult) {
  const calls = { count: 0, noulCount: 0 };
  return {
    calls,
    client: {
      async decide() {
        calls.count++;
        return result;
      },
      async assessNoul() {
        calls.noulCount++;
        return noulResult;
      },
    },
  };
}

function createHarness(service) {
  const handlers = new Map();
  const commands = new Map();
  const notices = [];

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };
  registerWorkflowRouting(pi, () => service);
  const ctx = {
    signal: undefined,
    ui: {
      notify(message) {
        notices.push(message);
      },
    },
  };

  return {
    notices,
    emit(name, event = {}) {
      const handler = handlers.get(name);
      return handler ? handler(event, ctx) : undefined;
    },
    command(name, args = "") {
      return commands.get(name).handler(args, ctx);
    },
    hasCommand(name) {
      return commands.has(name);
    },
  };
}

test("builds a hint from a decision and stays silent on unknowns", () => {
  assert.match(
    toWorkflowHint({ choice: "fix", confidence: 0.9 }, 0.6),
    /Detected intent: fix/,
  );
  assert.equal(toWorkflowHint({ choice: "fix", confidence: 0.1 }, 0.6), undefined);
  assert.equal(toWorkflowHint({ choice: "refactor", confidence: 1 }, 0.6), undefined);
  assert.equal(toWorkflowHint(undefined, 0.6), undefined);
});

test("before_agent_start injects a hidden message", async () => {
  const { client } = fakeClient({ choice: "design", confidence: 0.9 });
  const service = createWorkflowService({ getClient: () => client });
  const harness = createHarness(service);

  const result = await harness.emit("before_agent_start", { prompt: "设计新接口" });
  assert.equal(result.message.customType, HINT_CUSTOM_TYPE);
  assert.equal(result.message.display, false);
  assert.match(result.message.content, /Detected intent: design/);
});

test("before_agent_start does nothing without a prompt or configuration", async () => {
  const { client } = fakeClient({ choice: "fix", confidence: 0.9 });
  const enabled = createHarness(createWorkflowService({ getClient: () => client }));
  assert.equal(await enabled.emit("before_agent_start", { prompt: "   " }), undefined);

  const unconfigured = createHarness(createWorkflowService({ getClient: () => undefined }));
  assert.equal(await unconfigured.emit("before_agent_start", { prompt: "fix it" }), undefined);
});

test("/system-one off disables routing and on re-enables it", async () => {
  const { client, calls } = fakeClient({ choice: "fix", confidence: 0.9 });
  const service = createWorkflowService({
    getClient: () => client,
    getStatus: () => ({ configured: true, endpoint: "https://example.test", model: "jev" }),
  });
  const harness = createHarness(service);

  assert.equal(service.isEnabled(), true);
  await harness.command("system-one", "off");
  assert.equal(service.isEnabled(), false);
  assert.equal(await harness.emit("before_agent_start", { prompt: "task" }), undefined);
  assert.equal(calls.count, 0);

  await harness.command("system-one", "on");
  assert.equal(service.isEnabled(), true);
  assert.ok(await harness.emit("before_agent_start", { prompt: "task" }));
  assert.equal(calls.count, 1);
});

test("/system-one status reports configuration without leaking secrets", async () => {
  const service = createWorkflowService({
    getClient: () => undefined,
    getStatus: () => ({
      configured: true,
      endpoint: "https://example.test/decide",
      model: "jev",
    }),
  });
  const harness = createHarness(service);

  await harness.command("system-one", "");
  const status = harness.notices.at(-1);
  assert.match(status, /routing: on/);
  assert.match(status, /Configured: yes/);
  assert.match(status, /Endpoint: https:\/\/example\.test\/decide/);
  assert.match(status, /Model: jev/);
});

test("default export wires session_start and the system-one command", async () => {
  const { default: systemOne } = await import("./index.ts");
  const events = new Set();
  const commands = new Set();
  systemOne({
    on(name) {
      events.add(name);
    },
    registerCommand(name) {
      commands.add(name);
    },
    registerTool() {},
  });

  assert.ok(events.has("session_start"));
  assert.ok(events.has("before_agent_start"));
  assert.ok(events.has("tool_call"));
  assert.ok(events.has("context"));
  assert.ok(events.has("agent_end"));
  assert.ok(commands.has("system-one"));
});

// --- context selection -----------------------------------------------------

function createToolHarness(service) {
  let tool;
  registerContextTool({ registerTool(definition) { tool = definition; } }, () => service);
  return tool;
}

test("context_select ranks candidates and selects above threshold", async () => {
  const { client } = fakeClient(
    { choice: "low", confidence: 0.9 },
    { probabilities: { candidate_0: 0.95, candidate_1: 0.2, candidate_2: 0.8 } },
  );
  const tool = createToolHarness(createWorkflowService({ getClient: () => client }));
  assert.equal(tool.name, "context_select");

  const result = await tool.execute(
    "call-1",
    { task: "add login", candidates: ["a.ts", "b.ts", "c.ts"] },
    undefined,
  );
  assert.match(result.content[0].text, /a\.ts \(0\.95\)/);
  assert.match(result.content[0].text, /c\.ts \(0\.80\)/);
  assert.doesNotMatch(result.content[0].text, /b\.ts/);
  assert.deepEqual(result.details, { selected: 2, total: 3 });
});

test("context_select fails open when unavailable and rejects empty input", async () => {
  const unavailable = createToolHarness(
    createWorkflowService({ getClient: () => undefined }),
  );
  const fallback = await unavailable.execute(
    "call-1",
    { task: "t", candidates: ["a.ts"] },
    undefined,
  );
  assert.match(fallback.content[0].text, /unavailable/);
  assert.equal(fallback.details.enabled, false);

  const { client, calls } = fakeClient({ choice: "low", confidence: 0.9 }, { probabilities: {} });
  const tool = createToolHarness(createWorkflowService({ getClient: () => client }));
  const empty = await tool.execute(
    "call-2",
    { task: "t", candidates: ["  ", ""] },
    undefined,
  );
  assert.match(empty.content[0].text, /No candidate paths/);
  assert.equal(calls.noulCount, 0);
});

// --- change-risk triage ----------------------------------------------------

function createRiskHarness(service) {
  const handlers = new Map();
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  registerChangeRisk(pi, () => service);
  const ctx = { signal: undefined };
  return {
    emit(name, event = {}) {
      const handler = handlers.get(name);
      return handler ? handler(event, ctx) : undefined;
    },
  };
}

test("injects a hidden review hint for a risky edit", async () => {
  const { client } = fakeClient({ choice: "high", confidence: 0.9 });
  const harness = createRiskHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", {
    toolName: "edit",
    input: { path: "src/auth.ts", edits: [{ oldText: "a", newText: "b" }] },
  });
  const result = await harness.emit("context", {
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages.at(-1).customType, RISK_CUSTOM_TYPE);
  assert.equal(result.messages.at(-1).display, false);
  assert.match(result.messages.at(-1).content, /high risk/);
});

test("stays silent for low risk and for non-edit tools", async () => {
  const { client } = fakeClient({ choice: "low", confidence: 0.9 });
  const harness = createRiskHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", {
    toolName: "edit",
    input: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
  });
  assert.equal(await harness.emit("context", { messages: [] }), undefined);

  await harness.emit("tool_call", { toolName: "read", input: { path: "a.ts" } });
  assert.equal(await harness.emit("context", { messages: [] }), undefined);
});

test("escalates an uncertain assessment and assesses each change once", async () => {
  const { client, calls } = fakeClient({ choice: "low", confidence: 0.1 });
  const harness = createRiskHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", {
    toolName: "write",
    input: { path: "a.ts", content: "x" },
  });
  const first = await harness.emit("context", { messages: [] });
  assert.match(first.messages.at(-1).content, /could not be assessed/);

  // Pending change cleared: a second context with no new tool call is silent.
  assert.equal(await harness.emit("context", { messages: [] }), undefined);
  assert.equal(calls.count, 1);
});

test("change risk is inert when System One is disabled", async () => {
  const { client, calls } = fakeClient({ choice: "high", confidence: 0.9 });
  const harness = createRiskHarness(
    createWorkflowService({ getClient: () => client, enabled: false }),
  );

  await harness.emit("tool_call", {
    toolName: "write",
    input: { path: "a.ts", content: "x" },
  });
  assert.equal(await harness.emit("context", { messages: [] }), undefined);
  assert.equal(calls.count, 0);
});

// --- completion self-check --------------------------------------------------

function createCompletionHarness(service) {
  const handlers = new Map();
  const sent = [];
  const pi = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    async sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
  registerCompletionCheck(pi, () => service, { schedule: (task) => task() });
  const ctx = { signal: undefined };
  return {
    sent,
    emit(name, event = {}) {
      const list = handlers.get(name) ?? [];
      return Promise.all(list.map((handler) => handler(event, ctx)));
    },
  };
}

const FINISHED_TURN = {
  messages: [
    { role: "user", content: "add a login route" },
    { role: "assistant", content: "done" },
  ],
};

test("starts one verification pass when the turn looks incomplete", async () => {
  const { client } = fakeClient({ choice: "incomplete", confidence: 0.9 });
  const harness = createCompletionHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", { toolName: "edit", input: { path: "a.ts" } });
  await harness.emit("agent_end", FINISHED_TURN);

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].message.customType, SELF_CHECK_CUSTOM_TYPE);
  assert.equal(harness.sent[0].message.display, false);
  assert.deepEqual(harness.sent[0].options, { triggerTurn: true });
  assert.match(harness.sent[0].message.content, /does not look fully addressed/);
});

test("a verified turn stays silent", async () => {
  const { client } = fakeClient({ choice: "verified", confidence: 0.9 });
  const harness = createCompletionHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", { toolName: "write", input: { path: "a.ts" } });
  await harness.emit("agent_end", FINISHED_TURN);

  assert.equal(harness.sent.length, 0);
});

test("an uncertain completion escalates (fail-safe)", async () => {
  const { client } = fakeClient({ choice: "verified", confidence: 0.1 });
  const harness = createCompletionHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", { toolName: "write", input: { path: "a.ts" } });
  await harness.emit("agent_end", FINISHED_TURN);

  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].message.content, /could not be confirmed/);
});

test("does not assess turns that changed no files", async () => {
  const { client, calls } = fakeClient({ choice: "incomplete", confidence: 0.9 });
  const harness = createCompletionHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("agent_end", FINISHED_TURN);
  assert.equal(calls.count, 0);
  assert.equal(harness.sent.length, 0);
});

test("self-check runs at most once per user turn", async () => {
  const { client } = fakeClient({ choice: "incomplete", confidence: 0.9 });
  const harness = createCompletionHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", { toolName: "write", input: { path: "a.ts" } });
  await harness.emit("agent_end", FINISHED_TURN);
  await harness.emit("agent_end", FINISHED_TURN);
  assert.equal(harness.sent.length, 1);

  // A new user prompt resets the budget.
  await harness.emit("before_agent_start", { prompt: "next task" });
  await harness.emit("tool_call", { toolName: "write", input: { path: "b.ts" } });
  await harness.emit("agent_end", FINISHED_TURN);
  assert.equal(harness.sent.length, 2);
});

test("completion self-check is inert when System One is disabled", async () => {
  const { client, calls } = fakeClient({ choice: "incomplete", confidence: 0.9 });
  const harness = createCompletionHarness(
    createWorkflowService({ getClient: () => client, enabled: false }),
  );

  await harness.emit("tool_call", { toolName: "write", input: { path: "a.ts" } });
  await harness.emit("agent_end", FINISHED_TURN);
  assert.equal(calls.count, 0);
  assert.equal(harness.sent.length, 0);
});
