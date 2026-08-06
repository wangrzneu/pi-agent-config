/**
 * Detect agent loops from the stream of tool calls within one agent run.
 *
 * A loop is a strong repeated pattern: the same tool with the exact same
 * arguments, called over and over while the model makes no progress. The
 * detector is deliberately conservative — it fires only on identical
 * (tool, serialized input) patterns, never on diverse sequences.
 *
 * Thresholds follow Grok Build's doom-loop recovery posture: act only on
 * tight repetition (`maxRepeatedCalls` 8), require more cycle repetitions,
 * and make the total-call budget "progress-aware" — a long run only fires
 * `total` when repetition actually appears in its recent tail, so a big
 * legitimate refactor with diverse calls is never interrupted.
 */

export interface ToolCallRecord {
  tool: string;
  /** Deterministic serialization of the tool arguments (keys sorted). */
  input: string;
}

export interface LoopDetectOptions {
  /** Consecutive identical calls (tool + input) that trigger a repeat. */
  maxRepeatedCalls?: number;
  /** Identical call sequences of period 2 or 3 repeated this many times. */
  minCycleRepetitions?: number;
  /**
   * Total tool calls at which the run is assumed to be a runaway loop — but
   * only when repetition appears in the recent tail (see totalWindowCalls).
   */
  maxTotalCalls?: number;
  /**
   * Recent tail (calls) scanned for any identical pair when maxTotalCalls is
   * reached. A long run with no repetition in this window is making progress
   * and is not interrupted.
   */
  totalWindowCalls?: number;
}

export type LoopDetection =
  | { kind: "repeat"; count: number; call: ToolCallRecord }
  | { kind: "cycle"; period: number; repetitions: number; sequence: ToolCallRecord[] }
  | { kind: "total"; count: number }
  | { kind: "none" };

export const DEFAULT_LOOP_OPTIONS: Required<LoopDetectOptions> = {
  maxRepeatedCalls: 8,
  minCycleRepetitions: 4,
  maxTotalCalls: 200,
  totalWindowCalls: 10,
};

export class LoopDetector {
  private readonly calls: ToolCallRecord[] = [];
  private readonly options: Required<LoopDetectOptions>;

  constructor(options: LoopDetectOptions = {}) {
    this.options = { ...DEFAULT_LOOP_OPTIONS, ...options };
  }

  reset(): void {
    this.calls.length = 0;
  }

  get callCount(): number {
    return this.calls.length;
  }

  /** Record one tool call; returns the first loop detection crossed. */
  record(call: ToolCallRecord): LoopDetection {
    this.calls.push(call);

    // Consecutive-repeat and cycle are the precise, confident signals; check
    // them first. `total` is the last-resort escape hatch: it fires only when
    // the run exceeds the call budget AND the tail contains a *consecutive*
    // run of identical calls (repetition happening right now), so a long but
    // diverse run is never interrupted (progress), and a run that merely had
    // a repeated pair 100 calls ago is not misclassified.
    const repeat = this.detectRepeat();
    if (repeat) return repeat;

    const cycle = this.detectCycle();
    if (cycle) return cycle;

    if (this.calls.length >= this.options.maxTotalCalls) {
      if (hasConsecutiveRepeatedRun(this.calls, this.options.totalWindowCalls)) {
        return { kind: "total", count: this.calls.length };
      }
    }

    return { kind: "none" };
  }

  private detectRepeat(): LoopDetection | undefined {
    const { maxRepeatedCalls } = this.options;
    if (this.calls.length < maxRepeatedCalls) return undefined;
    const tail = this.calls.slice(-maxRepeatedCalls);
    const first = tail[0];
    if (tail.every((call) => sameCall(call, first))) {
      return { kind: "repeat", count: maxRepeatedCalls, call: first };
    }
    return undefined;
  }

  private detectCycle(): LoopDetection | undefined {
    const { minCycleRepetitions } = this.options;
    for (const period of [2, 3]) {
      const length = period * minCycleRepetitions;
      if (this.calls.length < length) continue;
      const tail = this.calls.slice(-length);
      let repeated = true;
      for (let i = 0; i < length - period; i += 1) {
        if (!sameCall(tail[i], tail[i + period])) {
          repeated = false;
          break;
        }
      }
      if (repeated) {
        return {
          kind: "cycle",
          period,
          repetitions: minCycleRepetitions,
          sequence: tail.slice(-period),
        };
      }
    }
    return undefined;
  }
}

function sameCall(a: ToolCallRecord, b: ToolCallRecord): boolean {
  return a.tool === b.tool && a.input === b.input;
}

/**
 * Whether the tail of `calls` contains a consecutive run of at least 2
 * identical calls (repetition happening *now*, not scattered history). A
 * run of 2 identical calls in the recent window is enough for the total
 * escape hatch — if the model is repeating right now at a high call count,
 * it is not making progress.
 */
function hasConsecutiveRepeatedRun(calls: ToolCallRecord[], windowCalls: number): boolean {
  const tail = calls.slice(-windowCalls);
  for (let i = 0; i + 1 < tail.length; i += 1) {
    if (sameCall(tail[i], tail[i + 1])) return true;
  }
  return false;
}
