import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSafeCommand, extractPlan } from "./utils.ts";

export default function planMode(pi: ExtensionAPI) {
  let enabled = false;
  let plan: string[] = [];

  pi.registerFlag("plan", {
    description: "Start in read-only plan mode",
    type: "boolean",
    default: false,
  });

  const setMode = (value: boolean, ctx: any) => {
    enabled = value;
    if (enabled) {
      pi.setActiveTools(["read", "bash", "grep", "find", "ls"]);
      ctx.ui.notify("Plan mode enabled: write tools are disabled.", "info");
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", " plan"));
    } else {
      pi.setActiveTools(["read", "bash", "edit", "write", "grep", "find", "ls"]);
      ctx.ui.notify("Plan mode disabled: full tools restored.", "info");
      ctx.ui.setStatus("plan-mode", undefined);
    }
  };

  pi.registerCommand("plan", {
    description: "Toggle read-only plan mode",
    handler: async (_args, ctx) => setMode(!enabled, ctx),
  });

  pi.registerCommand("todos", {
    description: "Show the current plan",
    handler: async (_args, ctx) => {
      if (plan.length === 0) return ctx.ui.notify("No plan found.", "info");
      ctx.ui.notify(plan.map((step, i) => `${i + 1}. ${step}`).join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("plan") === true) setMode(true, ctx);
  });

  pi.on("before_agent_start", async () => {
    if (!enabled) return;
    return {
      message: {
        customType: "pi-agent-config-plan-mode",
        display: false,
        content: [
          "[PLAN MODE ACTIVE]",
          "You are in read-only planning mode.",
          "Inspect the repository, but do not modify files or run mutating commands.",
          "Return a detailed numbered plan under a `Plan:` heading.",
        ].join("\n"),
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

  pi.on("agent_end", async (event) => {
    if (!enabled) return;
    const text = event.messages
      .filter((message: any) => message.role === "assistant")
      .flatMap((message: any) => message.content ?? [])
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n");
    const extracted = extractPlan(text);
    if (extracted.length > 0) plan = extracted;
  });
}
