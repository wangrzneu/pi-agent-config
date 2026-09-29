/**
 * Context selection: rank a candidate set by relevance to a task.
 *
 * Uses System One's `noul` primitive to ask one yes/no question per candidate in
 * a single request (the "many independent, decomposed questions" pattern), then
 * applies a deterministic, thresholded top-K policy.
 *
 * Candidate paths are attacker-controllable (they come from the repo), so they
 * go in `state` — the field the API treats as untrusted data — while each
 * question refers to a candidate by index only. It only *ranks*; it never reads
 * files or changes what the agent may access.
 */

import type { NoulQuestion } from "./types.ts";

/** Relevance probability at or above which a candidate is selected. */
export const DEFAULT_CONTEXT_THRESHOLD = 0.5;
/** Hard cap on candidates accepted by the tool. */
export const MAX_CONTEXT_CANDIDATES = 200;
/** Default number of selected candidates. */
export const DEFAULT_CONTEXT_SELECTION = 25;
/** Per-candidate cap after sanitization, so one path cannot bloat the request. */
export const MAX_CANDIDATE_LENGTH = 200;
/** Cap on the assembled context state (larger than the generic state bound). */
export const MAX_CONTEXT_CHARACTERS = 24_000;

export interface ContextCandidate {
  /** Stable identifier (usually a path); used in the result. */
  id: string;
}

export interface ContextSelection {
  /** Selected candidate ids, most relevant first. */
  selected: string[];
  /** Every candidate's relevance probability, keyed by id. */
  scores: Record<string, number>;
}

export interface ContextRequestParts {
  /** The document: the task plus a numbered candidate list (untrusted field). */
  state: string;
  /** One yes/no question per included candidate; refers to it by index only. */
  questions: NoulQuestion[];
}

/** Question id for the candidate at `index`. */
export function contextQuestionId(index: number): string {
  return `candidate_${index}`;
}

/** Strip control characters and cap length so a path cannot break the format. */
export function sanitizeCandidate(id: string): string {
  return id
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, MAX_CANDIDATE_LENGTH);
}

function sanitizeTask(task: string): string {
  return task
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, 2_000);
}

/**
 * Build the request parts. Candidates go in `state`; each question names only
 * the candidate's index. Candidates whose lines would exceed `maxCharacters`
 * are dropped (a suffix), so the assembled state is always within the bound.
 */
export function buildContextRequest(
  task: string,
  candidates: readonly ContextCandidate[],
  maxCharacters: number = MAX_CONTEXT_CHARACTERS,
): ContextRequestParts {
  let state = `task: ${sanitizeTask(task)}\n\ncandidates:\n`;
  const questions: NoulQuestion[] = [];

  for (let index = 0; index < candidates.length; index++) {
    const id = contextQuestionId(index);
    const line = `${id}: ${sanitizeCandidate(candidates[index].id)}\n`;
    if (state.length + line.length > maxCharacters) break;
    state += line;
    questions.push({
      id,
      instructions: `Is ${id} relevant to the task? Answer true if it is likely to be needed to complete or verify the task.`,
    });
  }

  return { state, questions };
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
    .sort((a, b) => b.score - a.score || compareIds(a.id, b.id))
    .slice(0, maxSelected)
    .map((entry) => entry.id);

  return { selected, scores };
}

/** Code-point comparison so ordering does not depend on the host locale. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
