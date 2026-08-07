import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_LOOP_OPTIONS,
  LoopDetector,
  type LoopDetection,
  type LoopDetectOptions,
  type ToolCallRecord,
} from "./loop-detector.ts";
import {
  DEFAULT_OUTPUT_LOOP_OPTIONS,
  OutputLoopDetector,
  type OutputLoopDetection,
  type OutputLoopOptions,
} from "./output-loop-detector.ts";

type LoopGuardMode = "on" | "off";

type LoopGuardDetection = LoopDetection | OutputLoopDetection;

export interface LoopGuardOptions extends LoopDetectOptions, OutputLoopOptions {
  /**
   * After aborting one run, leave the next agent run uninterrupted (default
   * true) so a false positive cannot become repeated interruptions. Detection
   * re-arms on the run after that.
   */
  cooldownRuns?: number;
  /**
   * Whether detection runs on startup. Defaults to "off": the phrase/tool
   * heuristics can false-positive on legitimate code (e.g. five identical
   * `return err` lines in one window), and a fix that is reliable enough to
   * be on by default needs linguistic judgment, not string heuristics. Opt
   * back in per session with `/loop-guard on`, or permanently via settings.
   */
  defaultMode?: "on" | "off";
}

/**
 * Loop guard: watches tool calls and streamed output inside one agent run.
 * When the model starts repeating the same tool call — or the same sentence —
 * over and over without making progress (an agent loop that never finishes),
 * it aborts the run silently (no confirmation dialog) and reports once. This
 * follows Grok Build's doom-loop recovery posture: act only on confident,
 * conservative signals, and never keep interrupting — one abort per run, and
 * the next run is left uninterrupted so a false positive cannot turn into
 * repeated user disruption.
 *
 * See https://github.com/QwenLM/qwen-code/issues/4055 for the class of
 * problem this addresses: an agent stuck cycling through tool calls (or stuck
 * verbally repeating the same intent without ever calling a tool) with no way
 * for the user to interrupt it.
 */
