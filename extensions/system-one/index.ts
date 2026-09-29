/**
 * System One workflow routing extension.
 *
 * Uses a System One Model (structured, calibrated decisions) to pick the right
 * coding workflow before the agent starts, then injects a hidden hint pointing
 * at the matching on-demand prompt. The decision is shared with work-status via
 * `service.ts`, so a prompt is decided at most once per session. Configuration
 * is re-resolved at session start, and `/system-one on|off` toggles routing at
 * runtime. Every failure path is fail-open (no hint, no error).
 *
 * See `docs/system-one.md`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  formatContextResult,
  MAX_CONTEXT_CANDIDATES,
  selectRelevant,
  type ContextCandidate,
} from "./context.ts";
import {
  renderWorkflowHint,
  resolveWorkflowRoute,
} from "./routing.ts";
import { buildChangeState, renderRiskHint, resolveRiskPolicy } from "./risk.ts";
import {
  buildCompletionState,
  renderCompletionHint,
  resolveCompletionPolicy,
} from "./completion.ts";
import {
  configureWorkflowService,
  getWorkflowService,
  type WorkflowService,
  type WorkflowServiceStatus,
} from "./service.ts";
import type { DecisionResult, DecisionKind } from "./types.ts";

export const HINT_CUSTOM_TYPE = "pi-agent-config-workflow-route";
export const RISK_CUSTOM_TYPE = "pi-agent-config-change-risk";
export const SELF_CHECK_CUSTOM_TYPE = "pi-agent-config-self-check";

const RISK_TOOL_NAMES = new Set(["edit", "write"]);

export default function systemOne(pi: ExtensionAPI) {
  // Re-resolve configuration at session start so env changes apply without a
  // full process restart (matches the external-memory convention). The context
  // tool is only offered once System One is configured.
  pi.on("session_start", () => {
    const service = configureWorkflowService();
    if (service.status().configured) registerContextTool(pi, getWorkflowService);
  });
  registerWorkflowRouting(pi, getWorkflowService);
  registerChangeRisk(pi, getWorkflowService);
  registerCompletionCheck(pi, getWorkflowService);
}

/** Turn a raw decision into a hidden hint, or `undefined` to stay silent. */
export function toWorkflowHint(
  decision: DecisionResult | undefined,
  threshold: number,
): string | undefined {
  if (!decision) return undefined;
  const route = resolveWorkflowRoute(
    decision.choice,
    decision.confidence,
    threshold,
  );
  return route ? renderWorkflowHint(route) : undefined;
}

export function registerWorkflowRouting(
  pi: ExtensionAPI,
  getService: () => WorkflowService,
): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = String(event.prompt ?? "").trim();
    if (!prompt) return undefined;

    const service = getService();
    const decision = await service.decideIntent(prompt, ctx?.signal);
    const hint = toWorkflowHint(decision, service.threshold("intent"));
    return hint ? hintMessage(hint) : undefined;
  });

  pi.registerCommand("system-one", {
    description: "System One workflow routing: status, on, off",
    handler: async (args, ctx) => {
      const service = getService();
      const action = args.trim().split(/\s+/)[0] ?? "";
      if (action === "on" || action === "off") {
        service.setEnabled(action === "on");
        ctx.ui.notify(
          `System One routing ${action === "on" ? "enabled" : "disabled"}.`,
          "info",
        );
        return;
      }
      ctx.ui.notify(
        renderStatus(service.isEnabled(), service.status(), {
          intent: service.threshold("intent"),
          risk: service.threshold("risk"),
          completion: service.threshold("completion"),
          context: service.threshold("context"),
        }),
        "info",
      );
    },
  });
}

/**
 * Triage each proposed `edit`/`write` and, when the change looks risky (or the
 * assessment is uncertain), inject a hidden review hint before the next LLM
 * call. Hard constraints stay in interceptors; this only escalates attention.
 */
