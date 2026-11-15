import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapMeanCI,
  mcnemarExactP,
  parseJsonl,
  percentile,
  renderReport,
  summarizeDiff,
  summarizeByCategory,
  summarizeEvents,
  summarizeRuns,
  summarizeTrace,
} from "./lib.mjs";

test("parseJsonl splits LF records, strips CR, and reports malformed lines", () => {
  const { events, malformed } = parseJsonl(
    '{"type":"a"}\r\n\nnot-json\n{"type":"b"}\n',
  );
  assert.deepEqual(events, [{ type: "a" }, { type: "b" }]);
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0], "not-json");
});

test("summarizeEvents counts turns, tools, aborts, and finalized usage", () => {
  const summary = summarizeEvents([
    { type: "turn_start" },
    { type: "turn_start" },
    { type: "tool_execution_start" },
    { type: "tool_execution_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: {
          input: 10,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          totalTokens: 19,
          cost: { total: 0.01 },
        },
      },
    },
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "error" },
    },
    { type: "agent_end" },
    { type: "agent_settled", aborted: true },
  ]);

  assert.equal(summary.turns, 2);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.agentEnds, 1);
  assert.equal(summary.settled, 1);
  assert.equal(summary.aborted, true);
  assert.equal(summary.errorMessages, 1);
  assert.deepEqual(summary.usage, {
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 19,
    cost: 0.01,
  });
});

test("summarizeTrace reports cache hits, failures, and latency percentiles", () => {
  const trace = summarizeTrace(
    [
      '{"kind":"choice","ms":10,"cached":false,"ok":true}',
      '{"kind":"choice","ms":0,"cached":true,"ok":true}',
      '{"kind":"noul","ms":30,"cached":false,"ok":false}',
      "not-json",
    ].join("\n"),
  );
  assert.equal(trace.decisions, 3);
  assert.equal(trace.cacheHits, 1);
  assert.equal(trace.failures, 1);
  assert.equal(trace.medianMs, 10);
  assert.deepEqual(trace.kinds, { choice: 2, noul: 1 });
});

test("percentile uses interpolation and handles empty input", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([0, 10], 50), 5);
  assert.ok(Math.abs(percentile([0, 10, 20, 30], 95) - 28.5) < 1e-9);
});

test("summarizeDiff parses numstat", () => {
  assert.deepEqual(
    summarizeDiff("3\t1\tsrc/a.ts\n0\t5\tsrc/b.ts\n-\t-\timage.png\n"),
    { files: 3, added: 3, removed: 6 },
  );
});

test("McNemar p-value is symmetric and returns 1 for no discordant pairs", () => {
  assert.equal(mcnemarExactP(0, 0), 1);
  assert.equal(mcnemarExactP(10, 0), mcnemarExactP(0, 10));
  assert.ok(mcnemarExactP(10, 0) < 0.01);
  assert.ok(mcnemarExactP(5, 5) > 0.9);
});

test("bootstrapMeanCI is deterministic for a fixed seed", () => {
  const values = [1, 1, 1, 0, 0, 1, 1, 1];
  const first = bootstrapMeanCI(values, { iterations: 500, seed: 7 });
  const second = bootstrapMeanCI(values, { iterations: 500, seed: 7 });
  assert.deepEqual(first, second);
  assert.equal(first.n, values.length);
  assert.ok(first.low <= first.mean && first.mean <= first.high);
});

test("summarizeRuns and renderReport produce paired metrics", () => {
  const runs = [
    {
      task: "a",
      category: "bugfix",
      rep: 0,
      condition: "off",
      success: false,
      wallMs: 100,
      piMs: 80,
      summary: { turns: 2, toolCalls: 3, usage: { totalTokens: 10, cost: 0.01 } },
    },
    {
      task: "a",
      category: "bugfix",
      rep: 0,
      condition: "on",
      success: true,
      wallMs: 150,
      piMs: 120,
      summary: { turns: 4, toolCalls: 6, usage: { totalTokens: 20, cost: 0.02 } },
    },
    {
      task: "b",
      category: "refactor",
      rep: 0,
      condition: "off",
      success: true,
      wallMs: 200,
      piMs: 180,
      summary: { turns: 1, toolCalls: 1, usage: { totalTokens: 5, cost: 0.005 } },
    },
    {
      task: "b",
      category: "refactor",
      rep: 0,
      condition: "on",
      success: true,
      wallMs: 220,
      piMs: 200,
      summary: { turns: 2, toolCalls: 2, usage: { totalTokens: 8, cost: 0.008 } },
    },
  ];

  const stats = summarizeRuns(runs);
  assert.equal(stats.off.successRate, 0.5);
  assert.equal(stats.on.successRate, 1);
  assert.equal(stats.off.wallMedianMs, 150);
  assert.equal(stats.on.wallMedianMs, 185);
  assert.equal(stats.off.piMedianMs, 130);
  assert.equal(stats.on.piMedianMs, 160);

  const categories = summarizeByCategory(runs);
  assert.equal(categories.length, 2);
  assert.equal(categories.find((entry) => entry.category === "bugfix").stats.off.successRate, 0);

  const report = renderReport(runs, { seed: 3 });
  assert.match(report, /Success rate/);
  assert.match(report, /## By category/);
  assert.match(report, /\| bugfix \| 1 \|/);
  assert.match(report, /McNemar: b=1 \(off fail → on success\), c=0/);
  assert.match(report, /Success delta 95% CI/);
});
