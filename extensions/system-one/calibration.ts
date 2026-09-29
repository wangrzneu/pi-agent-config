/**
 * Threshold calibration for the three System One decisions.
 *
 * Labels a small fixture set per decision, runs it through a client, and turns
 * the outcomes into two signals that matter for our policies:
 *
 *  - **calibration** — does higher reported confidence actually mean higher
 *    accuracy? (bucketed accuracy), and
 *  - **coverage** — at a given threshold, how many decisions count as
 *    "confident", and how accurate are they?
 *
 * `recommendThreshold` picks the lowest threshold whose confident decisions meet
 * a target accuracy. Everything here is pure except `evaluateCases`.
 *
 * The fixtures are best-guess labels; replace them with your own before trusting
 * the numbers. See `scripts/calibrate-system-one.mjs`.
 */

import { WORKFLOW_QUESTION } from "./routing.ts";
import { RISK_QUESTION } from "./risk.ts";
import { COMPLETION_QUESTION } from "./completion.ts";
import type { ChoiceQuestion, SystemOneClient } from "./types.ts";

export type Decision = "intent" | "risk" | "completion";

export const QUESTIONS: Record<Decision, ChoiceQuestion> = {
  intent: WORKFLOW_QUESTION,
  risk: RISK_QUESTION,
  completion: COMPLETION_QUESTION,
};

export interface CalibrationCase {
  decision: Decision;
  /** The document/state sent to the model. */
  state: string;
  /** The label we believe is correct. */
  expected: string;
}

export interface CaseOutcome {
  decision: Decision;
  /** Short human label for the case (see `describeCase`). */
  label: string;
  expected: string;
  choice?: string;
  confidence?: number;
  correct: boolean;
}

export interface Bucket {
  from: number;
  to: number;
  total: number;
  correct: number;
  accuracy: number;
}

export interface Summary {
  total: number;
  correct: number;
  accuracy: number;
}

export interface ThresholdResult {
  threshold: number;
  actedOn: number;
  correct: number;
  accuracy: number;
}

/**
 * Best-guess labeled fixtures; replace with your own cases for real calibration.
 * 15 per decision, with boundary/ambiguous cases called out.
 */
