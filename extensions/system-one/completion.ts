/**
 * Completion self-check: a System One decision over a finished agent turn.
 *
 * Before the agent settles, the model answers one calibrated question — is the
 * request actually satisfied and verified? — and deterministic code decides
 * whether to nudge the agent for another pass. Like change-risk triage this is
 * **fail-safe**: an uncertain answer escalates to a verification nudge. It only
 * adds a hidden message; it never blocks tools or edits output.
 */

import { MAX_STATE_CHARACTERS } from "./routing.ts";
import type { ChoiceQuestion } from "./types.ts";

/** Versioned schema id: bump when the options or semantics change. */
export const COMPLETION_SCHEMA = "pi.completion_check.v1";

export const COMPLETION_LEVELS = ["verified", "unverified", "incomplete"] as const;
export type CompletionLevel = (typeof COMPLETION_LEVELS)[number];

/** The `pi.completion_check.v1` choice question sent to System One. */
export const COMPLETION_QUESTION: ChoiceQuestion = {
  id: COMPLETION_SCHEMA,
  instructions:
    "Decide whether this agent turn satisfied the user's request, and whether it was verified.",
  criteria: {
    verified:
      'The request is fully addressed AND the turn reports an explicit verification result — the outcome of a test, build, or lint run (for example "npm test passed" or "the build succeeded").',
    unverified:
      "The request appears addressed, but the turn only describes the change without reporting a verification result.",
    incomplete:
      "The request is not fully addressed (for example, part of a multi-part request is missing).",
  },
};

/**
 * Below this confidence an assessment is treated as uncertain (fail-safe).
 * Calibration suggested 0.5, but lowering a fail-safe check makes it *more*
 * permissive (fewer verification passes), so 0.6 is kept deliberately.
 */
export const DEFAULT_COMPLETION_THRESHOLD = 0.6;

export interface CompletionPolicy {
  level: CompletionLevel;
  /** Trigger another pass with a verification hint. */
  escalate: boolean;
  /** The decision was below the confidence threshold. */
  uncertain: boolean;
}

export function isCompletionLevel(value: unknown): value is CompletionLevel {
  return (
    typeof value === "string" &&
    (COMPLETION_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Map a completion decision to a policy. Unknown levels yield `undefined` (fail
 * open); a low-confidence answer escalates to an `unverified` nudge (fail safe).
 */
export function resolveCompletionPolicy(
  level: string,
  confidence: number,
  threshold: number = DEFAULT_COMPLETION_THRESHOLD,
): CompletionPolicy | undefined {
  if (!isCompletionLevel(level)) return undefined;

  if (!Number.isFinite(confidence) || confidence < threshold) {
    return { level: "unverified", escalate: true, uncertain: true };
  }
  if (level === "verified") {
    return { level, escalate: false, uncertain: false };
  }
  return { level, escalate: true, uncertain: false };
}

/** Render the hidden hint that starts the self-check pass. */
export function renderCompletionHint(policy: CompletionPolicy): string {
  if (policy.uncertain) {
    return "[SELF-CHECK] Completion could not be confirmed confidently. Before finishing, re-read the request and run the relevant verification.";
  }
  if (policy.level === "incomplete") {
    return "[SELF-CHECK] The request does not look fully addressed yet. Before finishing, confirm each requirement is implemented and run the relevant verification.";
  }
  return "[SELF-CHECK] The change looks complete but unverified. Before finishing, run the relevant tests/checks and confirm the result.";
}

/**
 * Build a bounded view of a finished turn: the last user request plus every
 * assistant text after it. Enough to judge completion without shipping the
 * whole transcript.
 */
export function buildCompletionState(
  messages: unknown,
  maxCharacters: number = MAX_STATE_CHARACTERS,
): string {
  const list = Array.isArray(messages) ? messages : [];

  let lastUserIndex = -1;
  for (let index = list.length - 1; index >= 0; index--) {
    if (roleOf(list[index]) === "user") {
      lastUserIndex = index;
      break;
    }
  }

  const parts: string[] = [];
  const request = lastUserIndex >= 0 ? messageText(list[lastUserIndex]) : "";
  if (request.trim()) parts.push(`request:\n${request.trim()}`);

  const replies: string[] = [];
  for (let index = lastUserIndex + 1; index < list.length; index++) {
    if (roleOf(list[index]) === "assistant") {
      const text = messageText(list[index]).trim();
      if (text) replies.push(text);
    }
  }
  if (replies.length > 0) parts.push(`assistant:\n${replies.join("\n\n")}`);

  const state = parts.join("\n\n").trim();
  return state.length > maxCharacters ? state.slice(0, maxCharacters) : state;
}

function roleOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const role = (message as Record<string, unknown>).role;
  return typeof role === "string" ? role : "";
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      parts.push((block as Record<string, unknown>).text as string);
    }
  }
  return parts.join("\n");
}
