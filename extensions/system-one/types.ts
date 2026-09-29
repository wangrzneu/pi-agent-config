/**
 * Shared types for the System One decision client.
 *
 * These mirror the real `typesafe_sdk` / `POST /v1/systemone` contract:
 * a request carries a `state` document plus named `questions`, and the response
 * carries `answers` keyed by the same names. Only the `choice` question primitive
 * is wired here, because it is the one that returns a calibrated `confidence`.
 *
 * The client is intentionally narrow: one choice question per request. See
 * `docs/system-one.md`.
 */

export interface ChoiceQuestion {
  /**
   * Question id. Sent as the key under `questions`, echoed as the key under
   * `answers`, and used to version the decision (e.g. `pi.change_risk.v1`).
   */
  id: string;
  /** Natural-language instruction describing what to decide. */
  instructions: string;
  /** Choice label → description of when that label applies. */
  criteria: Record<string, string>;
}

export interface DecisionRequest {
  question: ChoiceQuestion;
  /** The document all questions refer to (a bounded string). */
  state: string;
  /** Upper bound on state characters sent to the model. */
  maxStateCharacters?: number;
}

export interface DecisionResult {
  /** The selected label; guaranteed to be one of `question.criteria` keys. */
  choice: string;
  /** Calibrated confidence in [0, 1]. */
  confidence: number;
  /** Full probability distribution over the criteria, when the API returns it. */
  probabilities?: Record<string, number>;
}

export interface SystemOneClient {
  /**
   * Resolve one decision. Returns `undefined` when the model is unavailable,
   * times out, or answers off-schema — callers must treat `undefined` as
   * "do nothing" (fail-open) rather than guessing.
   */
  decide(
    request: DecisionRequest,
    signal?: AbortSignal,
  ): Promise<DecisionResult | undefined>;
}

/** The three decisions the extension makes, each with its own threshold. */
export type DecisionKind = "intent" | "risk" | "completion";