export const CALIBRATION_CASES: readonly CalibrationCase[] = [
  // --- intent -------------------------------------------------------------
  { decision: "intent", state: "add a login route to the API", expected: "implement" },
  { decision: "intent", state: "why is the parser test failing?", expected: "fix" },
  { decision: "intent", state: "review this PR for correctness and edge cases", expected: "review" },
  { decision: "intent", state: "design the event schema for the new billing API", expected: "design" },
  { decision: "intent", state: "write tests for the tokenizer", expected: "test" },
  { decision: "intent", state: "where is the auth middleware defined?", expected: "explore" },
  { decision: "intent", state: "sequence the work before we touch the migration", expected: "plan" },
  { decision: "intent", state: "refactor the retry helper to remove duplication", expected: "implement" },
  { decision: "intent", state: "the build broke after my last change, make it green", expected: "fix" },
  // Boundary: writing a test after a fix. Dominant intent is the test.
  { decision: "intent", state: "add a regression test for the bug we just fixed", expected: "test" },
  { decision: "intent", state: "sketch the class diagram for the new billing service", expected: "design" },
  { decision: "intent", state: "run the integration suite and report the failures", expected: "test" },
  { decision: "intent", state: "read the auth module and explain how sessions work", expected: "explore" },
  { decision: "intent", state: "plan the migration order for the schema change", expected: "plan" },
  { decision: "intent", state: "does this PR break backwards compatibility?", expected: "review" },

  // --- risk ---------------------------------------------------------------
  {
    decision: "risk",
    state: "tool: edit\npath: src/auth/session.ts\n@@ edit @@\n- token\n+ refreshToken",
    expected: "high",
  },
  {
    decision: "risk",
    state: "tool: edit\npath: README.md\n@@ edit @@\n- teh\n+ the",
    expected: "low",
  },
  {
    decision: "risk",
    state: "tool: edit\npath: src/billing/charge.ts\n@@ edit @@\n- amount\n+ amount * 100",
    expected: "high",
  },
  {
    decision: "risk",
    state: "tool: write\npath: src/parser.test.ts\n@@ content @@\nimport { test } from 'node:test';",
    expected: "low",
  },
  // Known-ambiguous: adding a required parameter to an exported utility is a
  // breaking contract change. Jev answered `low` at 0.51 (its only miss), which
  // is why the risk threshold is 0.6 — the low confidence fail-safes to medium.
  {
    decision: "risk",
    state: "tool: edit\npath: src/util/format.ts\n@@ edit @@\n- export function format(x)\n+ export function format(x, opts)",
    expected: "medium",
  },
  {
    decision: "risk",
    state: "tool: write\npath: migrations/0007_drop_legacy.sql\n@@ content @@\nALTER TABLE users DROP COLUMN legacy;",
    expected: "high",
  },
  {
    decision: "risk",
    state: "tool: edit\npath: src/auth/login.ts\n@@ edit @@\n- if (!user) return\n+ if (!user || !user.active) return",
    expected: "high",
  },
  {
    decision: "risk",
    state: "tool: edit\npath: src/ui/button.tsx\n@@ edit @@\n- color: blue\n+ color: red",
    expected: "low",
  },
  {
    decision: "risk",
    state: "tool: write\npath: src/payments/refund.ts\n@@ content @@\nexport async function refund(chargeId) { /* ... */ }",
    expected: "high",
  },
  {
    decision: "risk",
    state: "tool: edit\npath: src/util/strings.ts\n@@ edit @@\n- return s.trim()\n+ return s.trim().toLowerCase()",
    expected: "medium",
  },
  // Model disagreement: a major framework bump has broad blast radius, so it is
  // labelled `high`; jev-latest answered `medium` at 0.71. Kept as `high`.
  {
    decision: "risk",
    state: 'tool: edit\npath: package.json\n@@ edit @@\n- "react": "^17.0.0"\n+ "react": "^18.0.0"',
    expected: "high",
  },
  {
    decision: "risk",
    state: "tool: edit\npath: src/api/routes.ts\n@@ edit @@\n- app.get('/v1/users', listUsers)\n+ app.get('/v2/users', listUsers)",
    expected: "high",
  },
  {
    decision: "risk",
    state: "tool: edit\npath: src/concurrency/lock.ts\n@@ edit @@\n- lock.acquire()\n+ await lock.acquire()",
    expected: "high",
  },
  {
    decision: "risk",
    state: "tool: edit\npath: docs/usage.md\n@@ edit @@\n- See config.md\n+ See configuration.md",
    expected: "low",
  },
  {
    decision: "risk",
    state: "tool: edit\npath: src/db/users.ts\n@@ edit @@\n- WHERE active = 1\n+ WHERE active = 1 AND deleted_at IS NULL",
    expected: "medium",
  },

  // --- completion ---------------------------------------------------------
  {
    decision: "completion",
    state: "request:\nadd a login route\n\nassistant:\nAdded the route.",
    expected: "unverified",
  },
  {
    decision: "completion",
    state: "request:\nadd a login route\n\nassistant:\nAdded the route. npm test passed.",
    expected: "verified",
  },
  {
    decision: "completion",
    state: "request:\nadd login and logout\n\nassistant:\nAdded login only.",
    expected: "incomplete",
  },
  {
    decision: "completion",
    state: "request:\nfix the failing parser test\n\nassistant:\nFixed it; the test now passes.",
    expected: "verified",
  },
  {
    decision: "completion",
    state: "request:\nfix the failing parser test\n\nassistant:\nFixed it.",
    expected: "unverified",
  },
  // Boundary: one of two requested changes is missing, even though tests pass.
  {
    decision: "completion",
    state: "request:\nadd login and logout\n\nassistant:\nAdded login. Tests pass.",
    expected: "incomplete",
  },
  // Relabelled from `verified`: a grep/search only shows the searched text is
  // gone; it does not show the code still builds or passes tests. The turn is
  // addressed but not verified. (Jev agrees; confidence is low, so it escalates
  // to a verification pass either way — this is a label-accuracy fix.)
  {
    decision: "completion",
    state: "request:\nrename getUser to fetchUser everywhere\n\nassistant:\nRenamed in src/api.ts; grep shows no getUser remains.",
    expected: "unverified",
  },
  {
    decision: "completion",
    state: "request:\nrename getUser to fetchUser everywhere\n\nassistant:\nRenamed it in one file.",
    expected: "incomplete",
  },
  {
    decision: "completion",
    state: "request:\nthe build is broken, fix it\n\nassistant:\nChanged the import; the build now succeeds.",
    expected: "verified",
  },
  {
    decision: "completion",
    state: "request:\nthe build is broken, fix it\n\nassistant:\nReverted the last commit.",
    expected: "unverified",
  },
  {
    decision: "completion",
    state: "request:\nadd rate limiting to the API\n\nassistant:\nAdded a limiter with tests; npm test passed.",
    expected: "verified",
  },
  {
    decision: "completion",
    state: "request:\nadd rate limiting to the API\n\nassistant:\nInvestigated options but made no changes.",
    expected: "incomplete",
  },
  // In-distribution: a changed file with an explicitly reported check result.
  {
    decision: "completion",
    state: "request:\nadd pagination to the list endpoint\n\nassistant:\nAdded cursor pagination; npm test passed.",
    expected: "verified",
  },
  {
    decision: "completion",
    state: "request:\nupgrade React to v18\n\nassistant:\nUpgraded package.json; yarn install and yarn test passed.",
    expected: "verified",
  },
  {
    decision: "completion",
    state: "request:\nupgrade React to v18\n\nassistant:\nUpgraded package.json.",
    expected: "unverified",
  },
];

