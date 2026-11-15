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
  MAX_STATE_CHARACTERS,
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
  pi.on("session_start", (_event, ctx) => {
    const service = configureWorkflowService(ctx.modelRegistry);
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
    return hint ? hintMessage(resolvePromptHint(pi, hint)) : undefined;
  });

  // Workflow hints are persisted as custom messages. Keep only the newest one
  // so a long session does not accumulate stale intent instructions.
  pi.on("context", async (event) => {
    let newestHint = -1;
    event.messages.forEach((message, index) => {
      if (isWorkflowHint(message)) newestHint = index;
    });
    if (newestHint < 0) return undefined;

    const messages = event.messages.filter(
      (message, index) => !isWorkflowHint(message) || index === newestHint,
    );
    return messages.length === event.messages.length ? undefined : { messages };
  });

  pi.registerCommand("system-one", {
    description: "System One decisions: status, on, off",
    getArgumentCompletions(prefix) {
      const items = ["on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const service = getService();
      const action = args.trim().split(/\s+/)[0] ?? "";
      if (action === "on" || action === "off") {
        service.setEnabled(action === "on");
        ctx.ui.notify(
          `System One decisions ${action === "on" ? "enabled" : "disabled"}.`,
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
  let pending: string[] = [];

  pi.on("before_agent_start", () => {
    // Drop a stale change from an aborted turn.
    pending = [];
  });

  pi.on("tool_call", async (event) => {
    if (!RISK_TOOL_NAMES.has(event.toolName)) return undefined;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const state = buildChangeState(event.toolName, input);
    if (state) {
      pending.push(state);
      if (pending.length > 8) pending.shift();
    }
    return undefined;
  });

  pi.on("context", async (event, ctx) => {
    if (pending.length === 0) return undefined;
    const changes = pending;
    pending = [];
    // One decision per model request. Parallel edits are combined and bounded
    // instead of overwriting each other or issuing one request per edit.
    const state = changes.join("\n\n---\n\n").slice(0, MAX_STATE_CHARACTERS);

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
    `System One decisions: ${enabled ? "on" : "off"}`,
    `Configured: ${status.configured ? "yes" : "no"}`,
  ];
  if (status.provider) lines.push(`Provider: ${status.provider}`);
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
    namespace: {
      name: "system-one",
      description: "Calibrated System One decisions",
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
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
      const service = getService();
      const candidates = dedupeCandidates(params.candidates);
      if (candidates.length === 0) {
        return {
          content: [{ type: "text", text: "No candidate paths were provided." }],
          details: { enabled: service.isEnabled(), selected: 0, total: 0 },
        };
      }

      if (!service.isEnabled()) {
        return {
          content: [
            {
              type: "text",
              text: "System One is disabled. Run /system-one on to enable it.",
            },
          ],
          details: { enabled: false, selected: 0, total: candidates.length },
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
          details: { enabled: false, selected: 0, total: candidates.length },
        };
      }

      const selection = selectRelevant(candidates, probabilities, {
        threshold: params.min_probability ?? service.threshold("context"),
        maxSelected: params.max_results,
      });
      return {
        content: [{ type: "text", text: formatContextResult(selection) }],
        details: {
          enabled: true,
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
 *
 * `agent_before_settle` is Pi's final actionable boundary. Returning a
 * `custom_message` draft with `continue: true` starts exactly one follow-up
 * request without re-entering the agent loop from a timer.
 */
export function registerCompletionCheck(
  pi: ExtensionAPI,
  getService: () => WorkflowService,
): void {
  let mutated = false;
  let checked = false;

  // A genuine user prompt resets the budget. Extension-authored messages,
  // including the self-check continuation, must not reset it and cause a loop.
  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") {
      mutated = false;
      checked = false;
    }
  });

  pi.on("tool_call", async (event) => {
    if (RISK_TOOL_NAMES.has(event.toolName)) mutated = true;
    return undefined;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!mutated || checked) return undefined;
    if (event.outcome !== "completed") return undefined;
    checked = true;

    if (!event.context.canContinue) return undefined;
    const state = buildCompletionState(
      event.context.llmMessages ?? event.context.contextMessages,
    );
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

    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: SELF_CHECK_CUSTOM_TYPE,
          content: renderCompletionHint(policy),
          display: false,
        },
      ],
      continue: true,
    };
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

function isWorkflowHint(message: unknown): boolean {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as Record<string, unknown>).customType === HINT_CUSTOM_TYPE,
  );
}

/**
 * Resolve `prompts/<name>.md` to the installed prompt-template path. The
 * relative path is ambiguous when the package is installed globally; Pi's
 * command registry already knows the real path.
 */
function resolvePromptHint(pi: ExtensionAPI, hint: string): string {
  const match = hint.match(/prompts\/([a-z0-9-]+)\.md/i);
  if (!match || typeof pi.getCommands !== "function") return hint;
  const name = match[1];
  const command = pi.getCommands().find(
    (candidate) => candidate.name === name && candidate.source === "prompt",
  );
  return command
    ? hint.replace(`prompts/${name}.md`, command.sourceInfo.path)
    : hint;
}