export function registerChangeRisk(
  pi: ExtensionAPI,
  getService: () => WorkflowService,
): void {
  let pending: string | undefined;

  pi.on("tool_call", async (event) => {
    if (!RISK_TOOL_NAMES.has(event.toolName)) return undefined;
    const input = (event.input ?? {}) as Record<string, unknown>;
    pending = buildChangeState(event.toolName, input) || undefined;
    return undefined;
  });

  pi.on("context", async (event, ctx) => {
    const state = pending;
    pending = undefined;
    if (!state) return undefined;

    const service = getService();
    const decision = await service.assessChangeRisk(state, ctx?.signal);
    if (!decision) return undefined;

    const policy = resolveRiskPolicy(
      decision.choice,
      decision.confidence,
      service.threshold("risk"),
    );
    if (!policy?.escalate) return undefined;

    return {
      messages: [
        ...event.messages,
        {
          role: "custom" as const,
          customType: RISK_CUSTOM_TYPE,
          content: renderRiskHint(policy),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
}

function renderStatus(
  enabled: boolean,
  status: WorkflowServiceStatus,
  thresholds: Record<DecisionKind, number>,
): string {
  const lines = [
    `System One routing: ${enabled ? "on" : "off"}`,
    `Configured: ${status.configured ? "yes" : "no"}`,
  ];
  if (status.endpoint) lines.push(`Endpoint: ${status.endpoint}`);
  if (status.model) lines.push(`Model: ${status.model}`);
  lines.push(
    `Thresholds: intent ${thresholds.intent.toFixed(2)} | risk ${thresholds.risk.toFixed(2)} | completion ${thresholds.completion.toFixed(2)} | context ${thresholds.context.toFixed(2)}`,
  );
  return lines.join("\n");
}

/**
 * Offer a `context_select` tool that ranks candidate files by relevance to a
 * task. Only registered when System One is configured. The tool ranks; it does
 * not read files or change access.
 */
export function registerContextTool(
  pi: ExtensionAPI,
  getService: () => WorkflowService,
): void {
  pi.registerTool({
    name: "context_select",
    label: "Select relevant context",
    description:
      "Rank candidate files by relevance to a task using System One, so you can read the most relevant ones first. Use it after a broad find/grep returns more candidates than you want to read.",
    promptSnippet: "Rank candidate files by relevance to the current task",
    parameters: Type.Object({
      task: Type.String({ description: "What you are trying to accomplish" }),
      candidates: Type.Array(Type.String(), {
        description: "Candidate file paths to rank",
        maxItems: MAX_CONTEXT_CANDIDATES,
      }),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      min_probability: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    }),
    async execute(_toolCallId, params, signal) {
      const candidates = dedupeCandidates(params.candidates);
      if (candidates.length === 0) {
        return {
          content: [{ type: "text", text: "No candidate paths were provided." }],
          details: { selected: 0, total: 0 },
        };
      }

      const service = getService();
      if (!service.isEnabled()) {
        return {
          content: [
            {
              type: "text",
              text: "System One is disabled. Run /system-one on to enable it.",
            },
          ],
          details: { enabled: false },
        };
      }

      const probabilities = await service.rankContext(
        params.task,
        candidates,
        signal,
      );
      if (!probabilities) {
        return {
          content: [
            {
              type: "text",
              text: "System One is unavailable; rank the candidates manually.",
            },
          ],
          details: { enabled: false },
        };
      }

      const selection = selectRelevant(candidates, probabilities, {
        threshold: params.min_probability ?? service.threshold("context"),
        maxSelected: params.max_results,
      });
      return {
        content: [{ type: "text", text: formatContextResult(selection) }],
        details: {
          selected: selection.selected.length,
          total: candidates.length,
        },
      };
    },
  });
}

function dedupeCandidates(paths: readonly string[]): ContextCandidate[] {
  const seen = new Set<string>();
  const candidates: ContextCandidate[] = [];
  for (const raw of paths) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    candidates.push({ id });
    if (candidates.length >= MAX_CONTEXT_CANDIDATES) break;
  }
  return candidates;
}

/**
 * After a turn that changed files, ask whether the request is actually
 * satisfied and verified. A `verified` answer does nothing; anything else
 * starts one more pass with a hidden verification hint. Runs at most once per
 * user turn.
 */
export function registerCompletionCheck(
  pi: ExtensionAPI,
  getService: () => WorkflowService,
  options: { schedule?: (task: () => void) => void } = {},
): void {
  const schedule =
    options.schedule ??
    ((task: () => void) => {
      setTimeout(task, 0);
    });
  let mutated = false;
  let checked = false;

  // A genuine user prompt resets the budget; a self-check pass does not emit
  // before_agent_start, so this cannot loop.
  pi.on("before_agent_start", () => {
    mutated = false;
    checked = false;
  });

  pi.on("tool_call", async (event) => {
    if (RISK_TOOL_NAMES.has(event.toolName)) mutated = true;
    return undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!mutated || checked) return undefined;
    checked = true;

    const state = buildCompletionState(event.messages);
    if (!state) return undefined;

    const service = getService();
    const decision = await service.assessCompletion(state, ctx?.signal);
    if (!decision) return undefined;

    const policy = resolveCompletionPolicy(
      decision.choice,
      decision.confidence,
      service.threshold("completion"),
    );
    if (!policy?.escalate) return undefined;

    const hint = renderCompletionHint(policy);
    // Defer past the agent loop so we never re-enter it from inside agent_end.
    schedule(() => {
      void pi.sendMessage(
        { customType: SELF_CHECK_CUSTOM_TYPE, content: hint, display: false },
        { triggerTurn: true },
      );
    });
    return undefined;
  });
}

function hintMessage(content: string) {
  return {
    message: {
      customType: HINT_CUSTOM_TYPE,
      display: false,
      content,
    },
  };
}
