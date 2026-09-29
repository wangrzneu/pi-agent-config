/**
 * Process-wide System One decision service.
 *
 * Workflow routing (`system-one`) and the TUI footer (`work-status`) need the
 * same intent decision for a prompt. This module owns one client and one result
 * cache, so a prompt is decided at most once per session, and configuration is
 * re-resolved at session start. Extensions import `getWorkflowService()`; tests
 * build a service directly with `createWorkflowService`.
 *
 * All three decisions are `choice` questions (the primitive that returns a
 * calibrated `confidence`) sent to `POST /v1/systemone`.
 */

import { createHash } from "node:crypto";
import { createHttpSystemOneClient } from "./client.ts";
import { readSystemOneConfig, SYSTEM_ONE_DEFAULTS } from "./config.ts";
import { MAX_STATE_CHARACTERS, WORKFLOW_QUESTION } from "./routing.ts";
import { RISK_QUESTION } from "./risk.ts";
import { COMPLETION_QUESTION } from "./completion.ts";
import type { ChoiceQuestion, DecisionKind, DecisionResult, SystemOneClient } from "./types.ts";

const CACHE_ENTRIES = 128;

export interface WorkflowServiceStatus {
  configured: boolean;
  endpoint?: string;
  model?: string;
}

export interface WorkflowService {
  /** Decide the workflow intent, cached by prompt text. `undefined` = fail open. */
  decideIntent(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<DecisionResult | undefined>;
  /** Assess change risk for a proposed edit, cached by change text. */
  assessChangeRisk(
    state: string,
    signal?: AbortSignal,
  ): Promise<DecisionResult | undefined>;
  /** Assess whether a finished turn actually satisfied its request. */
  assessCompletion(
    state: string,
    signal?: AbortSignal,
  ): Promise<DecisionResult | undefined>;
  /** Minimum confidence for one decision before its caller acts. */
  threshold(decision: DecisionKind): number;
  status(): WorkflowServiceStatus;
  isEnabled(): boolean;
  setEnabled(value: boolean): void;
}

export interface WorkflowServiceOptions {
  /** Resolve the current client; `undefined` means "not configured". */
  getClient: () => SystemOneClient | undefined;
  /** Current confidence threshold per decision; defaults to the built-in defaults. */
  getThreshold?: (decision: DecisionKind) => number;
  /** Configuration summary for `/system-one status`. Never includes secrets. */
  getStatus?: () => WorkflowServiceStatus;
  /** Initial enabled state; defaults to true. */
  enabled?: boolean;
}

export function createWorkflowService(
  options: WorkflowServiceOptions,
): WorkflowService {
  const cache = new Map<string, DecisionResult>();
  let enabled = options.enabled ?? true;

  const decide = async (
    question: ChoiceQuestion,
    state: string,
    signal?: AbortSignal,
  ): Promise<DecisionResult | undefined> => {
    if (!enabled) return undefined;

    const trimmed = state.trim();
    const client = options.getClient();
    if (!client || !trimmed) return undefined;

    // Cache per (question id, state) so decision types never collide.
    const key = createHash("sha256")
      .update(`${question.id}\n${trimmed}`)
      .digest("hex");
    const cached = cache.get(key);
    if (cached) return cached;

    const decision = await client.decide(
      { question, state: trimmed, maxStateCharacters: MAX_STATE_CHARACTERS },
      signal,
    );
    if (!decision) return undefined;

    if (cache.size >= CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, decision);
    return decision;
  };

  return {
    decideIntent: (prompt, signal) => decide(WORKFLOW_QUESTION, prompt, signal),
    assessChangeRisk: (state, signal) => decide(RISK_QUESTION, state, signal),
    assessCompletion: (state, signal) =>
      decide(COMPLETION_QUESTION, state, signal),
    threshold: (decision) =>
      options.getThreshold?.(decision) ?? SYSTEM_ONE_DEFAULTS.thresholds[decision],
    status: () => options.getStatus?.() ?? { configured: false },
    isEnabled: () => enabled,
    setEnabled: (value) => {
      enabled = value;
    },
  };
}

// --- Process-wide singleton -------------------------------------------------

let singleton: WorkflowService | undefined;

/** Rebuild the shared service from the current environment. */
export function configureWorkflowService(): WorkflowService {
  const config = readSystemOneConfig();
  const client = config ? createHttpSystemOneClient(config) : undefined;
  singleton = createWorkflowService({
    getClient: () => client,
    getThreshold: (decision) =>
      config?.thresholds[decision] ?? SYSTEM_ONE_DEFAULTS.thresholds[decision],
    getStatus: () => ({
      configured: Boolean(config),
      endpoint: config?.baseUrl,
      model: config?.model,
    }),
  });
  return singleton;
}

/** Lazily build and return the shared service. */
export function getWorkflowService(): WorkflowService {
  return singleton ?? configureWorkflowService();
}

/** Test seam: drop the singleton so the next call rebuilds it. */
export function resetWorkflowService(): void {
  singleton = undefined;
}
