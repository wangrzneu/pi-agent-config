#!/usr/bin/env node
/**
 * Calibrate the three System One decision thresholds through Pi's classifier
 * registry.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... node --experimental-strip-types scripts/calibrate-system-one.mjs
 *
 * `TYPESAFE_API_KEY` may be omitted when the classifier provider is already
 * configured in Pi (for example through `/login` or `models.json`).
 *
 * Optional: PI_SYSTEM_ONE_PROVIDER, PI_SYSTEM_ONE_MODEL (or
 * TYPESAFE_DEFAULT_MODEL), PI_SYSTEM_ONE_MIN_CONFIDENCE[_INTENT|_RISK|_COMPLETION].
 *
 * Prints, per decision: accuracy, confidence buckets (does higher confidence
 * mean higher accuracy?), the lowest threshold whose confident decisions meet
 * the target accuracy, and the matching PI_SYSTEM_ONE_MIN_CONFIDENCE_* exports.
 */

import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";

import { createRegistrySystemOneClient } from "../extensions/system-one/client.ts";
import { readSystemOneConfig, SYSTEM_ONE_DEFAULTS } from "../extensions/system-one/config.ts";
import {
  CALIBRATION_CASES,
  confidenceBuckets,
  evaluateCases,
  recommendThreshold,
  summarize,
} from "../extensions/system-one/calibration.ts";

const TARGET_ACCURACY = Number(process.env.PI_SYSTEM_ONE_CALIBRATION_TARGET ?? 0.9);

const config = readSystemOneConfig(process.env, { requireApiKey: false });
if (!config) {
  console.error(
    [
      "System One is not configured.",
      "Set TYPESAFE_API_KEY, configure the classifier provider in Pi, or set PI_SYSTEM_ONE_ENABLED=1.",
      "  TYPESAFE_API_KEY=... node --experimental-strip-types scripts/calibrate-system-one.mjs",
    ].join("\n"),
  );
  process.exit(1);
}

const services = await createAgentSessionServices({ cwd: process.cwd() });

// Check credentials before running every fixture. `getModelOfType()` only
// proves the catalog entry exists; `getAvailableOfType()` also resolves auth.
const available = await services.modelRuntime.getAvailableOfType(
  "classifier",
  config.provider,
);
const registry = {
  getModelOfType(_type, _provider, modelId) {
    return available.find((model) => model.id === modelId);
  },
  classify(model, context, options) {
    return services.modelRuntime.classify(model, context, options);
  },
};
const client = createRegistrySystemOneClient(registry, config);

if (!client) {
  console.error(
    [
      `No authenticated classifier model found for ${config.provider}/${config.model}.`,
      "Check that the provider is configured in Pi, or set",
      "PI_SYSTEM_ONE_PROVIDER / PI_SYSTEM_ONE_MODEL (or TYPESAFE_DEFAULT_MODEL).",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`provider: ${config.provider}`);
console.log(`model:    ${config.model}`);
console.log(`cases:    ${CALIBRATION_CASES.length} (target accuracy ${TARGET_ACCURACY})`);

const outcomes = await evaluateCases(client, CALIBRATION_CASES);

let failed = 0;
const recommended = {};
for (const decision of ["intent", "risk", "completion"]) {
  const forDecision = outcomes.filter((outcome) => outcome.decision === decision);
  const summary = summarize(forDecision);
  console.log(`\n== ${decision} ==`);
  console.log(
    `accuracy: ${(summary.accuracy * 100).toFixed(1)}% (${summary.correct}/${summary.total})`,
  );

  for (const outcome of forDecision) {
    if (!outcome.correct) failed++;
    const conf =
      typeof outcome.confidence === "number" ? outcome.confidence.toFixed(2) : "-";
    console.log(
      `  ${outcome.correct ? "ok  " : "MISS"} ${outcome.label} | expected=${outcome.expected} got=${outcome.choice ?? "-"} conf=${conf}`,
    );
  }

  console.log("confidence buckets:");
  for (const bucket of confidenceBuckets(forDecision)) {
    console.log(
      `  [${bucket.from.toFixed(2)}, ${bucket.to.toFixed(2)}) n=${bucket.total} acc=${(bucket.accuracy * 100).toFixed(0)}%`,
    );
  }

  const best = recommendThreshold(forDecision, TARGET_ACCURACY);
  recommended[decision] = best;
  console.log(
    best
      ? `recommended threshold >= ${best.threshold} (covers ${best.actedOn}, acc ${(best.accuracy * 100).toFixed(0)}%)`
      : `no threshold reached ${(TARGET_ACCURACY * 100).toFixed(0)}% accuracy`,
  );
}

console.log(`\n${failed} miss(es). Suggested configuration:`);
for (const decision of ["intent", "risk", "completion"]) {
  const best = recommended[decision];
  const value = best ? best.threshold : SYSTEM_ONE_DEFAULTS.thresholds[decision];
  const note = best ? "" : "   # target not reached; kept default";
  console.log(
    `export PI_SYSTEM_ONE_MIN_CONFIDENCE_${decision.toUpperCase()}=${value}${note}`,
  );
}
