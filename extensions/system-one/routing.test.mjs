import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ROUTING_THRESHOLD,
  isWorkflowIntent,
  renderWorkflowHint,
  resolveWorkflowRoute,
  WORKFLOW_INTENTS,
  WORKFLOW_SCHEMA,
} from "./routing.ts";

test("workflow intents mirror the work-status taxonomy", () => {
  assert.deepEqual([...WORKFLOW_INTENTS], [
    "design",
    "plan",
    "implement",
    "test",
    "review",
    "fix",
    "explore",
  ]);
  assert.equal(WORKFLOW_SCHEMA, "pi.workflow_intent.v1");
});

test("resolves routes for known intents at or above the threshold", () => {
  assert.deepEqual(resolveWorkflowRoute("fix", 0.9), {
    intent: "fix",
    prompt: "debugging",
    suggestsPlan: false,
  });
  assert.deepEqual(resolveWorkflowRoute("review", 0.7), {
    intent: "review",
    prompt: "review-first",
    suggestsPlan: false,
  });
  assert.deepEqual(resolveWorkflowRoute("design", 1), {
    intent: "design",
    prompt: "architecture",
    suggestsPlan: true,
  });
  assert.deepEqual(resolveWorkflowRoute("plan", 0.6), {
    intent: "plan",
    suggestsPlan: true,
  });
});

test("fails open on unknown intent, low or non-finite confidence", () => {
  assert.equal(resolveWorkflowRoute("refactor", 0.99), undefined);
  assert.equal(
    resolveWorkflowRoute("fix", DEFAULT_ROUTING_THRESHOLD - 0.01),
    undefined,
  );
  assert.equal(resolveWorkflowRoute("fix", Number.NaN), undefined);
  assert.equal(resolveWorkflowRoute("fix", 0.9, 0.95), undefined);
});

test("renders a hidden hint naming the prompt and planning preference", () => {
  const fixHint = renderWorkflowHint(resolveWorkflowRoute("fix", 1));
  assert.match(fixHint, /^\[WORKFLOW\] Detected intent: fix\./);
  assert.match(fixHint, /prompts\/debugging\.md/);
  assert.doesNotMatch(fixHint, /read-only inspection/);

  const designHint = renderWorkflowHint(resolveWorkflowRoute("design", 1));
  assert.match(designHint, /read-only inspection/);
  assert.match(designHint, /prompts\/architecture\.md/);
});

test("recognizes only exact known intents", () => {
  assert.equal(isWorkflowIntent("test"), true);
  assert.equal(isWorkflowIntent("Test"), false);
  assert.equal(isWorkflowIntent(42), false);
  assert.equal(isWorkflowIntent(undefined), false);
});
