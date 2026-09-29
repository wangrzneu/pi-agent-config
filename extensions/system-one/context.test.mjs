import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContextQuestions,
  contextQuestionId,
  DEFAULT_CONTEXT_SELECTION,
  DEFAULT_CONTEXT_THRESHOLD,
  formatContextResult,
  selectRelevant,
} from "./context.ts";

const CANDIDATES = [
  { id: "a.ts" },
  { id: "b.ts", description: "billing" },
  { id: "c.ts" },
];

test("builds one noul question per candidate, ids by position", () => {
  const questions = buildContextQuestions(CANDIDATES);
  assert.equal(questions.length, 3);
  assert.deepEqual(
    questions.map((question) => question.id),
    ["candidate_0", "candidate_1", "candidate_2"],
  );
  assert.equal(contextQuestionId(2), "candidate_2");
  assert.match(questions[1].instructions, /b\.ts — billing/);
  assert.match(questions[0].criteria.true, /likely to be needed/);
});

test("selects above threshold, ranked by score then id", () => {
  const selection = selectRelevant(CANDIDATES, {
    candidate_0: 0.2,
    candidate_1: 0.9,
    candidate_2: 0.6,
  });
  assert.deepEqual(selection.selected, ["b.ts", "c.ts"]);
  assert.deepEqual(selection.scores, { "a.ts": 0.2, "b.ts": 0.9, "c.ts": 0.6 });
});

test("honours custom threshold and cap, breaking ties by id", () => {
  const candidates = [{ id: "z.ts" }, { id: "a.ts" }, { id: "m.ts" }];
  const probabilities = { candidate_0: 0.7, candidate_1: 0.7, candidate_2: 0.7 };

  assert.deepEqual(
    selectRelevant(candidates, probabilities, { threshold: 0.5, maxSelected: 2 }).selected,
    ["a.ts", "m.ts"],
  );
  assert.deepEqual(
    selectRelevant(candidates, probabilities, { threshold: 0.8 }).selected,
    [],
  );
  assert.equal(DEFAULT_CONTEXT_THRESHOLD, 0.5);
  assert.equal(DEFAULT_CONTEXT_SELECTION, 25);
});

test("treats unanswerable candidates as score 0", () => {
  const selection = selectRelevant(CANDIDATES, { candidate_1: 0.95 });
  assert.deepEqual(selection.selected, ["b.ts"]);
  assert.equal(selection.scores["a.ts"], 0);
});

test("formats results and the empty case", () => {
  assert.match(
    formatContextResult(selectRelevant(CANDIDATES, { candidate_1: 0.9 })),
    /b\.ts \(0\.90\)/,
  );
  assert.match(
    formatContextResult({ selected: [], scores: {} }),
    /No candidate looked relevant/,
  );
});
