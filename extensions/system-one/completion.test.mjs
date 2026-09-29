import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompletionState,
  COMPLETION_LEVELS,
  COMPLETION_SCHEMA,
  DEFAULT_COMPLETION_THRESHOLD,
  isCompletionLevel,
  renderCompletionHint,
  resolveCompletionPolicy,
} from "./completion.ts";

test("completion schema and levels are stable", () => {
  assert.equal(COMPLETION_SCHEMA, "pi.completion_check.v1");
  assert.deepEqual([...COMPLETION_LEVELS], ["verified", "unverified", "incomplete"]);
  assert.equal(isCompletionLevel("verified"), true);
  assert.equal(isCompletionLevel("done"), false);
});

test("only verified turns stay silent; the rest escalate", () => {
  assert.deepEqual(resolveCompletionPolicy("verified", 0.9), {
    level: "verified",
    escalate: false,
    uncertain: false,
  });
  assert.deepEqual(resolveCompletionPolicy("unverified", 0.9), {
    level: "unverified",
    escalate: true,
    uncertain: false,
  });
  assert.deepEqual(resolveCompletionPolicy("incomplete", 0.9), {
    level: "incomplete",
    escalate: true,
    uncertain: false,
  });
});

test("an uncertain completion fails safe to a verification nudge", () => {
  assert.deepEqual(
    resolveCompletionPolicy("verified", DEFAULT_COMPLETION_THRESHOLD - 0.01),
    { level: "unverified", escalate: true, uncertain: true },
  );
  assert.deepEqual(resolveCompletionPolicy("incomplete", Number.NaN), {
    level: "unverified",
    escalate: true,
    uncertain: true,
  });
});

test("unknown levels fail open", () => {
  assert.equal(resolveCompletionPolicy("maybe", 0.9), undefined);
});

test("renders distinct hints for uncertain, incomplete, and unverified", () => {
  assert.match(renderCompletionHint(resolveCompletionPolicy("verified", 0.1)), /could not be confirmed/);
  assert.match(renderCompletionHint(resolveCompletionPolicy("incomplete", 1)), /does not look fully addressed/);
  assert.match(renderCompletionHint(resolveCompletionPolicy("unverified", 1)), /looks complete but unverified/);
});

test("builds a bounded view of the last request and its replies", () => {
  const messages = [
    { role: "user", content: "add a login route" },
    { role: "assistant", content: [{ type: "text", text: "done with login" }] },
    { role: "toolResult", content: "noise" },
    { role: "user", content: "also add logout" },
    { role: "assistant", content: "added logout" },
  ];

  const state = buildCompletionState(messages);
  assert.match(state, /request:\nalso add logout/);
  assert.match(state, /assistant:\nadded logout/);
  assert.doesNotMatch(state, /login route/);

  assert.equal(buildCompletionState(messages, 12).length, 12);
  assert.equal(buildCompletionState([]), "");
  assert.equal(buildCompletionState(undefined), "");
});
