import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isWorkflowIntent } from "../system-one/routing.ts";
import { getWorkflowService } from "../system-one/service.ts";
import type { DecisionResult } from "../system-one/types.ts";
import {
  classifyWorkWithModel,
  type WorkClassification,
} from "./model-classifier.ts";
import { isPlanModeActive } from "./plan-mode-state.ts";
import {
  WORK_TYPE_LABELS,
  describeToolActivity,
  summarizeWork,
  type WorkActivity,
  type WorkType,
} from "./work-status.ts";

const STATUS_KEY = "work-status";
const TYPE_COLORS: Record<WorkType, string> = {
  design: "accent",
  plan: "warning",
  implement: "accent",
  test: "success",
  review: "warning",
  fix: "error",
  explore: "muted",
};

interface CurrentWork {
  type: WorkType;
  summary: string;
}

type ClassifyWork = (
  prompt: string,
  ctx: ExtensionContext,
) => Promise<WorkClassification | undefined>;

export default function workStatus(pi: ExtensionAPI) {
  registerWorkStatus(pi, classifyWorkPreferringSystemOne);
}

export interface WorkClassifierDeps {
  decideIntent: (
    prompt: string,
    signal?: AbortSignal,
  ) => Promise<DecisionResult | undefined>;
  fallback: ClassifyWork;
}

/**
 * Prefer the shared System One decision for the work type; fall back to the
 * model classifier when System One is off or unavailable. The summary is
 * derived deterministically from the prompt because System One Models return
 * structured values, not generated text.
 */
export async function classifyWorkPreferringSystemOne(
  prompt: string,
  ctx: ExtensionContext,
  deps: WorkClassifierDeps = {
    decideIntent: (text, signal) => getWorkflowService().decideIntent(text, signal),
    fallback: classifyWorkWithModel,
  },
): Promise<WorkClassification | undefined> {
  const decision = await deps.decideIntent(prompt, ctx.signal);
  if (decision && isWorkflowIntent(decision.choice)) {
    return { type: decision.choice, summary: summarizeWork(prompt) };
  }
  return deps.fallback(prompt, ctx);
}

export function registerWorkStatus(
  pi: ExtensionAPI,
  classifyWork: ClassifyWork,
) {
  let current: CurrentWork | undefined;
  const activeTools = new Map<string, WorkActivity>();

  const render = (ctx: any, activity?: WorkActivity) => {
    if (!ctx.hasUI || !current) return;

    const type = current.type;
    const label = WORK_TYPE_LABELS[type];
    const status =
      ctx.ui.theme.fg(TYPE_COLORS[type], ` ${label}`) +
      ctx.ui.theme.fg("dim", ` · ${current.summary}`);

    ctx.ui.setStatus(STATUS_KEY, status);
    ctx.ui.setWorkingMessage(
      `${label} · ${activity?.detail ?? current.summary}`,
    );
  };

  const clear = (ctx: any) => {
    activeTools.clear();
    current = undefined;
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWorkingMessage();
  };

  pi.on("before_agent_start", async (event, ctx) => {
    clear(ctx);
    if (ctx.mode !== "tui") return;

    const prompt = String(event.prompt ?? "");
    const classification: WorkClassification | undefined =
      await classifyWork(prompt, ctx);
    if (!classification) return;

    current = {
      type: isPlanModeActive() ? "plan" : classification.type,
      summary: classification.summary,
    };
    render(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!current) return;

    const args = (event.args ?? {}) as Record<string, unknown>;
    const activity = {
      detail: describeToolActivity(event.toolName, args),
    };
    activeTools.set(event.toolCallId, activity);
    render(ctx, activity);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!current) return;

    activeTools.delete(event.toolCallId);
    const remaining = Array.from(activeTools.values()).at(-1);
    render(ctx, remaining);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    clear(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clear(ctx);
  });
}
