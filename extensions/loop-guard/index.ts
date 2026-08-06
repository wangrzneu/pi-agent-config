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

export interface LoopGuardOptions extends LoopDetectOptions, OutputLoopOptions {}

/**
 * Loop guard: watches tool calls and streamed output inside one agent run.
 * When the model starts repeating the same tool call — or the same sentence —
 * over and over without making progress (an agent loop that never finishes),
 * it asks the user whether to abort the run, or aborts directly when no
 * interactive UI is available so a print/RPC run cannot hang forever.
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
  const outputDetector = new OutputLoopDetector(options);
  const effective = {
    ...DEFAULT_LOOP_OPTIONS,
    ...DEFAULT_OUTPUT_LOOP_OPTIONS,
    ...options,
  };
  let mode: LoopGuardMode = "on";
  let snoozed = false;
  /** At most one interrupt per agent run: approval aborts the run, and a
   * decline snoozes the rest of the run, so a second interrupt is moot. */
  let interruptRequested = false;

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
        toolDetector.reset();
        outputDetector.reset();
        ctx.ui.notify("Loop guard enabled.", "info");
        return;
      }
      if (action === "reset") {
        toolDetector.reset();
        outputDetector.reset();
        ctx.ui.notify("Loop guard counters reset.", "info");
        return;
      }
      ctx.ui.notify(
        formatState(mode, toolDetector.callCount, outputDetector.outputChars, effective),
        "info",
      );
    },
  });

  pi.on("agent_start", () => {
    toolDetector.reset();
    outputDetector.reset();
    snoozed = false;
    interruptRequested = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "off" || snoozed || interruptRequested) return;
    const call: ToolCallRecord = {
      tool: event.toolName,
      input: serializeInput(event.input),
    };
    const detection = toolDetector.record(call);
    if (detection.kind !== "none") await interrupt(ctx, detection);
  });

  pi.on("message_update", async (event, ctx) => {
    if (mode === "off" || snoozed || interruptRequested) return;
    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type !== "text_delta" && streamEvent.type !== "thinking_delta") return;
    const detection = outputDetector.feed(streamEvent.delta);
    if (detection) await interrupt(ctx, detection);
  });

  async function interrupt(ctx: ExtensionContext, detection: LoopGuardDetection): Promise<void> {
    if (interruptRequested) return;
    interruptRequested = true;

    const explanation = describeLoop(detection);
    if (!ctx.hasUI || ctx.mode !== "tui") {
      // No interactive confirmation is possible (print/RPC); abort directly so
      // a runaway loop cannot hang the run indefinitely.
      ctx.abort();
      return;
    }
    const approved = await ctx.ui.confirm(
      "Stop this loop?",
      `${explanation}\n\nAbort the current agent run? Answering No lets it keep going (loop guard pauses until the next agent run).`,
    );
    if (approved) {
      ctx.abort();
      ctx.ui.notify(`Aborted agent run: ${explanation}`, "warning");
    } else {
      snoozed = true;
      ctx.ui.notify("Loop guard paused until the next agent run.", "info");
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
  outputChars: number,
  options: Required<LoopGuardOptions>,
): string {
  return [
    `Loop guard: ${mode}`,
    `Tool calls this run: ${calls}`,
    `Streaming output chars: ${outputChars}`,
    `Thresholds: repeat=${options.maxRepeatedCalls}, cycle repeats=${options.minCycleRepetitions}, total=${options.maxTotalCalls}, phrase repeats=${options.maxRepeatedPhrases}`,
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
