import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OUTPUT_LOOP_OPTIONS,
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

test("short and letter-free phrases never trigger", () => {
  const detector = new OutputLoopDetector({
    maxRepeatedPhrases: 2,
    minPhraseLength: 4,
    analyzeEveryChars: 1,
  });
  // Letter-free separators and too-short fragments are not repetition signal.
  for (let i = 0; i < 4; i += 1) {
    assert.equal(detector.feed("====="), undefined);
    assert.equal(detector.feed("111 222"), undefined);
    assert.equal(detector.feed("a"), undefined);
  }
  // A real phrase still fires.
  for (let i = 0; i < 2; i += 1) {
    assert.equal(detector.feed("执行第一次指令。"), undefined);
  }
  assert.deepEqual(
    detector.feed("执行第一次指令。"),
    { kind: "phrase-repeat", phrase: "执行第一次指令", count: 2 },
  );
});

test("default thinking threshold is more sensitive than text", () => {
  assert.ok(DEFAULT_OUTPUT_LOOP_OPTIONS.maxRepeatedPhrasesThinking < DEFAULT_OUTPUT_LOOP_OPTIONS.maxRepeatedPhrases);
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

test("short phrases are ignored by the default minimum length", () => {
  const detector = new OutputLoopDetector({ maxRepeatedPhrases: 2, analyzeEveryChars: 1 });
  for (let i = 0; i < 4; i += 1) {
    assert.equal(detector.feed("done."), undefined); // 4 chars < default 8
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

test("extractPhrases drops letter-free and too-short fragments", () => {
  assert.deepEqual(extractPhrases("=====  111 222  ...  a", 4), []);
  // "ok" is 2 chars < 4; "111" is letter-free; "fine" is a bare ASCII
  // single token; only the two-word "all good" survives.
  assert.deepEqual(extractPhrases("ok. 111. fine. all good", 4), ["all good"]);
});

test("extractPhrases keeps pure-CJK single tokens but drops ASCII identifiers", () => {
  // CJK has no word spaces: a stuck CJK phrase must stay a repeat unit.
  assert.deepEqual(extractPhrases("请执行第一步操作", 4), ["请执行第一步操作"]);
  // Bare ASCII identifiers (struct-tag fragments, dotted names) are code
  // noise, not repetition signal.
  assert.deepEqual(extractPhrases("omitempty", 4), []);
  assert.deepEqual(extractPhrases("default_timeout", 4), []);
  // But an ASCII phrase spanning two tokens still counts.
  assert.deepEqual(extractPhrases("run the tool", 4), ["run the tool"]);
});

test("repeated omitempty-style struct tag suffixes do not false-positive", () => {
  // Regression: a Go struct with several `\`json:"...omitempty"` fields each
  // ending in an identical fragment used to trip the phrase detector 5 times
  // (thinking threshold). The tag fragments carry structural punctuation
  // (quotes/backticks) or are bare identifiers, so they are not prose
  // clauses and never add up.
  const detector = new OutputLoopDetector({ maxRepeatedPhrases: 5, analyzeEveryChars: 1 });
  const struct = [
    '    \`\`\`go',
    '      type requestPayload struct {',
    '          Model           string        \`json:"model"\`',
    '          Content         []ContentItem \`json:"content"\`',
    '          ReturnLastFrame bool          \`json:"return_last_frame,omitempty"\`',
    '          Resolution      string        \`json:"resolution,omitempty"\`',
    '          Ratio           string        \`json:"ratio,omitempty"\`',
    '          Duration        int           \`json:"duration,omitempty"\`',
    '          GenerateAudio   *bool         \`json:"generate_audio,omitempty"\`',
    '    \`\`\`',
  ].join("\n");
  // Stream it in partial chunks exactly like real token deltas.
  let detection;
  for (const tok of [...struct]) detection = detector.feed(tok) ?? detection;
  assert.equal(detection, undefined, "struct tags must not fire the phrase detector");
});

test("comma-separated clause loops still trigger (regression)", () => {
  // Commas are clause-level separators: a stuck Latin loop written as
  // "run again, run again, ..." must still be detected — fixing the
  // struct-tag false positive must not hide real comma-separated loops.
  const detector = new OutputLoopDetector({ maxRepeatedPhrases: 3, analyzeEveryChars: 1 });
  // The detector reports at the threshold crossing (early return), so four
  // occurrences with threshold 3 report count 3.
  assert.deepEqual(
    detector.feed("run again, run again, run again, run again"),
    { kind: "phrase-repeat", phrase: "run again", count: 3 },
  );
});

test("structural punctuation (code) never forms a repeated clause", () => {
  const detector = new OutputLoopDetector({ maxRepeatedPhrases: 3, analyzeEveryChars: 1 });
  // Call-site prefixes, string tails, and JSON fragments all contain
  // structural punctuation: they are code noise, not prose clauses, so
  // repeated occurrences across lines must not add up.
  for (const line of [
    "a, err := f()",
    "b, err := f()",
    "c, err := f()",
    "d, err := f()",
    "e, err := f()",
  ]) {
    assert.equal(detector.feed(`${line}\n`), undefined);
  }
  for (let i = 0; i < 5; i += 1) {
    assert.equal(detector.feed('return "", err\n'), undefined);
  }
  for (let i = 0; i < 5; i += 1) {
    assert.equal(detector.feed('json:"d,omitempty"\n'), undefined);
  }
});

test("repeated bare ASCII identifiers never trigger", () => {
  const detector = new OutputLoopDetector({ maxRepeatedPhrases: 3, analyzeEveryChars: 1 });
  for (let i = 0; i < 6; i += 1) {
    assert.equal(detector.feed("AuthenticationError\n"), undefined);
  }
  assert.equal(detector.feed("omitempty\n"), undefined);
});

test("single-token CJK phrases still trigger", () => {
  const detector = new OutputLoopDetector({ maxRepeatedPhrases: 3, analyzeEveryChars: 1 });
  for (let i = 0; i < 2; i += 1) {
    assert.equal(detector.feed("请执行第一步操作。"), undefined);
  }
  assert.deepEqual(
    detector.feed("请执行第一步操作。"),
    { kind: "phrase-repeat", phrase: "请执行第一步操作", count: 3 },
  );
});

test("window is bounded to the most recent text", () => {
  const detector = new OutputLoopDetector({
    maxRepeatedPhrases: 2,
    minPhraseLength: 4,
    windowChars: 120,
    analyzeEveryChars: 1,
  });
  // 41 chars of filler between each repeat so only two repeats fit in 120 chars.
  // The filler is a bare single-token ASCII identifier, so it never counts.
  const filler = "x".repeat(40) + "\n";
  const target = "run target now\n";
  assert.equal(detector.feed(`${target}${filler}`), undefined); // 1 occurrence
  const detection = detector.feed(`${target}${filler}`); // 2nd occurrence crosses threshold
  assert.deepEqual(detection, { kind: "phrase-repeat", phrase: "run target now", count: 2 });
  // Overflowing the window scrolls the first repeat out; the buffer stays
  // bounded and the most recent repeats still count.
  detector.feed(`${filler}${target}`);
  assert.equal(detector.outputChars <= 120, true);
  assert.equal(detector.feed(target)?.kind, "phrase-repeat");
});

test("detection keeps working after the window overflows", () => {
  const detector = new OutputLoopDetector({
    maxRepeatedPhrases: 3,
    minPhraseLength: 4,
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
