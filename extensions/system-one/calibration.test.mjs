import assert from "node:assert/strict";
import test from "node:test";
import {
  CALIBRATION_CASES,
  QUESTIONS,
  confidenceBuckets,
  describeCase,
  evaluateCases,
  recommendThreshold,
  summarize,
} from "./calibration.ts";

test("fixtures use valid decisions and labels", () => {
  assert.ok(CALIBRATION_CASES.length > 0);
  for (const testCase of CALIBRATION_CASES) {
    const question = QUESTIONS[testCase.decision];
    assert.ok(question, `unknown decision ${testCase.decision}`);
    assert.ok(
      Object.keys(question.criteria).includes(testCase.expected),
      `expected ${testCase.expected} is not a label of ${testCase.decision}`,
    );
  }
});

test("summarizes accuracy", () => {
  assert.deepEqual(
    summarize([
      { decision: "intent", expected: "fix", choice: "fix", confidence: 0.9, correct: true },
      { decision: "intent", expected: "fix", choice: "review", confidence: 0.7, correct: false },
    ]),
    { total: 2, correct: 1, accuracy: 0.5 },
  );
  assert.deepEqual(summarize([]), { total: 0, correct: 0, accuracy: 0 });
});

test("buckets accuracy by confidence", () => {
  const buckets = confidenceBuckets([
    { decision: "intent", expected: "fix", choice: "fix", confidence: 0.95, correct: true },
    { decision: "intent", expected: "fix", choice: "review", confidence: 0.7, correct: false },
    { decision: "intent", expected: "fix", choice: "fix", confidence: 0.55, correct: true },
  ]);
  assert.deepEqual(
    buckets.map((bucket) => [bucket.total, bucket.correct, bucket.accuracy]),
    [
      [1, 1, 1],
      [1, 0, 0],
      [1, 1, 1],
    ],
  );
});

test("recommends the lowest threshold meeting target accuracy", () => {
  const outcomes = [
    { decision: "intent", expected: "fix", choice: "fix", confidence: 0.95, correct: true },
    { decision: "intent", expected: "fix", choice: "review", confidence: 0.7, correct: false },
    { decision: "intent", expected: "fix", choice: "fix", confidence: 0.55, correct: true },
  ];
  assert.deepEqual(recommendThreshold(outcomes), {
    threshold: 0.8,
    actedOn: 1,
    correct: 1,
    accuracy: 1,
  });
  assert.equal(recommendThreshold([], 0.9), undefined);
});

test("describes cases for readable reports", () => {
  const risk = CALIBRATION_CASES.find(
    (testCase) => testCase.decision === "risk" && testCase.state.includes("src/auth/session.ts"),
  );
  assert.equal(describeCase(risk), "src/auth/session.ts");

  const completion = CALIBRATION_CASES.find(
    (testCase) => testCase.decision === "completion" && testCase.expected === "incomplete",
  );
  assert.match(describeCase(completion), /add login and logout/);

  const intent = CALIBRATION_CASES.find((testCase) => testCase.decision === "intent");
  assert.equal(describeCase(intent), intent.state);
});

test("evaluates cases through a client", async () => {
  const byState = new Map(CALIBRATION_CASES.map((testCase) => [testCase.state, testCase]));
  const client = {
    async decide({ question, state }) {
      const testCase = byState.get(state);
      assert.equal(question.id, QUESTIONS[testCase.decision].id);
      return { choice: testCase.expected, confidence: 0.9 };
    },
  };

  const outcomes = await evaluateCases(client, CALIBRATION_CASES);
  assert.equal(outcomes.length, CALIBRATION_CASES.length);
  assert.equal(summarize(outcomes).accuracy, 1);
  assert.ok(outcomes.every((outcome) => typeof outcome.label === "string" && outcome.label.length > 0));
});
