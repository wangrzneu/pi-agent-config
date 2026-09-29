import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChangeState,
  DEFAULT_RISK_THRESHOLD,
  isRiskLevel,
  renderRiskHint,
  resolveRiskPolicy,
  RISK_LEVELS,
  RISK_SCHEMA,
} from "./risk.ts";

test("risk schema and levels are stable", () => {
  assert.equal(RISK_SCHEMA, "pi.change_risk.v1");
  assert.deepEqual([...RISK_LEVELS], ["low", "medium", "high"]);
  assert.equal(isRiskLevel("high"), true);
  assert.equal(isRiskLevel("HIGH"), false);
  assert.equal(isRiskLevel(1), false);
});

test("high and medium risk escalate; low stays silent", () => {
  assert.deepEqual(resolveRiskPolicy("high", 0.9), {
    level: "high",
    escalate: true,
    suggestsPlan: true,
    uncertain: false,
  });
  assert.deepEqual(resolveRiskPolicy("medium", 0.7), {
    level: "medium",
    escalate: true,
    suggestsPlan: false,
    uncertain: false,
  });
  assert.deepEqual(resolveRiskPolicy("low", 0.9), {
    level: "low",
    escalate: false,
    suggestsPlan: false,
    uncertain: false,
  });
});

test("an uncertain assessment fails safe to medium", () => {
  assert.deepEqual(resolveRiskPolicy("low", DEFAULT_RISK_THRESHOLD - 0.01), {
    level: "medium",
    escalate: true,
    suggestsPlan: false,
    uncertain: true,
  });
  assert.deepEqual(resolveRiskPolicy("high", Number.NaN), {
    level: "medium",
    escalate: true,
    suggestsPlan: false,
    uncertain: true,
  });
});

test("unknown levels fail open", () => {
  assert.equal(resolveRiskPolicy("critical", 0.9), undefined);
});

test("renders distinct hints for uncertain, high, and medium", () => {
  assert.match(renderRiskHint(resolveRiskPolicy("low", 0.1)), /could not be assessed/);
  assert.match(renderRiskHint(resolveRiskPolicy("high", 1)), /high risk/);
  assert.match(renderRiskHint(resolveRiskPolicy("medium", 1)), /medium risk/);
  assert.match(
    renderRiskHint(resolveRiskPolicy("high", 1)),
    /prompts\/review-first\.md/,
  );
});

test("builds a bounded change state for edit and write", () => {
  const edit = buildChangeState("edit", {
    path: "src/auth/session.ts",
    edits: [{ oldText: "token", newText: "refreshToken" }],
  });
  assert.match(edit, /tool: edit/);
  assert.match(edit, /path: src\/auth\/session\.ts/);
  assert.match(edit, /- token/);
  assert.match(edit, /\+ refreshToken/);

  const legacy = buildChangeState("edit", {
    file_path: "a.ts",
    oldText: "a",
    newText: "b",
  });
  assert.match(legacy, /path: a\.ts/);
  assert.match(legacy, /@@ edit @@/);

  const write = buildChangeState("write", { path: "b.ts", content: "hello" });
  assert.match(write, /@@ content @@/);
  assert.match(write, /hello/);

  const bounded = buildChangeState(
    "write",
    { path: "c.ts", content: "x".repeat(500) },
    20,
  );
  assert.equal(bounded.length, 20);
});
