/**
 * System One decision client.
 *
 * The transport is Pi's classifier registry, not a private HTTP client:
 *
 *   const client = createRegistrySystemOneClient(ctx.modelRegistry, config)
 *
 * `client.decide()` maps to one `choice` question; `client.assessNoul()` maps
 * to one `bool` question per candidate. Pi resolves the provider credential,
 * the endpoint, and usage/cost accounting, and never rejects a classifier
 * call. This module only maps the extension's decision types to Pi's
 * `ClassifierContext`/`ClassifierResult` and validates the answers.
 *
 * Every failure path — missing model, error/aborted result, off-schema answer,
 * invalid probability, timeout — collapses to `undefined`, so callers fail open.
 */

import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierQuestion,
  ClassifierResult,
  JsonObject,
  ModelsClassifierOptions,
} from "@earendil-works/pi-ai";
import type { SystemOneConfig } from "./config.ts";
import { readSystemOneConfig, type ReadSystemOneOptions } from "./config.ts";
import type {
  ChoiceQuestion,
  DecisionRequest,
  DecisionResult,
  NoulAssessment,
  NoulQuestion,
  NoulRequest,
  SystemOneClient,
} from "./types.ts";

/**
 * The subset of Pi's `ModelRegistry` / `ModelRuntime` this client needs.
 * Both types satisfy it structurally; tests inject a fake.
 */
export interface ClassifierRegistry {
  getModelOfType(
    type: "classifier",
    provider: string,
    modelId: string,
  ): ClassifierModel<ClassifierApi> | undefined;
  classify(
    model: ClassifierModel<ClassifierApi>,
    context: ClassifierContext,
    options?: ModelsClassifierOptions,
  ): Promise<ClassifierResult>;
}

/** Field used to wrap the extension's string state in a JSON object. */
export const STATE_FIELD = "text";

const DEFAULT_TRUE_CRITERION = "The statement is true.";
const DEFAULT_FALSE_CRITERION = "The statement is false.";

function boundState(state: string, maxStateCharacters?: number): string {
  return typeof maxStateCharacters === "number" && maxStateCharacters > 0
    ? state.slice(0, maxStateCharacters)
    : state;
}

function stateObject(state: string, maxStateCharacters?: number): JsonObject {
  return { [STATE_FIELD]: boundState(state, maxStateCharacters) };
}

/** Map a choice question to Pi's classifier question shape. */
export function toChoiceQuestion(question: ChoiceQuestion): ClassifierQuestion {
  return {
    type: "choice",
    instructions: question.instructions,
    criteria: { ...question.criteria },
  };
}

/**
 * Map a `noul` question to Pi's `bool` question. Pi requires both criterion
 * labels, so missing labels get neutral defaults.
 */
export function toBoolQuestion(question: NoulQuestion): ClassifierQuestion {
  return {
    type: "bool",
    instructions: question.instructions,
    criteria: {
      true: question.criteria?.true ?? DEFAULT_TRUE_CRITERION,
      false: question.criteria?.false ?? DEFAULT_FALSE_CRITERION,
    },
  };
}

/** Build a single-question `choice` classifier context. */
export function buildChoiceContext(request: DecisionRequest): ClassifierContext {
  return {
    state: stateObject(request.state, request.maxStateCharacters),
    questions: {
      [request.question.id]: toChoiceQuestion(request.question),
    },
  };
}

/** Build a multi-question `bool` classifier context. */
export function buildNoulContext(request: NoulRequest): ClassifierContext {
  const questions: Record<string, ClassifierQuestion> = {};
  for (const question of request.questions) {
    questions[question.id] = toBoolQuestion(question);
  }
  return {
    state: stateObject(request.state, request.maxStateCharacters),
    questions,
  };
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

/** Validate one `choice` answer from a Pi classifier result. */
export function parseDecisionResult(
  result: ClassifierResult | undefined,
  question: ChoiceQuestion,
): DecisionResult | undefined {
  if (!result || result.stopReason !== "stop") return undefined;

  const answer = result.answers?.[question.id];
  if (!answer || answer.type !== "choice") return undefined;

  const labels = Object.keys(question.criteria);
  if (!labels.includes(answer.choice)) return undefined;
  if (!isProbability(answer.confidence)) return undefined;

  const probabilities = parseProbabilities(answer.probabilities, labels);
  return probabilities
    ? { choice: answer.choice, confidence: answer.confidence, probabilities }
    : { choice: answer.choice, confidence: answer.confidence };
}

/**
 * Validate `bool` answers from a Pi classifier result. Requires **every**
 * requested question to be answered cleanly: a partial result would silently
 * score the missing candidates as 0 and drop relevant files.
 */
export function parseNoulResult(
  result: ClassifierResult | undefined,
  questionIds: readonly string[],
): NoulAssessment | undefined {
  if (!result || result.stopReason !== "stop" || questionIds.length === 0) {
    return undefined;
  }

  const probabilities: Record<string, number> = {};
  for (const id of questionIds) {
    const answer = result.answers?.[id];
    if (!answer || answer.type !== "bool" || !isProbability(answer.probability)) {
      return undefined;
    }
    probabilities[id] = answer.probability;
  }
  return { probabilities };
}

function boundedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Build a client over Pi's classifier registry. Returns `undefined` when the model is absent. */
export function createRegistrySystemOneClient(
  registry: ClassifierRegistry,
  config: SystemOneConfig,
): SystemOneClient | undefined {
  const model = registry.getModelOfType(
    "classifier",
    config.provider,
    config.model,
  );
  if (!model) return undefined;

  const classify = async (
    context: ClassifierContext,
    signal: AbortSignal | undefined,
  ): Promise<ClassifierResult | undefined> => {
    try {
      return await registry.classify(model, context, {
        signal: boundedSignal(signal, config.timeoutMs),
      });
    } catch {
      // `ModelRegistry.classify()` never rejects, but a custom registry may.
      return undefined;
    }
  };

  return {
    async decide(request, signal) {
      const result = await classify(buildChoiceContext(request), signal);
      return parseDecisionResult(result, request.question);
    },
    async assessNoul(request, signal) {
      const result = await classify(buildNoulContext(request), signal);
      return parseNoulResult(
        result,
        request.questions.map((question) => question.id),
      );
    },
  };
}

/**
 * Create a client from the environment and a classifier registry.
 * Returns `undefined` when unconfigured or when the configured model is absent.
 */
export function createSystemOneClient(
  registry: ClassifierRegistry,
  env: Record<string, string | undefined> = process.env,
  options: ReadSystemOneOptions = {},
): SystemOneClient | undefined {
  const config = readSystemOneConfig(env, options);
  if (!config) return undefined;
  return createRegistrySystemOneClient(registry, config);
}
