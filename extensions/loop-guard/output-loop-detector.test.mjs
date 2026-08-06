import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPhrases,
  OutputLoopDetector,
} from "./output-loop-detector.ts";

test("detects a repeated CJK sentence in streamed output", () => {
  const detector = new OutputLoopDetector({ maxRepeatedPhrases: 3, analyzeEveryChars: 1 });
  let detection;
  for (let i = 0; i < 2; i += 1) {
    detection = detector.feed("现在执行 lldb。");
    assert.equal(detection, undefined);
  }
  detection = detector.feed("现在执行 lldb。");
  assert.deepEqual(detection, { kind: "phrase-repeat", phrase: "现在执行 lldb", count: 3 });
});

test("detects repeats even when streamed in partial token chunks", () => {
  const detector = new OutputLoopDetector({ maxRepeatedPhrases: 3, analyzeEveryChars: 1 });
  // Each sentence arrives fragmented across multiple deltas. The third
  // sentence is completed by the fourth delta, which crosses the threshold.
  assert.equal(detector.feed("现在执行 ll"), undefined);
  assert.equal(detector.feed("db。现在执行 "), undefined);
  assert.equal(detector.feed("lldb。现在执行 "), undefined);
  const detection = detector.feed("lldb。");
  assert.deepEqual(detection, { kind: "phrase-repeat", phrase: "现在执行 lldb", count: 3 });
});

test("does not detect on diverse prose", () => {
  const detector = new OutputLoopDetector({ maxRepeatedPhrases: 3, analyzeEveryChars: 1 });
  for (const sentence of [
    "First we inspect the logs.",
    "The build failed on the test step.",
    "Fix the import and rerun the suite.",
  ]) {
    assert.equal(detector.feed(sentence), undefined);
  }
});

test("short phrases are ignored", () => {
  const detector = new OutputLoopDetector({
    maxRepeatedPhrases: 2,
    minPhraseLength: 8,
    analyzeEveryChars: 1,
  });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(detector.feed("done."), undefined);
  }
});

test("reset clears the window", () => {
  const detector = new OutputLoopDetector({ maxRepeatedPhrases: 2, analyzeEveryChars: 1 });
  detector.feed("loop phrase one.");
  detector.feed("loop phrase one.");
  assert.ok(detector.feed("loop phrase one."));
  detector.reset();
  assert.equal(detector.outputChars, 0);
  assert.equal(detector.feed("loop phrase one."), undefined);
});

test("extractPhrases splits CJK and Latin sentences and normalizes whitespace", () => {
  const phrases = extractPhrases(
    "现在执行 lldb。Now run the tool.  另  一个 短语！",
    4,
  );
  assert.deepEqual(phrases, [
    "现在执行 lldb",
    "Now run the tool",
    "另 一个 短语",
  ]);
});

test("window is bounded to the most recent text", () => {
  const detector = new OutputLoopDetector({
    maxRepeatedPhrases: 2,
    windowChars: 120,
    analyzeEveryChars: 1,
  });
  // 40 chars of filler between each repeat so only two repeats fit in 120 chars.
  const filler = "x".repeat(40);
  assert.equal(detector.feed(`target.${filler}`), undefined);
  assert.equal(detector.feed(`target.${filler}`), undefined);
  const detection = detector.feed("target.");
  assert.equal(detection?.kind, "phrase-repeat");
  // A third repeat scrolls the first one out of the window; the buffer stays bounded.
  detector.feed(`${filler}target.`);
  assert.equal(detector.outputChars <= 120, true);
});

test("detection keeps working after the window overflows", () => {
  const detector = new OutputLoopDetector({
    maxRepeatedPhrases: 3,
    windowChars: 100,
    analyzeEveryChars: 1,
  });
  // Overflow the window with filler first (more than windowChars).
  assert.equal(detector.feed("f".repeat(150)), undefined);
  assert.equal(detector.outputChars, 100);

  // Repeating the phrase must still be detected after the overflow. The first
  // phrase shares the window with leftover filler, so four feeds are needed
  // for three clean duplicates.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(detector.feed("现在执行 lldb。"), undefined);
  }
  const detection = detector.feed("现在执行 lldb。");
  assert.equal(detection?.kind, "phrase-repeat");
  assert.equal(detection.phrase, "现在执行 lldb");

  // And detection still fires after further overflow.
  assert.equal(detector.feed("g".repeat(300)), undefined);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(detector.feed("同一个句子。"), undefined);
  }
  assert.equal(detector.feed("同一个句子。").kind, "phrase-repeat");
});
