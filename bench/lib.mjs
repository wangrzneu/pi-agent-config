/**
 * Pure helpers for the A/B benchmark harness.
 *
 * The harness runs Pi in JSON mode, parses the event stream, and summarizes the
 * metrics used by `docs/ab-testing.md`. Keep this module free of I/O so the
 * analysis and parsing rules are testable offline.
 */

/** Split a Pi JSONL stream and report malformed lines instead of throwing. */
export function parseJsonl(text) {
  const events = [];
  const malformed = [];
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed.push(line.slice(0, 200));
    }
  }
  return { events, malformed };
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== "object") return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    if (Number.isFinite(usage[key])) total[key] += usage[key];
  }
  const cost = usage.cost;
  const totalCost =
    typeof cost === "number"
      ? cost
      : cost && typeof cost === "object" && Number.isFinite(cost.total)
        ? cost.total
        : 0;
  total.cost += totalCost;
}

/**
 * Summarize one Pi JSON-mode run. Usage is summed from finalized assistant
 * messages, not from cumulative `message_update` records.
 */
export function summarizeEvents(events) {
  const summary = {
    turns: 0,
    toolCalls: 0,
    agentEnds: 0,
    settled: 0,
    aborted: false,
    errorMessages: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
    },
  };

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    switch (event.type) {
      case "turn_start":
        summary.turns += 1;
        break;
      case "tool_execution_start":
        summary.toolCalls += 1;
        break;
      case "agent_end":
        summary.agentEnds += 1;
        break;
      case "agent_settled":
        summary.settled += 1;
        summary.aborted = summary.aborted || event.aborted === true;
        break;
      case "message_end": {
        const message = event.message;
        if (!message || typeof message !== "object") break;
        if (message.role === "assistant") {
          if (message.stopReason === "error") summary.errorMessages += 1;
          addUsage(summary.usage, message.usage);
        }
        break;
      }
      default:
        break;
    }
  }

  return summary;
}

/** Summarize a System One JSONL trace file. */
export function summarizeTrace(text) {
  const { events, malformed } = parseJsonl(text);
  const latencies = events
    .map((entry) => entry?.ms)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const kinds = {};
  for (const entry of events) {
    const kind = typeof entry?.kind === "string" ? entry.kind : "unknown";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return {
    decisions: events.length,
    malformed: malformed.length,
    cacheHits: events.filter((entry) => entry?.cached === true).length,
    failures: events.filter((entry) => entry?.ok === false).length,
    medianMs: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    kinds,
  };
}

/** Parse `git diff --numstat` output. */
export function summarizeDiff(numstatText) {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of String(numstatText).split("\n")) {
    const [addedText, removedText] = line.split("\t");
    if (addedText === undefined || removedText === undefined) continue;
    files += 1;
    const a = Number(addedText);
    const r = Number(removedText);
    if (!Number.isFinite(a) || !Number.isFinite(r)) continue; // binary file
    added += a;
    removed += r;
  }
  return { files, added, removed };
}

/** Linear-interpolated percentile. Returns `null` for an empty list. */
export function percentile(values, p) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/**
 * Two-sided exact McNemar test. `b` is control fail / treatment success,
 * `c` is control success / treatment fail. Returns a p-value in [0, 1].
 */
export function mcnemarExactP(b, c) {
  const discordant = b + c;
  if (discordant === 0) return 1;
  const k = Math.min(b, c);
  let pmf = Math.exp(discordant * Math.log(0.5));
  let cdf = pmf;
  for (let i = 1; i <= k; i += 1) {
    pmf *= (discordant - i + 1) / i;
    cdf += pmf;
  }
  return Math.min(1, 2 * cdf);
}

/** Deterministic 32-bit LCG so bootstrap results are reproducible. */
export function createRandom(seed = 1) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Percentile bootstrap CI for the mean of paired differences. Values are
 * `treatment - control`; pass 0/1 for success and milliseconds for latency.
 */
export function bootstrapMeanCI(values, {
  iterations = 10_000,
  confidence = 0.95,
  seed = 1,
} = {}) {
  const sample = values.filter((value) => Number.isFinite(value));
  if (sample.length === 0) return { mean: null, low: null, high: null, n: 0 };

  const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;
  const random = createRandom(seed);
  const means = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < sample.length; j += 1) {
      sum += sample[Math.floor(random() * sample.length)];
    }
    means.push(sum / sample.length);
  }
  const alpha = (1 - confidence) / 2;
  return {
    mean,
    low: percentile(means, alpha * 100),
    high: percentile(means, (1 - alpha) * 100),
    n: sample.length,
  };
}

/** Aggregate runs by condition for the Markdown report. */
export function summarizeRuns(runs) {
  const groups = { off: [], on: [] };
  for (const run of runs) {
    if (run?.condition === "off" || run?.condition === "on") {
      groups[run.condition].push(run);
    }
  }

  const stats = {};
  for (const condition of ["off", "on"]) {
    const group = groups[condition];
    const successful = group.filter((run) => run.success === true).length;
    const wall = group.map((run) => run.wallMs);
    stats[condition] = {
      runs: group.length,
      successes: successful,
      successRate: group.length === 0 ? null : successful / group.length,
      wallMedianMs: percentile(wall, 50),
      wallP95Ms: percentile(wall, 95),
      piMedianMs: percentile(group.map((run) => run.piMs), 50),
      piP95Ms: percentile(group.map((run) => run.piMs), 95),
      turnsMedian: percentile(group.map((run) => run.summary?.turns), 50),
      toolCallsMedian: percentile(group.map((run) => run.summary?.toolCalls), 50),
      totalTokens: group.reduce((sum, run) => sum + (run.summary?.usage?.totalTokens ?? 0), 0),
      totalCost: group.reduce((sum, run) => sum + (run.summary?.usage?.cost ?? 0), 0),
    };
  }
  return stats;
}

