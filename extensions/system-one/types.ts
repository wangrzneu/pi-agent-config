/**
 * Shared decision types for the System One decision layer.
 *
 * The extension expresses decisions as `choice` questions and `noul`
 * (yes/no-probability) questions. `client.ts` maps them to Pi's classifier
 * types: `noul` becomes `bool`, and `choice` stays `choice`. Pi's model
 * registry owns provider auth, the endpoint, and usage accounting.
 *
 * See `docs/system-one.md`.
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

export interface NoulQuestion {
  /** Question id; echoed as the key under `answers`. */
  id: string;
  /** The yes/no question or assertion to evaluate. */
  instructions: string;
  /** Optional descriptions of the yes and no outcomes. */
  criteria?: { true?: string; false?: string };
}

export interface NoulRequest {
  questions: readonly NoulQuestion[];
  state: string;
  maxStateCharacters?: number;
}

export interface NoulAssessment {
  /** Question id → probability that the answer is "true", in [0, 1]. */
  probabilities: Record<string, number>;
}

/** The decisions the extension makes, each with its own threshold. */
export type DecisionKind = "intent" | "risk" | "completion" | "context";

export interface SystemOneClient {
  /**
   * Resolve one choice decision. Returns `undefined` when the model is
   * unavailable, times out, or answers off-schema — callers must treat
   * `undefined` as "do nothing" (fail-open) rather than guessing.
   */
  decide(
    request: DecisionRequest,
    signal?: AbortSignal,
  ): Promise<DecisionResult | undefined>;

  /**
   * Resolve many yes/no questions in one request. Returns `undefined` on any
   * transport/parse failure; individual unanswerable questions are omitted from
   * `probabilities` rather than failing the whole assessment.
   */
  assessNoul(
    request: NoulRequest,
    signal?: AbortSignal,
  ): Promise<NoulAssessment | undefined>;
}
