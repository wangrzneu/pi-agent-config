import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setPlanModeActive } from "../work-status/plan-mode-state.ts";
import { isSafeCommand, extractPlan } from "./utils.ts";

const WRITE_TOOL_NAMES = new Set(["edit", "write"]);
const STATE_TYPE = "plan-mode";
const WIDGET_KEY = "plan-todos";

interface PlanModeState {
  enabled: boolean;
  plan: string[];
  writeToolsBefore?: string[];
}

export default function planMode(pi: ExtensionAPI) {
  let enabled = false;
  let needsReminder = false;
  let writeToolsBefore: string[] = [];
  let plan: string[] = [];

  pi.registerFlag("plan", {
    description: "Start in read-only plan mode",
    type: "boolean",
    default: false,
  });

  const persist = (): void => {
    pi.appendEntry?.(STATE_TYPE, {
      enabled,
      plan,
      writeToolsBefore,
    } satisfies PlanModeState);
  };

  const render = (ctx: ExtensionContext): void => {
    if (ctx.hasUI === false) return;

    ctx.ui.setStatus(
      "plan-mode",
      enabled ? ctx.ui.theme.fg("warning", " plan") : undefined,
    );
    if (typeof ctx.ui.setWidget !== "function") return;
    ctx.ui.setWidget(
      WIDGET_KEY,
      plan.length > 0
        ? plan.map((step, index) => `${index + 1}. ${step}`)
        : undefined,
    );
  };

  const setMode = (
    value: boolean,
    ctx: ExtensionContext,
    options: { persist?: boolean } = {},
  ): void => {
    if (value === enabled) return;

    enabled = value;
    setPlanModeActive(value);
    needsReminder = value;

    if (enabled) {
      // Keep every non-write tool. Filtering to a fixed read-only allowlist
      // would also remove sandbox authorization, context selection, and other
      // read-only extension tools.
      const active = pi.getActiveTools();
      writeToolsBefore = active.filter((name) => WRITE_TOOL_NAMES.has(name));
      pi.setActiveTools(active.filter((name) => !WRITE_TOOL_NAMES.has(name)));
      ctx.ui.notify("Plan mode enabled: write tools are disabled.", "info");
    } else {
      // Restore only the write tools that were active on entry. Tools enabled
      // while plan mode was active stay active.
      const active = pi.getActiveTools();
      pi.setActiveTools([...new Set([...active, ...writeToolsBefore])]);
      writeToolsBefore = [];
      ctx.ui.notify("Plan mode disabled: write tools restored.", "info");
    }

    render(ctx);
    if (options.persist !== false) persist();
  };

  pi.registerCommand("plan", {
    description: "Toggle read-only plan mode",
    handler: async (_args, ctx) => setMode(!enabled, ctx),
  });

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle read-only plan mode",
    handler: async (ctx) => setMode(!enabled, ctx),
  });

  pi.registerCommand("todos", {
    description: "Show the current plan",
    handler: async (_args, ctx) => {
      if (plan.length === 0) return ctx.ui.notify("No plan found.", "info");
      ctx.ui.notify(plan.map((step, i) => `${i + 1}. ${step}`).join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const saved = entries
      .filter(
        (entry) =>
          entry.type === "custom" && (entry as { customType?: string }).customType === STATE_TYPE,
      )
      .pop() as { data?: Partial<PlanModeState> } | undefined;

    if (saved?.data) {
      plan = Array.isArray(saved.data.plan)
        ? saved.data.plan.filter((step): step is string => typeof step === "string")
        : [];
      const savedWriteTools = Array.isArray(saved.data.writeToolsBefore)
        ? saved.data.writeToolsBefore.filter((name): name is string => typeof name === "string")
        : [];
      if (saved.data.enabled === true) {
        setMode(true, ctx, { persist: false });
        // The saved set is authoritative for a resumed plan-mode session.
        if (savedWriteTools.length > 0) writeToolsBefore = savedWriteTools;
      }
    }
    if (pi.getFlag("plan") === true) setMode(true, ctx);
    render(ctx);
  });

  pi.on("before_agent_start", async () => {
    if (!enabled || !needsReminder) return;
    needsReminder = false;
    return {
      message: {
        customType: "pi-agent-config-plan-mode",
        display: false,
        content: "[PLAN] Read-only. Inspect only; return a numbered plan under Plan:.",
      },
    };
  });

  pi.on("tool_call", async (event) => {
    if (!enabled) return;
    if (event.toolName === "edit" || event.toolName === "write") {
      return { block: true, reason: "Plan mode is read-only." };
    }
    if (event.toolName === "bash" && !isSafeCommand(String(event.input.command ?? ""))) {
      return { block: true, reason: "This bash command is not allowed in plan mode." };
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled) return;
    const text = (event.messages ?? [])
      .filter((message: any) => message.role === "assistant")
      .flatMap((message: any) => message.content ?? [])
      .filter((block: any) => block.type === "text" || block.type === "thinking")
      .map((block: any) => block.text ?? block.thinking ?? "")
      .join("\n");
    const extracted = extractPlan(text);
    if (extracted.length === 0) return;
    if (extracted.join("\n") === plan.join("\n")) return;
    plan = extracted;
    persist();
    render(ctx);
  });

  pi.on("session_shutdown", async () => {
    setPlanModeActive(false);
  });
}