/** Run every case through the client and record the answer. */
export async function evaluateCases(
  client: SystemOneClient,
  cases: readonly CalibrationCase[] = CALIBRATION_CASES,
  signal?: AbortSignal,
): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];
  for (const testCase of cases) {
    const decision = await client.decide(
      { question: QUESTIONS[testCase.decision], state: testCase.state },
      signal,
    );
    outcomes.push({
      decision: testCase.decision,
      label: describeCase(testCase),
      expected: testCase.expected,
      choice: decision?.choice,
      confidence: decision?.confidence,
      correct: decision?.choice === testCase.expected,
    });
  }
  return outcomes;
}

/** Short, readable identifier for a case, so reports can map misses to fixtures. */
export function describeCase(testCase: CalibrationCase): string {
  const lines = testCase.state.split("\n");
  if (testCase.decision === "risk") {
    const path = lines.find((line) => line.startsWith("path: "));
    if (path) return path.slice("path: ".length);
  }
  if (testCase.decision === "completion") {
    const requestIndex = lines.indexOf("request:");
    if (requestIndex >= 0 && lines[requestIndex + 1]) {
      return lines[requestIndex + 1];
    }
  }
  return lines[0] ?? testCase.decision;
}

export function summarize(outcomes: readonly CaseOutcome[]): Summary {
  const total = outcomes.length;
  const correct = outcomes.filter((outcome) => outcome.correct).length;
  return { total, correct, accuracy: total === 0 ? 0 : correct / total };
}

/** Accuracy within confidence ranges, to check that confidence tracks correctness. */
export function confidenceBuckets(
  outcomes: readonly CaseOutcome[],
  edges: readonly number[] = [0, 0.6, 0.8, 1.0000001],
): Bucket[] {
  const buckets: Bucket[] = [];
  for (let index = 0; index < edges.length - 1; index++) {
    const from = edges[index];
    const to = edges[index + 1];
    const inBucket = outcomes.filter(
      (outcome) =>
        typeof outcome.confidence === "number" &&
        outcome.confidence >= from &&
        outcome.confidence < to,
    );
    const correct = inBucket.filter((outcome) => outcome.correct).length;
    buckets.push({
      from,
      to,
      total: inBucket.length,
      correct,
      accuracy: inBucket.length === 0 ? 0 : correct / inBucket.length,
    });
  }
  return buckets;
}

/**
 * Lowest tested threshold whose confident decisions meet `target` accuracy.
 * Returns `undefined` when no threshold with any coverage does.
 */
export function recommendThreshold(
  outcomes: readonly CaseOutcome[],
  target = 0.9,
  grid: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95],
): ThresholdResult | undefined {
  let best: ThresholdResult | undefined;
  for (const threshold of grid) {
    const actedOn = outcomes.filter(
      (outcome) =>
        typeof outcome.confidence === "number" && outcome.confidence >= threshold,
    );
    if (actedOn.length === 0) continue;
    const correct = actedOn.filter((outcome) => outcome.correct).length;
    const accuracy = correct / actedOn.length;
    if (accuracy >= target) {
      best = { threshold, actedOn: actedOn.length, correct, accuracy };
      break;
    }
  }
  return best;
}
