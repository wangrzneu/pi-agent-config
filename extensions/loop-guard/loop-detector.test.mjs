import assert from "node:assert/strict";
import test from "node:test";
import { LoopDetector } from "./loop-detector.ts";

function call(tool, input = "{}") {
  return { tool, input };
}

test("does not trigger on a diverse sequence", () => {
  const detector = new LoopDetector();
  assert.equal(detector.record(call("ls", "{\"path\":\"src\"}")).kind, "none");
  assert.equal(detector.record(call("read", "{\"path\":\"a.ts\"}")).kind, "none");
  assert.equal(detector.record(call("bash", "{\"command\":\"npm test\"}")).kind, "none");
  assert.equal(detector.record(call("edit", "{\"path\":\"b.ts\"}")).kind, "none");
  assert.equal(detector.record(call("read", "{\"path\":\"c.ts\"}")).kind, "none");
  assert.equal(detector.callCount, 5);
});

test("triggers repeat after maxRepeatedCalls identical calls", () => {
  const detector = new LoopDetector({ maxRepeatedCalls: 3 });
  for (let i = 0; i < 2; i += 1) {
    assert.equal(detector.record(call("bash", "{\"command\":\"git status\"}")).kind, "none");
  }
  assert.deepEqual(
    detector.record(call("bash", "{\"command\":\"git status\"}")),
    { kind: "repeat", count: 3, call: call("bash", "{\"command\":\"git status\"}") },
  );
});

