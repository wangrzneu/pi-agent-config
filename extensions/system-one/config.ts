/**
 * Configuration for the System One decision client.
 *
 * Disabled by default and fully opt-in: nothing runs unless `TYPESAFE_API_KEY`
 * is set. Endpoint, model, and key use the official SDK environment variable
 * names so an existing TypeSafe setup works unchanged.
 */

import { DEFAULT_COMPLETION_THRESHOLD } from "./completion.ts";
import { DEFAULT_RISK_THRESHOLD } from "./risk.ts";
import { DEFAULT_ROUTING_THRESHOLD } from "./routing.ts";
import type { DecisionKind } from "./types.ts";

export type SystemOneThresholds = Record<DecisionKind, number>;

export interface SystemOneConfig {
  /** API base URL, without a trailing slash. */
  baseUrl: string;
  /** Bearer token. Never enters status output or logs. */
  apiKey: string;
  /** Model name or alias, e.g. `jev-latest`. */
  model: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Minimum calibrated confidence per decision before a caller acts. */
  thresholds: SystemOneThresholds;
}

export const SYSTEM_ONE_DEFAULTS = {
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  timeoutMs: 5_000,
  thresholds: {
    intent: DEFAULT_ROUTING_THRESHOLD,
    risk: DEFAULT_RISK_THRESHOLD,
    completion: DEFAULT_COMPLETION_THRESHOLD,
  } satisfies SystemOneThresholds,
} as const;

export const SYSTEM_ONE_LIMITS = {
  timeoutMs: { min: 100, max: 30_000 },
} as const;

/** `POST /v1/systemone` on the configured base URL. */
export function systemOneUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/systemone`;
}

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
  };
}

/**
 * Read configuration from the environment. Returns `undefined` when the
 * extension is not configured, so callers can skip all System One work.
 */
export function readSystemOneConfig(
  env: Record<string, string | undefined> = process.env,
): SystemOneConfig | undefined {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return undefined;

  const baseUrl = env.TYPESAFE_BASE_URL?.trim() || SYSTEM_ONE_DEFAULTS.baseUrl;
  const model = env.TYPESAFE_DEFAULT_MODEL?.trim() || SYSTEM_ONE_DEFAULTS.model;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    timeoutMs: clampInt(
      Number(env.PI_SYSTEM_ONE_TIMEOUT_MS),
      SYSTEM_ONE_LIMITS.timeoutMs,
      SYSTEM_ONE_DEFAULTS.timeoutMs,
    ),
    thresholds: resolveThresholds(env),
  };
}
