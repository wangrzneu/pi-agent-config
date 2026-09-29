/**
 * Workflow routing: map a System One intent decision to a concrete, low-risk
 * workflow hint.
 *
 * Routing is a *behavior preference*, not a hard constraint (see the README
 * design principles). It never blocks tools and never widens permissions; it
 * only suggests which on-demand prompt to follow and whether to plan first. The
 * mapping is pure and deterministic, so it is cheap to test and audit.
 */

import type { ChoiceQuestion } from "./types.ts";

/** Versioned schema id: bump when the options or semantics change. */
export const WORKFLOW_SCHEMA = "pi.workflow_intent.v1";

/** Upper bound on state characters sent for any decision request. */
export const MAX_STATE_CHARACTERS = 6_000;

/**
 * Intents mirror the work-status taxonomy so both extensions describe the same
 * task in the same words.
 */
export const WORKFLOW_INTENTS = [
  "design",
  "plan",
  "implement",
  "test",
  "review",
  "fix",
  "explore",
] as const;

export type WorkflowIntent = (typeof WORKFLOW_INTENTS)[number];

/**
 * The `pi.workflow_intent.v1` choice question sent to System One. Intents mirror
 * the work-status taxonomy so both extensions describe the task in the same words.
 */
export const WORKFLOW_QUESTION: ChoiceQuestion = {
  id: WORKFLOW_SCHEMA,
  instructions:
    "Classify the developer's current task by its dominant intent, not by individual keywords.",
  criteria: {
    design: "Designing or reshaping an API, interface, data model, or architecture.",
    plan: "Planning or sequencing work before making changes.",
    implement: "Writing new functionality or code.",
    test: "Writing or running tests, or validating behavior.",
    review: "Reviewing, auditing, or judging existing code or a change.",
    fix: "Diagnosing and fixing a bug, failure, or regression.",
    explore: "Reading, searching, or understanding code with no changes yet.",
  },
};

/**
 * Below this calibrated confidence the router stays silent. Set from
 * `npm run calibrate` (intent was 7/7 with every answer at >= 0.8, so the exact
 * value is not sensitive; 0.5 gives the intended decision more room to act).
 */
export const DEFAULT_ROUTING_THRESHOLD = 0.5;

export interface WorkflowRoute {
  intent: WorkflowIntent;
  /** On-demand prompt under `prompts/` to reference, when one applies. */
  prompt?: "architecture" | "debugging" | "review-first";
  /** Suggest read-only planning before changing files. */
  suggestsPlan: boolean;
}

const ROUTES: Record<WorkflowIntent, Omit<WorkflowRoute, "intent">> = {
  design: { prompt: "architecture", suggestsPlan: true },
  plan: { suggestsPlan: true },
  implement: { suggestsPlan: false },
  test: { suggestsPlan: false },
  review: { prompt: "review-first", suggestsPlan: false },
  fix: { prompt: "debugging", suggestsPlan: false },
  explore: { suggestsPlan: false },
};

export function isWorkflowIntent(value: unknown): value is WorkflowIntent {
  return (
    typeof value === "string" &&
    (WORKFLOW_INTENTS as readonly string[]).includes(value)
  );
}

/**
 * Resolve a route from a raw decision. Returns `undefined` for an unknown
 * intent or a confidence below `threshold`, so callers fail open (do nothing).
 */
export function resolveWorkflowRoute(
  choice: string,
  confidence: number,
  threshold: number = DEFAULT_ROUTING_THRESHOLD,
): WorkflowRoute | undefined {
  if (!isWorkflowIntent(choice)) return undefined;
  if (!Number.isFinite(confidence) || confidence < threshold) return undefined;
  return { intent: choice, ...ROUTES[choice] };
}

/** Render the hidden hint injected before the agent starts. */
export function renderWorkflowHint(route: WorkflowRoute): string {
  const parts = [`[WORKFLOW] Detected intent: ${route.intent}.`];
  if (route.suggestsPlan) {
    parts.push("Prefer read-only inspection and a numbered plan before editing.");
  }
  if (route.prompt) {
    parts.push(`Read prompts/${route.prompt}.md and follow it for this task.`);
  }
  return parts.join(" ");
}