test("does not trigger on a near-miss streak below the threshold", () => {
  const detector = new LoopDetector({ maxRepeatedCalls: 4 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(detector.record(call("read", "{\"path\":\"a.ts\"}")).kind, "none");
  }
  assert.equal(detector.record(call("read", "{\"path\":\"b.ts\"}")).kind, "none");
  assert.equal(detector.callCount, 4);
});

test("triggers cycle for identical period-2 sequences", () => {
  const detector = new LoopDetector({ minCycleRepetitions: 3 });
  const a = call("read", "{\"path\":\"a.ts\"}");
  const b = call("bash", "{\"command\":\"npm test\"}");
  // a, b, a, b, a, b
  for (const next of [a, b, a, b, a]) {
    assert.equal(detector.record(next).kind, "none");
  }
  const detection = detector.record(b);
  assert.equal(detection.kind, "cycle");
  assert.equal(detection.period, 2);
  assert.equal(detection.repetitions, 3);
  assert.deepEqual(detection.sequence.map((c) => c.tool), ["read", "bash"]);
});

test("triggers cycle for identical period-3 sequences", () => {
  const detector = new LoopDetector({ minCycleRepetitions: 2 });
  const a = call("read", "{\"path\":\"a.ts\"}");
  const b = call("grep", "{\"pattern\":\"fix\"}");
  const c = call("bash", "{\"command\":\"make\"}");
  // a, b, c, a, b, c
  for (const next of [a, b, c, a, b]) {
    assert.equal(detector.record(next).kind, "none");
  }
  const detection = detector.record(c);
  assert.equal(detection.kind, "cycle");
  assert.equal(detection.period, 3);
});

test("does not trigger a cycle when inputs differ between repetitions", () => {
  const detector = new LoopDetector({ minCycleRepetitions: 3 });
  for (const next of [
    call("read", "{\"path\":\"a.ts\"}"),
    call("bash", "{\"command\":\"npm test\"}"),
    call("read", "{\"path\":\"b.ts\"}"),
    call("bash", "{\"command\":\"npm test\"}"),
    call("read", "{\"path\":\"a.ts\"}"),
    call("bash", "{\"command\":\"npm test\"}"),
  ]) {
    assert.equal(detector.record(next).kind, "none");
  }
});

test("total fires at maxTotalCalls only when the tail repeats consecutively", () => {
  const detector = new LoopDetector({
    maxTotalCalls: 5,
    totalWindowCalls: 3,
    maxRepeatedCalls: 100,
    minCycleRepetitions: 100,
  });
  // A diverse run that exceeds the limit with no consecutive repetition in
  // the window is making progress and is never interrupted.
  let result = detector.record(call("read", "{\"path\":\"a.ts\"}"));
  assert.equal(result.kind, "none");
  result = detector.record(call("read", "{\"path\":\"b.ts\"}"));
  assert.equal(result.kind, "none");
  result = detector.record(call("read", "{\"path\":\"c.ts\"}"));
  assert.equal(result.kind, "none");
  result = detector.record(call("read", "{\"path\":\"d.ts\"}"));
  assert.equal(result.kind, "none");
  result = detector.record(call("read", "{\"path\":\"e.ts\"}")); // count=5 = maxTotalCalls
  assert.equal(result.kind, "none", "diverse tail must not fire total");

  // A scattered repeated pair earlier does NOT trigger total: only a
  // *consecutive* run in the tail matters (repetition happening now).
  const detector2 = new LoopDetector({
    maxTotalCalls: 5,
    totalWindowCalls: 3,
    maxRepeatedCalls: 100,
    minCycleRepetitions: 100,
  });
  for (const next of [
    call("bash", "{\"command\":\"npm test\"}"), // 1
    call("read", "{\"path\":\"log.txt\"}"), // 2
    call("bash", "{\"command\":\"npm test\"}"), // 3
    call("read", "{\"path\":\"log.txt\"}"), // 4
  ]) {
    assert.equal(detector2.record(next).kind, "none");
  }
  // 5th call: tail(3) = [bash, read, bash] — the bash pair is NOT adjacent →
  // no consecutive repetition, so total must NOT fire.
  assert.equal(detector2.record(call("bash", "{\"command\":\"npm test\"}")).kind, "none");

  // Consecutive repetition in the tail (read, read) fires total at the budget.
  const detector3 = new LoopDetector({
    maxTotalCalls: 4,
    totalWindowCalls: 3,
    maxRepeatedCalls: 100,
    minCycleRepetitions: 100,
  });
  for (const next of [
    call("bash", "{\"command\":\"npm test\"}"), // 1
    call("read", "{\"path\":\"log.txt\"}"), // 2
    call("read", "{\"path\":\"log.txt\"}"), // 3
  ]) {
    assert.equal(detector3.record(next).kind, "none");
  }
  // 4th call: count reaches maxTotalCalls; tail(3) = [read, read, read] has
  // consecutive repeats → total.
  const detection = detector3.record(call("read", "{\"path\":\"log.txt\"}"));
  assert.equal(detection.kind, "total");
  assert.equal(detection.count, 4);
});

test("repeat fires before total when both are crossed", () => {
  // A run that exceeds maxTotalCalls with an active consecutive-repeat must
  // report the precise repeat, not the coarse total.
  const detector = new LoopDetector({
    maxTotalCalls: 3,
    totalWindowCalls: 5,
    maxRepeatedCalls: 2,
    minCycleRepetitions: 100,
  });
  assert.equal(detector.record(call("bash", "{\"command\":\"git status\"}")).kind, "none");
  const detection = detector.record(call("bash", "{\"command\":\"git status\"}"));
  assert.equal(detection.kind, "repeat");
  assert.equal(detection.count, 2);
});

test("long diverse runs are never interrupted regardless of total threshold", () => {
  // All calls distinct: even far above maxTotalCalls the run is progress.
  const detector = new LoopDetector({
    maxTotalCalls: 6,
    totalWindowCalls: 50,
    maxRepeatedCalls: 100,
    minCycleRepetitions: 100,
  });
  for (let i = 0; i < 10; i += 1) {
    assert.equal(detector.record(call("bash", `{\"n\":${i}}`)).kind, "none");
  }
  assert.equal(detector.callCount, 10);
});

test("reset clears counters", () => {
  const detector = new LoopDetector({ maxRepeatedCalls: 2 });
  detector.record(call("ls"));
  detector.record(call("ls"));
  assert.equal(detector.record(call("ls")).kind, "repeat");
  detector.reset();
  assert.equal(detector.callCount, 0);
  assert.equal(detector.record(call("ls")).kind, "none");
});
