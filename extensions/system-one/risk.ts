/**
 * Change-risk triage: a System One decision over a proposed edit.
 *
 * The model answers one calibrated question — how risky is this change? — and
 * the *policy* is deterministic code (`resolveRiskPolicy`). Unlike workflow
 * routing, this axis is **fail-safe**: routing does nothing when uncertain, but
 * an uncertain risk assessment escalates to at least medium so a dubious change
 * gets more scrutiny. It never blocks tools and never widens permissions.
 */

import { MAX_STATE_CHARACTERS } from "./routing.ts";
import type { ChoiceQuestion } from "./types.ts";

/** Versioned schema id: bump when the options or semantics change. */
export const RISK_SCHEMA = "pi.change_risk.v1";

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** The `pi.change_risk.v1` choice question sent to System One. */
export const RISK_QUESTION: ChoiceQuestion = {
  id: RISK_SCHEMA,
  instructions:
    "Assess how risky it is to apply this proposed code change. Weigh blast radius and whether it touches sensitive areas such as authentication, authorization, money, concurrency, persistence/migrations, or public contracts.",
  criteria: {
    low: "Localized, easily reversible change with little or no blast radius.",
    medium:
      "Change with meaningful blast radius, or behavior whose correctness is uncertain.",
    high: "Touches authentication, authorization, money, concurrency, persistence/migrations, or public contracts, or has a large blast radius.",
  },
};

/**
 * Below this confidence an assessment is treated as uncertain (fail-safe).
 * Calibrated at 0.6: the one mislabelled risk case scored 0.51, so 0.6 pushes
 * it into "uncertain" and escalates instead of staying silent.
 */
export const DEFAULT_RISK_THRESHOLD = 0.6;

export interface RiskPolicy {
  level: RiskLevel;
  /** Surface a review hint before further edits. */
  escalate: boolean;
  /** Suggest read-only planning as part of the escalation. */
  suggestsPlan: boolean;
  /** The decision was below the confidence threshold. */
  uncertain: boolean;
}

export function isRiskLevel(value: unknown): value is RiskLevel {
  return (
    typeof value === "string" &&
    (RISK_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Map a risk decision to a policy. Unknown levels yield `undefined` (fail
 * open, like every other caller); a low-confidence answer escalates to medium
 * (fail safe).
 */
export function resolveRiskPolicy(
  level: string,
  confidence: number,
  threshold: number = DEFAULT_RISK_THRESHOLD,
): RiskPolicy | undefined {
  if (!isRiskLevel(level)) return undefined;

  if (!Number.isFinite(confidence) || confidence < threshold) {
    return { level: "medium", escalate: true, suggestsPlan: false, uncertain: true };
  }
  if (level === "high") {
    return { level, escalate: true, suggestsPlan: true, uncertain: false };
  }
  if (level === "medium") {
    return { level, escalate: true, suggestsPlan: false, uncertain: false };
  }
  return { level, escalate: false, suggestsPlan: false, uncertain: false };
}

/** Render the hidden hint injected before the next LLM call. */
export function renderRiskHint(policy: RiskPolicy): string {
  if (policy.uncertain) {
    return "[RISK] Change risk could not be assessed confidently. Treat it as medium risk: inspect the change and follow prompts/review-first.md before further edits.";
  }
  if (policy.suggestsPlan) {
    return "[RISK] Change classified as high risk. Pause before further edits: inspect the diff, run the relevant tests, and follow prompts/review-first.md.";
  }
  return "[RISK] Change classified as medium risk. Consider prompts/review-first.md before further edits.";
}

/**
 * Build a bounded, diff-like description of a proposed `edit`/`write` call.
 * Only the tool name, path, and changed text are included.
 */
export function buildChangeState(
  toolName: string,
  input: Record<string, unknown>,
  maxCharacters: number = MAX_STATE_CHARACTERS,
): string {
  const lines = [`tool: ${toolName}`];

  const path = firstString(input, ["path", "file_path", "filePath"]);
  if (path) lines.push(`path: ${path}`);

  const edits = Array.isArray(input.edits) ? input.edits : undefined;
  if (edits) {
    edits.forEach((edit, index) => {
      if (!edit || typeof edit !== "object") return;
      const entry = edit as Record<string, unknown>;
      const before = typeof entry.oldText === "string" ? entry.oldText : "";
      const after = typeof entry.newText === "string" ? entry.newText : "";
      lines.push(`@@ edit ${index + 1} @@`, `- ${before}`, `+ ${after}`);
    });
  } else if (
    typeof input.oldText === "string" &&
    typeof input.newText === "string"
  ) {
    lines.push("@@ edit @@", `- ${input.oldText}`, `+ ${input.newText}`);
  } else if (typeof input.content === "string") {
    lines.push("@@ content @@", input.content);
  }

  const state = lines.join("\n").trim();
  return state.length > maxCharacters ? state.slice(0, maxCharacters) : state;
}

function firstString(
  input: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
