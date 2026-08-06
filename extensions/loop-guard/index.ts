import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_LOOP_OPTIONS,
  LoopDetector,
  type LoopDetection,
  type LoopDetectOptions,
  type ToolCallRecord,
} from "./loop-detector.ts";

type LoopGuardMode = "on" | "off";

/**
 * Loop guard: watches tool calls inside one agent run and, when the model
 * starts repeating the same tool call over and over (an agent loop that never
 * finishes), asks the user whether to abort the run — or aborts directly when
 * no interactive UI is available so a print/RPC run cannot hang forever.
 *
 * See https://github.com/QwenLM/qwen-code/issues/4055 for the class of
 * problem this addresses: an agent stuck cycling through tool calls with no
 * way for the user to interrupt it.
 */
export function registerLoopGuardExtension(
  pi: ExtensionAPI,
  options: LoopDetectOptions = {},
): void {
  const detector = new LoopDetector(options);
  const effective = { ...DEFAULT_LOOP_OPTIONS, ...options };
  let mode: LoopGuardMode = "on";
  let snoozed = false;
  let lastDetection: LoopDetection = { kind: "none" };

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
        detector.reset();
        ctx.ui.notify("Loop guard enabled.", "info");
        return;
      }
      if (action === "reset") {
        detector.reset();
        ctx.ui.notify("Loop guard counters reset.", "info");
        return;
      }
      ctx.ui.notify(formatState(mode, detector.callCount, lastDetection, effective), "info");
    },
  });

  pi.on("agent_start", () => {
    detector.reset();
    snoozed = false;
    lastDetection = { kind: "none" };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "off" || snoozed) return;
    const call: ToolCallRecord = {
      tool: event.toolName,
      input: serializeInput(event.input),
      callId: event.toolCallId,
    };
    const detection = detector.record(call);
    if (detection.kind === "none") return;
    lastDetection = detection;

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
  });
}

export default function loopGuardExtension(pi: ExtensionAPI): void {
  registerLoopGuardExtension(pi);
}

function describeLoop(detection: LoopDetection): string {
  switch (detection.kind) {
    case "repeat":
      return `The same tool call was repeated ${detection.count} times in a row: ${summarizeCall(detection.call)}`;
    case "cycle":
      return `An identical call sequence of period ${detection.period} repeated ${detection.repetitions} times: ${detection.sequence.map(summarizeCall).join(" then ")}`;
    case "total":
      return `The agent made ${detection.count} tool calls without completing the run.`;
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
  detection: LoopDetection,
  options: Required<LoopDetectOptions>,
): string {
  const detectionLine = detection.kind === "none"
    ? "No loop detected."
    : `${describeLoop(detection)}`;
  return [
    `Loop guard: ${mode}`,
    `Tool calls this run: ${calls}`,
    `Detected: ${detectionLine}`,
    `Thresholds: repeat=${options.maxRepeatedCalls}, cycle repeats=${options.minCycleRepetitions}, total=${options.maxTotalCalls}`,
  ].join("\n");
}

/** Stable JSON serialization with sorted object keys so argument reordering
 * cannot evade loop detection. */
function serializeInput(input: unknown): string {
  return JSON.stringify(sortKeys(input));
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


