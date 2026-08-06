/**
 * Detect agent loops from the stream of tool calls within one agent run.
 *
 * A loop is a strong repeated pattern: the same tool with the exact same
 * arguments, called over and over while the model makes no progress. The
 * detector is deliberately conservative — it fires only on identical
 * (tool, serialized input) patterns, never on diverse sequences.
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
  /** Total tool calls in one run beyond which we assume a runaway loop. */
  maxTotalCalls?: number;
}

export type LoopDetection =
  | { kind: "repeat"; count: number; call: ToolCallRecord }
  | { kind: "cycle"; period: number; repetitions: number; sequence: ToolCallRecord[] }
  | { kind: "total"; count: number }
  | { kind: "none" };

export const DEFAULT_LOOP_OPTIONS: Required<LoopDetectOptions> = {
  maxRepeatedCalls: 5,
  minCycleRepetitions: 3,
  maxTotalCalls: 120,
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

    if (this.calls.length >= this.options.maxTotalCalls) {
      return { kind: "total", count: this.calls.length };
    }

    const repeat = this.detectRepeat();
    if (repeat) return repeat;

    const cycle = this.detectCycle();
    if (cycle) return cycle;

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
