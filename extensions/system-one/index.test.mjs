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
  const calls = { count: 0, requests: [], noulCount: 0, noulRequests: [] };
  return {
    calls,
    client: {
      async decide(request) {
        calls.count++;
        calls.requests.push(request);
        return result;
      },
      async assessNoul(request) {
        calls.noulCount++;
        calls.noulRequests.push(request);
        return noulResult;
      },
    },
  };
}

function createHarness(service, promptCommands = []) {
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
    getCommands() {
      return promptCommands;
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

test("keeps only the newest workflow hint in context", async () => {
  const { client } = fakeClient({ choice: "fix", confidence: 0.9 });
  const harness = createHarness(createWorkflowService({ getClient: () => client }));

  const oldHint = { role: "custom", customType: HINT_CUSTOM_TYPE, content: "old" };
  const user = { role: "user", content: "hi" };
  const newHint = { role: "custom", customType: HINT_CUSTOM_TYPE, content: "new" };
  const result = await harness.emit("context", {
    messages: [oldHint, user, newHint],
  });

  assert.deepEqual(result.messages, [user, newHint]);
});

test("resolves the prompt path from Pi's command registry", async () => {
  const { client } = fakeClient({ choice: "fix", confidence: 0.9 });
  const harness = createHarness(createWorkflowService({ getClient: () => client }), [
    {
      name: "debugging",
      source: "prompt",
      sourceInfo: { path: "/pkg/prompts/debugging.md" },
    },
  ]);

  const result = await harness.emit("before_agent_start", { prompt: "fix the bug" });
  assert.match(result.message.content, /\/pkg\/prompts\/debugging\.md/);
  assert.doesNotMatch(result.message.content, /Read prompts\/debugging\.md/);
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
    getStatus: () => ({ configured: true, provider: "typesafe", model: "jev" }),
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
      provider: "typesafe",
      model: "jev",
    }),
  });
  const harness = createHarness(service);

  await harness.command("system-one", "");
  const status = harness.notices.at(-1);
  assert.match(status, /decisions: on/);
  assert.match(status, /Configured: yes/);
  assert.match(status, /Provider: typesafe/);
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
  assert.ok(events.has("agent_before_settle"));
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
  assert.deepEqual(result.details, { enabled: true, selected: 2, total: 3 });
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
  assert.deepEqual(fallback.details, { enabled: false, selected: 0, total: 1 });

  const { client, calls } = fakeClient({ choice: "low", confidence: 0.9 }, { probabilities: {} });
  const tool = createToolHarness(createWorkflowService({ getClient: () => client }));
  const empty = await tool.execute(
    "call-2",
    { task: "t", candidates: ["  ", ""] },
    undefined,
  );
  assert.match(empty.content[0].text, /No candidate paths/);
  assert.deepEqual(empty.details, { enabled: true, selected: 0, total: 0 });
  assert.equal(calls.noulCount, 0);
});

test("context_select distinguishes disabled from unavailable", async () => {
  const { client, calls } = fakeClient(
    { choice: "low", confidence: 0.9 },
    { probabilities: { candidate_0: 0.9 } },
  );
  const disabled = createToolHarness(
    createWorkflowService({ getClient: () => client, enabled: false }),
  );
  const result = await disabled.execute(
    "call-1",
    { task: "t", candidates: ["a.ts"] },
    undefined,
  );
  assert.match(result.content[0].text, /disabled/);
  assert.deepEqual(result.details, { enabled: false, selected: 0, total: 1 });
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

test("batches parallel edits into one risk assessment", async () => {
  const { client, calls } = fakeClient({ choice: "high", confidence: 0.9 });
  const harness = createRiskHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", {
    toolName: "write",
    input: { path: "a.ts", content: "x" },
  });
  await harness.emit("tool_call", {
    toolName: "edit",
    input: { path: "b.ts", edits: [{ oldText: "a", newText: "b" }] },
  });
  const result = await harness.emit("context", { messages: [] });

  assert.equal(calls.count, 1);
  assert.match(calls.requests[0].state, /path: a\.ts/);
  assert.match(calls.requests[0].state, /path: b\.ts/);
  assert.match(result.messages.at(-1).content, /high risk/);
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
  const pi = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
  };
  registerCompletionCheck(pi, () => service);
  const ctx = { signal: undefined };
  return {
    emit(name, event = {}) {
      const list = handlers.get(name) ?? [];
      return Promise.all(list.map((handler) => handler(event, ctx)));
    },
  };
}

