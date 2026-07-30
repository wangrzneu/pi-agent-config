import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  classifyWorkWithModel,
  type WorkClassification,
} from "./model-classifier.ts";
import { isPlanModeActive } from "./plan-mode-state.ts";
import {
  WORK_TYPE_LABELS,
  describeToolActivity,
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

type ClassifyWork = typeof classifyWorkWithModel;

export default function workStatus(pi: ExtensionAPI) {
  registerWorkStatus(pi, classifyWorkWithModel);
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
