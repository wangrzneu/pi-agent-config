/**
 * Configuration for the System One decision layer.
 *
 * The extension is opt-in: nothing runs unless a TypeSafe/System One classifier
 * is configured. `TYPESAFE_API_KEY` enables it with the environment key;
 * `PI_SYSTEM_ONE_ENABLED=1` enables it for a provider configured through Pi
 * (for example `/login` or `models.json`). `PI_SYSTEM_ONE_ENABLED=0` always
 * disables it.
 *
 * The actual classifier lookup and request auth are owned by Pi's model
 * registry (`ctx.modelRegistry`), not by this extension. The provider and model
 * below select which classifier to ask.
 */

import { DEFAULT_COMPLETION_THRESHOLD } from "./completion.ts";
import { DEFAULT_CONTEXT_THRESHOLD } from "./context.ts";
import { DEFAULT_RISK_THRESHOLD } from "./risk.ts";
import { DEFAULT_ROUTING_THRESHOLD } from "./routing.ts";
import type { DecisionKind } from "./types.ts";

export type SystemOneThresholds = Record<DecisionKind, number>;

export interface SystemOneConfig {
  /** Pi provider that exposes the classifier, e.g. `typesafe`. */
  provider: string;
  /** Classifier model id, e.g. `jev-latest`. */
  model: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Minimum calibrated confidence per decision before a caller acts. */
  thresholds: SystemOneThresholds;
}

export interface ReadSystemOneOptions {
  /**
   * Require `TYPESAFE_API_KEY` as the opt-in signal. Set to `false` for tools
   * that may use a credential already stored by Pi (for example calibration).
   */
  requireApiKey?: boolean;
}

export const SYSTEM_ONE_DEFAULTS = {
  provider: "typesafe",
  model: "jev-latest",
  timeoutMs: 5_000,
  thresholds: {
    intent: DEFAULT_ROUTING_THRESHOLD,
    risk: DEFAULT_RISK_THRESHOLD,
    completion: DEFAULT_COMPLETION_THRESHOLD,
    context: DEFAULT_CONTEXT_THRESHOLD,
  } satisfies SystemOneThresholds,
} as const;

export const SYSTEM_ONE_LIMITS = {
  timeoutMs: { min: 100, max: 30_000 },
} as const;

function clampInt(
  value: number,
  limits: { min: number; max: number },
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

/** Parse one confidence threshold from an env string, clamped to [0, 1]. */
function parseThreshold(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function resolveThresholds(
  env: Record<string, string | undefined>,
): SystemOneThresholds {
  // A shared value overrides every decision's default; a per-decision value
  // overrides the shared one.
  const shared = env.PI_SYSTEM_ONE_MIN_CONFIDENCE;
  const defaults = SYSTEM_ONE_DEFAULTS.thresholds;
  return {
    intent: parseThreshold(
      env.PI_SYSTEM_ONE_MIN_CONFIDENCE_INTENT,
      parseThreshold(shared, defaults.intent),
    ),
    risk: parseThreshold(
      env.PI_SYSTEM_ONE_MIN_CONFIDENCE_RISK,
      parseThreshold(shared, defaults.risk),
    ),
    completion: parseThreshold(
      env.PI_SYSTEM_ONE_MIN_CONFIDENCE_COMPLETION,
      parseThreshold(shared, defaults.completion),
    ),
    context: parseThreshold(
      env.PI_SYSTEM_ONE_MIN_CONFIDENCE_CONTEXT,
      parseThreshold(shared, defaults.context),
    ),
  };
}

/**
 * Read configuration from the environment. Returns `undefined` when the
 * extension is not configured, so callers can skip all System One work.
 */
export function readSystemOneConfig(
  env: Record<string, string | undefined> = process.env,
  options: ReadSystemOneOptions = {},
): SystemOneConfig | undefined {
  const enabled = env.PI_SYSTEM_ONE_ENABLED?.trim();
  if (enabled === "0") return undefined;

  const hasApiKey = Boolean(env.TYPESAFE_API_KEY?.trim());
  if (options.requireApiKey !== false && !hasApiKey && enabled !== "1") {
    return undefined;
  }

  const provider =
    env.PI_SYSTEM_ONE_PROVIDER?.trim() || SYSTEM_ONE_DEFAULTS.provider;
  const model =
    env.PI_SYSTEM_ONE_MODEL?.trim() ||
    env.TYPESAFE_DEFAULT_MODEL?.trim() ||
    SYSTEM_ONE_DEFAULTS.model;

  return {
    provider,
    model,
    timeoutMs: clampInt(
      Number(env.PI_SYSTEM_ONE_TIMEOUT_MS),
      SYSTEM_ONE_LIMITS.timeoutMs,
      SYSTEM_ONE_DEFAULTS.timeoutMs,
    ),
    thresholds: resolveThresholds(env),
  };
}