const FINISHED_BOUNDARY = {
  entries: [],
  continue: false,
  outcome: "completed",
  context: {
    canContinue: true,
    llmMessages: [
      { role: "user", content: "add a login route" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  },
};

test("starts one verification pass when the turn looks incomplete", async () => {
  const { client } = fakeClient({ choice: "incomplete", confidence: 0.9 });
  const harness = createCompletionHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", { toolName: "edit", input: { path: "a.ts" } });
  const results = await harness.emit("agent_before_settle", FINISHED_BOUNDARY);

  assert.equal(results.length, 1);
  const boundary = results[0];
  assert.equal(boundary.continue, true);
  assert.equal(boundary.entries.at(-1).customType, SELF_CHECK_CUSTOM_TYPE);
  assert.equal(boundary.entries.at(-1).display, false);
  assert.match(boundary.entries.at(-1).content, /does not look fully addressed/);
});

test("a verified turn stays silent", async () => {
  const { client } = fakeClient({ choice: "verified", confidence: 0.9 });
  const harness = createCompletionHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", { toolName: "write", input: { path: "a.ts" } });
  const results = await harness.emit("agent_before_settle", FINISHED_BOUNDARY);
  assert.equal(results[0], undefined);
});

test("an uncertain completion escalates (fail-safe)", async () => {
  const { client } = fakeClient({ choice: "verified", confidence: 0.1 });
  const harness = createCompletionHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", { toolName: "write", input: { path: "a.ts" } });
  const results = await harness.emit("agent_before_settle", FINISHED_BOUNDARY);
  assert.match(results[0].entries.at(-1).content, /could not be confirmed/);
});

test("does not assess turns that changed no files", async () => {
  const { client, calls } = fakeClient({ choice: "incomplete", confidence: 0.9 });
  const harness = createCompletionHarness(createWorkflowService({ getClient: () => client }));

  const results = await harness.emit("agent_before_settle", FINISHED_BOUNDARY);
  assert.equal(calls.count, 0);
  assert.equal(results[0], undefined);
});

test("does not continue when Pi says it cannot", async () => {
  const { client, calls } = fakeClient({ choice: "incomplete", confidence: 0.9 });
  const harness = createCompletionHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", { toolName: "write", input: { path: "a.ts" } });
  const results = await harness.emit("agent_before_settle", {
    ...FINISHED_BOUNDARY,
    context: { ...FINISHED_BOUNDARY.context, canContinue: false },
  });
  assert.equal(calls.count, 0);
  assert.equal(results[0], undefined);
});

test("self-check runs at most once per user turn", async () => {
  const { client } = fakeClient({ choice: "incomplete", confidence: 0.9 });
  const harness = createCompletionHarness(createWorkflowService({ getClient: () => client }));

  await harness.emit("tool_call", { toolName: "write", input: { path: "a.ts" } });
  const first = await harness.emit("agent_before_settle", FINISHED_BOUNDARY);
  const second = await harness.emit("agent_before_settle", FINISHED_BOUNDARY);
  assert.equal(first[0].continue, true);
  assert.equal(second[0], undefined);

  // A new user prompt resets the budget; the self-check continuation does not.
  await harness.emit("before_agent_start", { messageType: "custom" });
  await harness.emit("agent_before_settle", FINISHED_BOUNDARY);
  assert.equal((await harness.emit("agent_before_settle", FINISHED_BOUNDARY))[0], undefined);

  await harness.emit("before_agent_start", { messageType: "user", prompt: "next task" });
  await harness.emit("tool_call", { toolName: "write", input: { path: "b.ts" } });
  const next = await harness.emit("agent_before_settle", FINISHED_BOUNDARY);
  assert.equal(next[0].continue, true);
});

test("completion self-check is inert when System One is disabled", async () => {
  const { client, calls } = fakeClient({ choice: "incomplete", confidence: 0.9 });
  const harness = createCompletionHarness(
    createWorkflowService({ getClient: () => client, enabled: false }),
  );

  await harness.emit("tool_call", { toolName: "write", input: { path: "a.ts" } });
  const results = await harness.emit("agent_before_settle", FINISHED_BOUNDARY);
  assert.equal(calls.count, 0);
  assert.equal(results[0], undefined);
});
