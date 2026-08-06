import assert from "node:assert/strict";
import test from "node:test";
import { LoopDetector } from "./loop-detector.ts";

function call(tool, input = "{}", callId = `${tool}-${input}`) {
  return { tool, input, callId };
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

test("triggers total after maxTotalCalls", () => {
  const detector = new LoopDetector({ maxTotalCalls: 4, maxRepeatedCalls: 100, minCycleRepetitions: 100 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(detector.record(call("bash", `{\"n\":${i}}`)).kind, "none");
  }
  assert.deepEqual(detector.record(call("bash", "{\"n\":3}")), { kind: "total", count: 4 });
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