export function registerLoopGuardExtension(
  pi: ExtensionAPI,
  options: LoopGuardOptions = {},
): void {
  const toolDetector = new LoopDetector(options);
  // Thinking and visible text are tracked separately: thinking repetition is
  // the strongest "stuck" signal (Grok Build only acts on the thinking
  // channel), while visible-output repetition needs a much higher threshold
  // because a false positive there is far more disruptive.
  const thinkingDetector = new OutputLoopDetector({
    ...options,
    maxRepeatedPhrases:
      options.maxRepeatedPhrases ?? options.maxRepeatedPhrasesThinking ?? DEFAULT_OUTPUT_LOOP_OPTIONS.maxRepeatedPhrasesThinking,
  });
  const textDetector = new OutputLoopDetector({
    ...options,
    maxRepeatedPhrases:
      options.maxRepeatedPhrases ?? DEFAULT_OUTPUT_LOOP_OPTIONS.maxRepeatedPhrases,
  });
  const effective: Required<LoopGuardOptions> = {
    ...DEFAULT_LOOP_OPTIONS,
    ...DEFAULT_OUTPUT_LOOP_OPTIONS,
    cooldownRuns: 1,
    ...options,
  };
  let mode: LoopGuardMode = options.defaultMode ?? "off";
  /** At most one abort per agent run. */
  let abortedThisRun = false;
  /** Runs left to skip detection for after a false-positive abort. */
  let cooldownRunsLeft = 0;
  /** Whether the current run is a cooldown run (detection skipped). */
  let skipThisRun = false;


  pi.registerCommand("loop-guard", {
    description: "Show loop-guard state or use /loop-guard off|on|reset",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "off") {
        mode = "off";
        ctx.ui.notify("Loop guard disabled.", "info");
        return;
      }
      if (action === "on") {
        mode = "on";
        resetDetectors();
        cooldownRunsLeft = 0;
        skipThisRun = false;
        ctx.ui.notify("Loop guard enabled.", "info");
        return;
      }
      if (action === "reset") {
        resetDetectors();
        cooldownRunsLeft = 0;
        skipThisRun = false;
        ctx.ui.notify("Loop guard counters reset.", "info");
        return;
      }
      ctx.ui.notify(
        formatState(
          mode,
          toolDetector.callCount,
          textDetector.outputChars,
          thinkingDetector.outputChars,
          effective,
          cooldownRunsLeft,
        ),
        "info",
      );
    },
  });

  function resetDetectors(): void {
    toolDetector.reset();
    textDetector.reset();
    thinkingDetector.reset();
  }

  pi.on("agent_start", () => {
    resetDetectors();
    abortedThisRun = false;
    // Consume one cooldown run at its start: when the cooldown is exhausted,
    // detection re-arms. The run that follows the abort is left uninterrupted.
    skipThisRun = cooldownRunsLeft > 0;
    if (skipThisRun) cooldownRunsLeft -= 1;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "off" || skipThisRun) return;
    if (abortedThisRun) {
      // The turn already aborted (output-loop or the threshold call itself):
      // block every remaining tool call in the batch so the poisoned turn
      // produces no toolResult side effects.
      return { block: true, reason: "Loop guard aborted the run; blocking the poisoned turn's remaining tool calls." };
    }
    const call: ToolCallRecord = {
      tool: event.toolName,
      input: serializeInput(event.input),
    };
    const detection = toolDetector.record(call);
    if (detection.kind !== "none") {
      // Abort the run (sets abortedThisRun, cooldown, notify), then block this
      // call so the poisoned turn produces no toolResult side effect.
      await interrupt(ctx, detection);
      return {
        block: true,
        reason: `Loop guard aborted the run: ${describeLoop(detection)}. Blocking the remaining tool calls of the poisoned turn.`,
      };
    }
  });

  pi.on("message_update", async (event, ctx) => {
    if (mode === "off" || skipThisRun || abortedThisRun) return;
    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type !== "text_delta" && streamEvent.type !== "thinking_delta") return;
    // Visible text is progress for the tool detector: consecutive-repeat and
    // cycle counters reset so a run that emits commentary between calls is
    // never misjudged as looping.
    if (streamEvent.type === "text_delta" && streamEvent.delta.trim() !== "") {
      // Visible assistant text is progress: consecutive-repeat/cycle counters
      // reset so a run that emits commentary between identical calls is never
      // misjudged as looping (Grok only acts on repetition without progress).
      toolDetector.reset();
    }
    const detector = streamEvent.type === "thinking_delta" ? thinkingDetector : textDetector;
    const detection = detector.feed(streamEvent.delta);
    if (detection) await interrupt(ctx, detection);
  });

  async function interrupt(ctx: ExtensionContext, detection: LoopGuardDetection): Promise<void> {
    if (abortedThisRun) return;
    abortedThisRun = true;

    const explanation = describeLoop(detection);
    ctx.abort();
    // Leave the next run(s) uninterrupted so a false positive cannot become
    // repeated user disruption. Detection re-arms after the cooldown.
    cooldownRunsLeft = effective.cooldownRuns;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Loop guard aborted the run: ${explanation}. The next ${effective.cooldownRuns} run(s) are left uninterrupted; use /loop-guard off if this was a false positive.`,
        "warning",
      );
    }
  }
}

export default function loopGuardExtension(pi: ExtensionAPI): void {
  registerLoopGuardExtension(pi);
}

function describeLoop(detection: LoopGuardDetection): string {
  switch (detection.kind) {
    case "repeat":
      return `The same tool call was repeated ${detection.count} times in a row: ${summarizeCall(detection.call)}`;
    case "cycle":
      return `An identical call sequence of period ${detection.period} repeated ${detection.repetitions} times: ${detection.sequence.map(summarizeCall).join(" then ")}`;
    case "total":
      return `The agent made ${detection.count} tool calls without completing the run.`;
    case "phrase-repeat":
      return `The model repeated the same output phrase ${detection.count} times: “${detection.phrase}”`;
    case "none":
      return "";
  }
}

function summarizeCall(call: ToolCallRecord): string {
  const input = call.input;
  let preview = input.slice(0, 120);
  if (input.length > 120) preview += "…";
  return `${call.tool} ${preview}`;
}

function formatState(
  mode: LoopGuardMode,
  calls: number,
  textChars: number,
  thinkingChars: number,
  options: Required<LoopGuardOptions>,
  cooldownRunsLeft: number,
): string {
  return [
    `Loop guard: ${mode}`,
    `Tool calls this run: ${calls}`,
    `Streaming output chars (text/thinking): ${textChars}/${thinkingChars}`,
    `Thresholds: repeat=${options.maxRepeatedCalls}, cycle repeats=${options.minCycleRepetitions}, total=${options.maxTotalCalls} (window ${options.totalWindowCalls}), text phrase repeats=${options.maxRepeatedPhrases}, thinking phrase repeats=${options.maxRepeatedPhrasesThinking}`,
    `False-positive cooldown: ${cooldownRunsLeft} run(s) left`,
  ].join("\n");
}

/** Stable JSON serialization with sorted object keys so argument reordering
 * cannot evade loop detection. Always returns a string (undefined input maps
 * to "{}"). */
function serializeInput(input: unknown): string {
  const value = input === undefined ? {} : input;
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
}
