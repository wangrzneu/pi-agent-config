import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkflow,
  failStep,
  getNextStep,
  normalizeWorkflow,
  passStep,
  approveWorkflow,
  recoverWorkflow,
  startStep,
} from "./workflow-state.ts";

test("creates a pending workflow and selects steps only after dependencies pass", () => {
  const workflow = createWorkflow({
    id: "wf-1",
    goal: "Release the service",
    steps: [
      { id: "build", title: "Build", instruction: "Build the service", verification: "Build succeeds" },
      { id: "verify", title: "Verify", instruction: "Verify the result", verification: "The result is healthy", dependsOn: ["build"] },
    ],
  }, "2026-08-05T10:00:00.000Z");

  assert.equal(workflow.status, "pending_approval");
  assert.equal(getNextStep(workflow), undefined);

  const approved = approveWorkflow(workflow);
  assert.equal(approved.status, "active");
  assert.equal(getNextStep(approved)?.id, "build");
  assert.equal(workflow.steps[0].status, "pending");
  assert.equal(workflow.steps[1].status, "pending");

  const running = startStep(approved, "build");
  const passed = passStep(running, "build", "Build succeeded");
  assert.equal(getNextStep(passed)?.id, "verify");
  assert.equal(passed.steps[0].status, "passed");
});

test("rejects invalid dependencies and cycles before execution", () => {
  assert.throws(
    () => normalizeWorkflow({
      goal: "Broken",
      steps: [{ id: "one", title: "One", instruction: "Do one", dependsOn: ["missing"] }],
    }),
    /unknown dependency/,
  );
  assert.throws(
    () => normalizeWorkflow({
      goal: "Cyclic",
      steps: [
        { id: "one", title: "One", instruction: "Do one", dependsOn: ["two"] },
        { id: "two", title: "Two", instruction: "Do two", dependsOn: ["one"] },
      ],
    }),
    /cycle/,
  );
});

test("retries a failed step only within its retry budget", () => {
  const workflow = createWorkflow({
    id: "wf-2",
    goal: "Run tests",
    maxRetriesPerStep: 2,
    steps: [{ id: "tests", title: "Tests", instruction: "Run tests", verification: "Tests pass" }],
  });

  const firstFailure = failStep(startStep(approveWorkflow(workflow), "tests"), "tests", "lint failed");
  assert.equal(firstFailure.status, "active");
  assert.equal(firstFailure.steps[0].status, "pending");
  assert.equal(firstFailure.steps[0].retries, 1);
  assert.equal(getNextStep(firstFailure)?.id, "tests");

  const secondFailure = failStep(startStep(firstFailure, "tests"), "tests", "tests failed");
  assert.equal(secondFailure.steps[0].retries, 2);
  assert.equal(secondFailure.steps[0].status, "pending");

  const exhausted = failStep(startStep(secondFailure, "tests"), "tests", "still failed");
  assert.equal(exhausted.status, "paused");
  assert.equal(exhausted.steps[0].status, "failed");
  assert.equal(getNextStep(exhausted), undefined);
});

test("completes the workflow after every step passes", () => {
  const workflow = createWorkflow({
    id: "wf-3",
    goal: "Finish",
    steps: [{ id: "one", title: "One", instruction: "Do one", verification: "One is done" }],
  });
  const done = passStep(startStep(approveWorkflow(workflow), "one"), "one", "Verified");
  assert.equal(done.status, "completed");
  assert.equal(done.completedAt !== undefined, true);
});

test("recovers an interrupted running step as pending", () => {
  const workflow = createWorkflow({
    id: "wf-4",
    goal: "Recover",
    steps: [{ id: "one", title: "One", instruction: "Do one" }],
  });
  const running = startStep(approveWorkflow(workflow), "one");
  const recovered = recoverWorkflow(running);
  assert.equal(recovered.status, "active");
  assert.equal(recovered.steps[0].status, "pending");
  assert.match(recovered.resumeReason ?? "", /interrupted/);
});
