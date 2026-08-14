import assert from "node:assert/strict";
import test from "node:test";
import workflowExtension, { WORKFLOW_CUSTOM_TYPE } from "./index.ts";

function createHarness(existingEntries = [], { confirm = true, hasUI = true } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [...existingEntries];
  const messages = [];
  const statuses = [];
  const notifications = [];

  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, definition) { commands.set(name, definition.handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message, options) {
      messages.push({ message, options });
      return Promise.resolve();
    },
  };
  const ctx = {
    hasUI,
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
    },
    ui: {
      setStatus: (_id, text) => statuses.push(text),
      notify: (message, level) => notifications.push({ message, level }),
      confirm: async () => confirm,
    },
  };

  workflowExtension(pi);
  return {
    handlers,
    commands,
    tools,
    entries,
    messages,
    statuses,
    notifications,
    ctx,
    async start(reason = "startup") {
      await handlers.get("session_start")({ reason }, ctx);
    },
    async beforeAgent(prompt = "Implement the feature") {
      return handlers.get("before_agent_start")({ prompt }, ctx);
    },
  };
}

const steps = [
  {
    id: "implement",
    title: "Implement feature",
    instruction: "Change the source code",
    requiredCapabilities: ["write"],
    verification: "Focused tests pass",
  },
];

test("automatically injects workflow detection instructions for a new task", async () => {
  const harness = createHarness();
  const injected = await harness.beforeAgent();
  assert.match(injected.message.content, /automatically decide/);
  assert.match(injected.message.content, /workflow with action=create/);
});

test("creates and persists a temporary workflow, then injects its next step", async () => {
  const harness = createHarness();
  await harness.start();
  const tool = harness.tools.get("workflow");

  const created = await tool.execute("call-1", {
    action: "create",
    goal: "Implement feature",
    steps,
  }, undefined, undefined, harness.ctx);

  assert.match(created.content[0].text, /approved/);
  assert.equal(harness.entries.at(-1).customType, WORKFLOW_CUSTOM_TYPE);
  const injected = await harness.beforeAgent();
  assert.match(injected.message.content, /Next step: implement/);
  assert.match(injected.message.content, /Do not create another workflow/);
});

test("restores an awaiting workflow on restart without executing it", async () => {
  const first = createHarness([], { hasUI: false });
  await first.start();
  await first.tools.get("workflow").execute("call-1", {
    action: "create",
    goal: "Resume me",
    steps,
  }, undefined, undefined, first.ctx);

  const second = createHarness(first.entries, { hasUI: false });
  await second.start("resume");
  assert.equal(second.messages.length, 0);
  assert.match((await second.beforeAgent()).message.content, /awaiting approval/);
});

test("resumes an approved workflow after restart", async () => {
  const first = createHarness([], { hasUI: false });
  await first.start();
  await first.tools.get("workflow").execute("create", {
    action: "create",
    goal: "Approved resume",
    steps,
  }, undefined, undefined, first.ctx);
  await first.commands.get("workflow")("approve", first.ctx);

  const second = createHarness(first.entries, { hasUI: false });
  await second.start("resume");
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].options.triggerTurn, true);
  assert.match((await second.beforeAgent()).message.content, /Next step: implement/);
});

test("pauses after the finite retry budget is exhausted", async () => {
  const harness = createHarness([], { hasUI: false });
  await harness.start();
  const tool = harness.tools.get("workflow");
  await tool.execute("create", { action: "create", goal: "Retry", steps, maxRetriesPerStep: 1 }, undefined, undefined, harness.ctx);
  await harness.commands.get("workflow")("approve", harness.ctx);
  await tool.execute("start", { action: "start", stepId: "implement" }, undefined, undefined, harness.ctx);
  await tool.execute("fail-1", { action: "fail", stepId: "implement", error: "first" }, undefined, undefined, harness.ctx);
  await tool.execute("start-2", { action: "start", stepId: "implement" }, undefined, undefined, harness.ctx);
  const exhausted = await tool.execute("fail-2", { action: "fail", stepId: "implement", error: "second" }, undefined, undefined, harness.ctx);

  assert.match(exhausted.content[0].text, /paused/);
  assert.match((await harness.beforeAgent()).message.content, /paused/);
});

test("keeps the workflow awaiting approval when the preview is rejected", async () => {
  const harness = createHarness([], { confirm: false });
  await harness.start();
  const result = await harness.tools.get("workflow").execute("create", {
    action: "create",
    goal: "Needs approval",
    steps,
  }, undefined, undefined, harness.ctx);

  assert.match(result.content[0].text, /approval/);
  assert.match((await harness.beforeAgent()).message.content, /awaiting approval/);
});
