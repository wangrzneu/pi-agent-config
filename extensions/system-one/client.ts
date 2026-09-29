/**
 * System One decision client.
 *
 * Speaks the real `POST /v1/systemone` contract (see
 * `https://api.typesafe.ai/openapi.json`, mirrored by `typesafe_sdk`):
 *
 *   POST <baseUrl>/v1/systemone
 *   authorization: Bearer <TYPESAFE_API_KEY>
 *   { "state": "...", "model": "jev-latest",
 *     "questions": { "<id>": { "type": "choice",
 *                              "instructions": "...",
 *                              "criteria": { "<label>": "<description>" } } } }
 *   -> { "model": "...", "usage": { ... },
 *        "answers": { "<id>": { "type": "choice", "choice": "<label>",
 *                               "confidence": 0.87,
 *                               "probabilities": { "<label>": 0.87, ... } } } }
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
  SystemOneClient,
} from "./types.ts";

interface WireQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface DecisionBody {
  state: string;
  model: string;
  questions: Record<string, WireQuestion>;
}

/** Build the request body, truncating state to the declared bound. */
export function buildDecisionBody(
  request: DecisionRequest,
  model: string,
): DecisionBody {
  const limit = request.maxStateCharacters;
  const state =
    typeof limit === "number" && limit > 0
      ? request.state.slice(0, limit)
      : request.state;
  return {
    state,
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

/**
 * Validate a `/v1/systemone` payload for one choice question. Rejects anything
 * that is not a clean, in-range answer, and requires `choice` to be one of the
 * offered labels.
 */
export function parseDecisionResponse(
  payload: unknown,
  question: ChoiceQuestion,
): DecisionResult | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const answers = (payload as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object") return undefined;

  const answer = (answers as Record<string, unknown>)[question.id];
  if (!answer || typeof answer !== "object") return undefined;
  const record = answer as Record<string, unknown>;
  if (record.type !== "choice") return undefined;

  const labels = Object.keys(question.criteria);
  const choice = typeof record.choice === "string" ? record.choice : undefined;
  if (!choice || !labels.includes(choice)) return undefined;

  const confidence =
    typeof record.confidence === "number" ? record.confidence : undefined;
  if (
    confidence === undefined ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return undefined;
  }

  const probabilities = parseProbabilities(record.probabilities, labels);
  return probabilities ? { choice, confidence, probabilities } : { choice, confidence };
}

function parseProbabilities(
  value: unknown,
  labels: readonly string[],
): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const label of labels) {
    const probability = source[label];
    if (typeof probability === "number" && Number.isFinite(probability)) {
      out[label] = probability;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Build an HTTP client. `fetchImpl` is injectable so tests stay offline. */
export function createHttpSystemOneClient(
  config: SystemOneConfig,
  fetchImpl: typeof fetch = fetch,
): SystemOneClient {
  return {
    async decide(
      request: DecisionRequest,
      signal?: AbortSignal,
    ): Promise<DecisionResult | undefined> {
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
          body: JSON.stringify(buildDecisionBody(request, config.model)),
          signal: combinedSignal,
        });
        if (!response.ok) return undefined;

        const payload = await response.json();
        return parseDecisionResponse(payload, request.question);
      } catch {
        return undefined;
      }
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
