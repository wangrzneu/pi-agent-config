/**
 * Context selection: rank a candidate set by relevance to a task.
 *
 * Uses System One's `noul` primitive to ask one yes/no question per candidate in
 * a single request (the "many independent, decomposed questions" pattern), then
 * applies a deterministic, thresholded top-K policy. It only *ranks*; it never
 * reads files or changes what the agent may access.
 */

import type { NoulQuestion } from "./types.ts";

/** Relevance probability at or above which a candidate is selected. */
export const DEFAULT_CONTEXT_THRESHOLD = 0.5;
/** Hard cap on candidates per request (keeps one request bounded). */
export const MAX_CONTEXT_CANDIDATES = 200;
/** Default number of selected candidates. */
export const DEFAULT_CONTEXT_SELECTION = 25;

export interface ContextCandidate {
  /** Stable identifier (usually a path); used in the result. */
  id: string;
  /** Optional one-line description to help the model judge relevance. */
  description?: string;
}

export interface ContextSelection {
  /** Selected candidate ids, most relevant first. */
  selected: string[];
  /** Every candidate's relevance probability, keyed by id. */
  scores: Record<string, number>;
}

/** Question id for the candidate at `index`. */
export function contextQuestionId(index: number): string {
  return `candidate_${index}`;
}

/** One yes/no relevance question per candidate, ids assigned by position. */
export function buildContextQuestions(
  candidates: readonly ContextCandidate[],
): NoulQuestion[] {
  return candidates.map((candidate, index) => ({
    id: contextQuestionId(index),
    instructions: candidate.description
      ? `Is this file relevant to the task? File: ${candidate.id} — ${candidate.description}`
      : `Is this file relevant to the task? File: ${candidate.id}`,
    criteria: {
      true: "The file is likely to be needed to complete or verify the task.",
      false: "The file is unlikely to be needed for this task.",
    },
  }));
}

/** Apply the deterministic threshold + top-K policy to raw probabilities. */
export function selectRelevant(
  candidates: readonly ContextCandidate[],
  probabilities: Record<string, number>,
  options: { threshold?: number; maxSelected?: number } = {},
): ContextSelection {
  const threshold = options.threshold ?? DEFAULT_CONTEXT_THRESHOLD;
  const maxSelected = options.maxSelected ?? DEFAULT_CONTEXT_SELECTION;

  const scored = candidates.map((candidate, index) => ({
    id: candidate.id,
    score: probabilities[contextQuestionId(index)] ?? 0,
  }));

  const scores: Record<string, number> = {};
  for (const entry of scored) scores[entry.id] = entry.score;

  const selected = scored
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, maxSelected)
    .map((entry) => entry.id);

  return { selected, scores };
}

/** Render a selection as tool output for the agent. */
export function formatContextResult(selection: ContextSelection): string {
  if (selection.selected.length === 0) {
    return "No candidate looked relevant. Widen the search or provide more candidates.";
  }
  const lines = selection.selected.map(
    (id) => `- ${id} (${(selection.scores[id] ?? 0).toFixed(2)})`,
  );
  return `Most relevant candidates (probability):\n${lines.join("\n")}`;
}
