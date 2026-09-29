import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowService } from "./service.ts";
import { DEFAULT_ROUTING_THRESHOLD, MAX_STATE_CHARACTERS, WORKFLOW_SCHEMA } from "./routing.ts";
import { DEFAULT_CONTEXT_THRESHOLD } from "./context.ts";
import { RISK_SCHEMA } from "./risk.ts";
import { COMPLETION_SCHEMA } from "./completion.ts";

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

test("decides the workflow intent with a bounded, versioned question", async () => {
  const { client, calls } = fakeClient({ choice: "test", confidence: 0.8 });
  const service = createWorkflowService({ getClient: () => client });

  const decision = await service.decideIntent("run the suite");
  assert.deepEqual(decision, { choice: "test", confidence: 0.8 });
  assert.equal(calls.count, 1);
  assert.equal(calls.requests[0].question.id, WORKFLOW_SCHEMA);
  assert.equal(calls.requests[0].question.criteria.test, "Writing or running tests, or validating behavior.");
  assert.equal(calls.requests[0].maxStateCharacters, MAX_STATE_CHARACTERS);
  assert.equal(calls.requests[0].state, "run the suite");
});

test("caches a decision per prompt so consumers share one request", async () => {
  const { client, calls } = fakeClient({ choice: "fix", confidence: 0.9 });
  const service = createWorkflowService({ getClient: () => client });

  const first = await service.decideIntent("same prompt");
  const second = await service.decideIntent("same prompt");
  assert.deepEqual(first, second);
  assert.equal(calls.count, 1);

  await service.decideIntent("different prompt");
  assert.equal(calls.count, 2);
});

test("fails open when disabled or unconfigured", async () => {
  const { client, calls } = fakeClient({ choice: "fix", confidence: 0.9 });

  const disabled = createWorkflowService({ getClient: () => client, enabled: false });
  assert.equal(await disabled.decideIntent("task"), undefined);
  assert.equal(disabled.isEnabled(), false);
  assert.equal(calls.count, 0);
  disabled.setEnabled(true);
  assert.deepEqual(await disabled.decideIntent("task"), { choice: "fix", confidence: 0.9 });
  assert.equal(calls.count, 1);

  const unconfigured = createWorkflowService({ getClient: () => undefined });
  assert.equal(await unconfigured.decideIntent("task"), undefined);

  const emptyPrompt = createWorkflowService({ getClient: () => client });
  assert.equal(await emptyPrompt.decideIntent("   "), undefined);
});

test("does not cache a failed decision so a later call can retry", async () => {
  let attempt = 0;
  const client = {
    async decide() {
      attempt++;
      return attempt === 1 ? undefined : { choice: "review", confidence: 0.7 };
    },
  };
  const service = createWorkflowService({ getClient: () => client });

  assert.equal(await service.decideIntent("retry me"), undefined);
  assert.deepEqual(await service.decideIntent("retry me"), {
    choice: "review",
    confidence: 0.7,
  });
  assert.equal(attempt, 2);
});

test("assesses change risk with the risk question", async () => {
  const { client, calls } = fakeClient({ choice: "high", confidence: 0.9 });
  const service = createWorkflowService({ getClient: () => client });

  const risk = await service.assessChangeRisk("@@ edit @@\n- a\n+ b");
  assert.deepEqual(risk, { choice: "high", confidence: 0.9 });
  assert.equal(calls.requests[0].question.id, RISK_SCHEMA);
  assert.deepEqual(Object.keys(calls.requests[0].question.criteria), ["low", "medium", "high"]);
});

test("caches intent and risk separately for the same text", async () => {
  const { client, calls } = fakeClient({ choice: "review", confidence: 0.8 });
  const service = createWorkflowService({ getClient: () => client });

  await service.decideIntent("same text");
  await service.assessChangeRisk("same text");
  assert.equal(calls.count, 2);
});

test("assesses completion with the completion question", async () => {
  const { client, calls } = fakeClient({ choice: "verified", confidence: 0.8 });
  const service = createWorkflowService({ getClient: () => client });

  const result = await service.assessCompletion("request:\nadd login\n\nassistant:\ndone");
  assert.deepEqual(result, { choice: "verified", confidence: 0.8 });
  assert.equal(calls.requests[0].question.id, COMPLETION_SCHEMA);
  assert.deepEqual(Object.keys(calls.requests[0].question.criteria), [
    "verified",
    "unverified",
    "incomplete",
  ]);
});

test("ranks context with one noul request and caches it", async () => {
  const { client, calls } = fakeClient(
    { choice: "low", confidence: 0.9 },
    { probabilities: { candidate_0: 0.9, candidate_1: 0.1 } },
  );
  const service = createWorkflowService({ getClient: () => client });

  const first = await service.rankContext("add login", [{ id: "a.ts" }, { id: "b.ts" }]);
  assert.deepEqual(first, { candidate_0: 0.9, candidate_1: 0.1 });
  assert.equal(calls.noulCount, 1);
  assert.equal(calls.noulRequests[0].questions.length, 2);
  assert.equal(calls.noulRequests[0].questions[0].id, "candidate_0");

  await service.rankContext("add login", [{ id: "a.ts" }, { id: "b.ts" }]);
  assert.equal(calls.noulCount, 1);

  await service.rankContext("add login", [{ id: "a.ts" }, { id: "c.ts" }]);
  assert.equal(calls.noulCount, 2);
});

test("rankContext is inert when disabled, unconfigured, or empty", async () => {
  const { client, calls } = fakeClient(
    { choice: "low", confidence: 0.9 },
    { probabilities: { candidate_0: 1 } },
  );

  const disabled = createWorkflowService({ getClient: () => client, enabled: false });
  assert.equal(await disabled.rankContext("task", [{ id: "a.ts" }]), undefined);

  const unconfigured = createWorkflowService({ getClient: () => undefined });
  assert.equal(await unconfigured.rankContext("task", [{ id: "a.ts" }]), undefined);

  const empty = createWorkflowService({ getClient: () => client });
  assert.equal(await empty.rankContext("task", []), undefined);

  assert.equal(calls.noulCount, 0);
});

test("exposes per-decision thresholds and status with defaults", async () => {
  const service = createWorkflowService({ getClient: () => undefined });
  assert.equal(service.threshold("intent"), DEFAULT_ROUTING_THRESHOLD);
  assert.equal(service.threshold("context"), DEFAULT_CONTEXT_THRESHOLD);
  assert.deepEqual(service.status(), { configured: false });

  const configured = createWorkflowService({
    getClient: () => undefined,
    getThreshold: (decision) => (decision === "risk" ? 0.9 : 0.5),
    getStatus: () => ({ configured: true, endpoint: "https://example.test", model: "jev-latest" }),
  });
  assert.equal(configured.threshold("risk"), 0.9);
  assert.equal(configured.threshold("intent"), 0.5);
  assert.equal(configured.threshold("completion"), 0.5);
  assert.deepEqual(configured.status(), {
    configured: true,
    endpoint: "https://example.test",
    model: "jev-latest",
  });
  assert.equal(configured.isEnabled(), true);
});