/** Success/latency/token summaries grouped by task category. */
export function summarizeByCategory(runs) {
  const groups = new Map();
  for (const run of runs) {
    const category = typeof run?.category === "string" && run.category
      ? run.category
      : "uncategorized";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(run);
  }
  return [...groups.entries()]
    .map(([category, groupRuns]) => ({
      category,
      tasks: new Set(groupRuns.map((run) => run.task)).size,
      stats: summarizeRuns(groupRuns),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/** Pair runs by task and repetition for paired analysis. */
export function pairRuns(runs) {
  const byKey = new Map();
  for (const run of runs) {
    if (!run || typeof run.task !== "string") continue;
    if (run.condition !== "off" && run.condition !== "on") continue;
    const key = `${run.task}\u0000${run.rep ?? 0}`;
    const pair = byKey.get(key) ?? { task: run.task, rep: run.rep ?? 0 };
    pair[run.condition] = run;
    byKey.set(key, pair);
  }
  return [...byKey.values()].filter((pair) => pair.off && pair.on);
}

/** Build the human-readable Markdown report. */
export function renderReport(runs, { seed = 1 } = {}) {
  const stats = summarizeRuns(runs);
  const pairs = pairRuns(runs);
  const successDeltas = pairs.map(
    (pair) => Number(pair.on.success === true) - Number(pair.off.success === true),
  );
  const latencyDeltas = pairs.map((pair) => pair.on.piMs - pair.off.piMs);
  const b = pairs.filter((pair) => pair.off.success !== true && pair.on.success === true).length;
  const c = pairs.filter((pair) => pair.off.success === true && pair.on.success !== true).length;
  const successCI = bootstrapMeanCI(successDeltas, { seed });
  const latencyCI = bootstrapMeanCI(latencyDeltas, { seed });

  const pct = (value) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
  const num = (value, digits = 0) =>
    value === null || value === undefined ? "—" : Number(value).toFixed(digits);

  const lines = [
    "# A/B results",
    "",
    `Runs: ${runs.length}; complete pairs: ${pairs.length}`,
    "",
    "| Metric | off | on | Δ (on − off) |",
    "|---|---:|---:|---:|",
    `| Success rate | ${pct(stats.off.successRate)} | ${pct(stats.on.successRate)} | ${num(
      (stats.on.successRate ?? 0) - (stats.off.successRate ?? 0),
      3,
    )} |`,
    `| Median Pi time (ms) | ${num(stats.off.piMedianMs)} | ${num(stats.on.piMedianMs)} | ${num(
      (stats.on.piMedianMs ?? 0) - (stats.off.piMedianMs ?? 0),
    )} |`,
    `| p95 Pi time (ms) | ${num(stats.off.piP95Ms)} | ${num(stats.on.piP95Ms)} | ${num(
      (stats.on.piP95Ms ?? 0) - (stats.off.piP95Ms ?? 0),
    )} |`,
    `| Median end-to-end (ms) | ${num(stats.off.wallMedianMs)} | ${num(stats.on.wallMedianMs)} | ${num(
      (stats.on.wallMedianMs ?? 0) - (stats.off.wallMedianMs ?? 0),
    )} |`,
    `| Median turns | ${num(stats.off.turnsMedian, 1)} | ${num(stats.on.turnsMedian, 1)} | — |`,
    `| Median tool calls | ${num(stats.off.toolCallsMedian, 1)} | ${num(stats.on.toolCallsMedian, 1)} | — |`,
    `| Total tokens | ${num(stats.off.totalTokens)} | ${num(stats.on.totalTokens)} | — |`,
    `| Total cost | ${num(stats.off.totalCost, 4)} | ${num(stats.on.totalCost, 4)} | — |`,
    "",
    "## By category",
    "",
    "| Category | Tasks | off success | on success | Δ success | off Pi p50 | on Pi p50 | off tokens | on tokens |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...summarizeByCategory(runs).map(({ category, tasks: taskCount, stats: group }) => {
      const delta = (group.on.successRate ?? 0) - (group.off.successRate ?? 0);
      return `| ${category} | ${taskCount} | ${pct(group.off.successRate)} | ${pct(group.on.successRate)} | ${num(delta, 3)} | ${num(group.off.piMedianMs)} | ${num(group.on.piMedianMs)} | ${num(group.off.totalTokens)} | ${num(group.on.totalTokens)} |`;
    }),
    "",
    "## Paired analysis",
    "",
    `McNemar: b=${b} (off fail → on success), c=${c} (off success → on fail), p=${mcnemarExactP(b, c).toFixed(4)}`,
    "",
    `Success delta 95% CI: ${num(successCI.low, 3)} … ${num(successCI.high, 3)} (mean ${num(
      successCI.mean,
      3,
    )}, n=${successCI.n})`,
    "",
    `Pi-time delta 95% CI: ${num(latencyCI.low)} … ${num(latencyCI.high)} ms (mean ${num(
      latencyCI.mean,
    )} ms, n=${latencyCI.n})`,
    "",
    "## Notes",
    "",
    "- `off` and `on` are paired by task and repetition.",
    "- Success is the task's test command exit code, unless the task config says otherwise.",
    "- `Pi time` is the controlled model/tool latency; end-to-end includes clone, setup, and tests.",
    "- Use `p95` and the bootstrap intervals, not only the mean.",
    "- Keep `PI_WORK_STATUS_CLASSIFIER=0` in both arms when isolating System One.",
  ];

  return `${lines.join("\n")}\n`;
}
