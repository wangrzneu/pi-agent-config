/**
 * System One decision client.
 *
 * Speaks the real `POST /v1/systemone` contract (see
 * `https://api.typesafe.ai/openapi.json`, mirrored by `typesafe_sdk`):
 *
 *   POST <baseUrl>/v1/systemone
 *   authorization: Bearer <TYPESAFE_API_KEY>
 *   { "state": "...", "model": "jev-latest",
 *     "questions": { "<id>": { "type": "choice", "instructions": "...",
 *                              "criteria": { "<label>": "<description>" } },
 *                    "<id2>": { "type": "noul", "instructions": "..." } } }
 *   -> { "answers": { "<id>":  { "type": "choice", "choice": "...",
 *                                "confidence": 0.87, "probabilities": {...} },
 *                     "<id2>": { "type": "noul", "noul": 0.91 } } }
 *
 * Every failure path — transport error, non-2xx, malformed body, off-schema
 * choice, out-of-range confidence, timeout — collapses to `undefined`, so
 * callers fail open and fall back to their existing behavior.
 */

import type { SystemOneConfig } from "./config.ts";
import { readSystemOneConfig, systemOneUrl } from "./config.ts";
import type {
  ChoiceQuestion,
  DecisionRequest,
  DecisionResult,
  NoulAssessment,
  NoulRequest,
  SystemOneClient,
} from "./types.ts";

export interface DecisionBody {
  state: string;
  model: string;
  questions: Record<string, WireQuestion>;
}

interface WireChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

interface WireNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

type WireQuestion = WireChoiceQuestion | WireNoulQuestion;

function boundState(state: string, maxStateCharacters?: number): string {
  return typeof maxStateCharacters === "number" && maxStateCharacters > 0
    ? state.slice(0, maxStateCharacters)
    : state;
}

/** Build a single-`choice` request body, truncating state to the declared bound. */
export function buildDecisionBody(
  request: DecisionRequest,
  model: string,
): DecisionBody {
  return {
    state: boundState(request.state, request.maxStateCharacters),
    model,
    questions: {
      [request.question.id]: {
        type: "choice",
        instructions: request.question.instructions,
        criteria: { ...request.question.criteria },
      },
    },
  };
}

/** Build a multi-`noul` request body, truncating state to the declared bound. */
export function buildNoulBody(
  request: NoulRequest,
  model: string,
): DecisionBody {
  const questions: Record<string, WireQuestion> = {};
  for (const question of request.questions) {
    questions[question.id] = {
      type: "noul",
      instructions: question.instructions,
      ...(question.criteria ? { criteria: { ...question.criteria } } : {}),
    };
  }
  return {
    state: boundState(request.state, request.maxStateCharacters),
    model,
    questions,
  };
}

/** Validate a `choice` answer from a `/v1/systemone` payload. */
export function parseDecisionResponse(
  payload: unknown,
  question: ChoiceQuestion,
): DecisionResult | undefined {
  const record = answerOf(payload, question.id);
  if (!record || record.type !== "choice") return undefined;

  const labels = Object.keys(question.criteria);
  const choice = typeof record.choice === "string" ? record.choice : undefined;
  if (!choice || !labels.includes(choice)) return undefined;

  const confidence =
    typeof record.confidence === "number" ? record.confidence : undefined;
  if (!isProbability(confidence)) return undefined;

  const probabilities = parseProbabilities(record.probabilities, labels);
  return probabilities
    ? { choice, confidence, probabilities }
    : { choice, confidence };
}

/**
 * Validate `noul` answers from a `/v1/systemone` payload. Questions the model
 * did not answer cleanly are omitted; returns `undefined` when none are valid.
 */
export function parseNoulResponse(
  payload: unknown,
  questionIds: readonly string[],
): NoulAssessment | undefined {
  const probabilities: Record<string, number> = {};
  for (const id of questionIds) {
    const record = answerOf(payload, id);
    if (!record || record.type !== "noul") continue;
    const probability = record.noul;
    if (isProbability(probability)) probabilities[id] = probability;
  }
  return Object.keys(probabilities).length > 0 ? { probabilities } : undefined;
}

function answerOf(
  payload: unknown,
  id: string,
): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const answers = (payload as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object") return undefined;
  const answer = (answers as Record<string, unknown>)[id];
  return answer && typeof answer === "object"
    ? (answer as Record<string, unknown>)
    : undefined;
}

function isProbability(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function parseProbabilities(
  value: unknown,
  labels: readonly string[],
): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const label of labels) {
    if (isProbability(source[label])) out[label] = source[label] as number;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function postJson(
  config: SystemOneConfig,
  body: DecisionBody,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<unknown | undefined> {
  try {
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const response = await fetchImpl(systemOneUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Build an HTTP client. `fetchImpl` is injectable so tests stay offline. */
export function createHttpSystemOneClient(
  config: SystemOneConfig,
  fetchImpl: typeof fetch = fetch,
): SystemOneClient {
  return {
    async decide(request, signal) {
      const payload = await postJson(
        config,
        buildDecisionBody(request, config.model),
        signal,
        fetchImpl,
      );
      return payload === undefined
        ? undefined
        : parseDecisionResponse(payload, request.question);
    },
    async assessNoul(request, signal) {
      const payload = await postJson(
        config,
        buildNoulBody(request, config.model),
        signal,
        fetchImpl,
      );
      return payload === undefined
        ? undefined
        : parseNoulResponse(
            payload,
            request.questions.map((question) => question.id),
          );
    },
  };
}

/** Create a client from the environment, or `undefined` when unconfigured. */
export function createSystemOneClient(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): SystemOneClient | undefined {
  const config = readSystemOneConfig(env);
  if (!config) return undefined;
  return createHttpSystemOneClient(config, fetchImpl);
}
