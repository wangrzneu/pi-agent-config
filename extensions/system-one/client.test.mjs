import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDecisionBody,
  createHttpSystemOneClient,
  createSystemOneClient,
  parseDecisionResponse,
} from "./client.ts";
import { readSystemOneConfig, SYSTEM_ONE_DEFAULTS, systemOneUrl } from "./config.ts";

const QUESTION = {
  id: "pi.workflow_intent.v1",
  instructions: "Classify the task.",
  criteria: {
    design: "design",
    plan: "plan",
    implement: "implement",
    test: "test",
    review: "review",
    fix: "fix",
    explore: "explore",
  },
};

function response(choice, confidence, probabilities) {
  return new Response(
    JSON.stringify({
      model: "jev-latest",
      usage: { input_tokens: 10, output_tokens: 2 },
      answers: {
        [QUESTION.id]: { type: "choice", choice, confidence, probabilities },
      },
    }),
    { status: 200 },
  );
}

test("builds the real /v1/systemone request body", () => {
  const body = buildDecisionBody(
    { question: QUESTION, state: "x".repeat(100), maxStateCharacters: 10 },
    "jev-latest",
  );
  assert.equal(body.state.length, 10);
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(body.questions, {
    [QUESTION.id]: {
      type: "choice",
      instructions: QUESTION.instructions,
      criteria: QUESTION.criteria,
    },
  });
  // No schema/options keys from the old hypothesized contract.
  assert.equal("options" in body, false);
  assert.equal("schema" in body, false);
});

test("parses the answers map and validates the choice", () => {
  assert.deepEqual(
    parseDecisionResponse(
      { answers: { [QUESTION.id]: { type: "choice", choice: "fix", confidence: 0.8 } } },
      QUESTION,
    ),
    { choice: "fix", confidence: 0.8 },
  );
  assert.deepEqual(
    parseDecisionResponse(
      {
        answers: {
          [QUESTION.id]: {
            type: "choice",
            choice: "fix",
            confidence: 0.8,
            probabilities: { fix: 0.8, review: 0.2, other: 0.0 },
          },
        },
      },
      QUESTION,
    ),
    { choice: "fix", confidence: 0.8, probabilities: { fix: 0.8, review: 0.2 } },
  );
});

test("rejects off-schema or malformed answers", () => {
  const withAnswer = (answer) => ({ answers: { [QUESTION.id]: answer } });
  assert.equal(parseDecisionResponse(withAnswer({ type: "choice", choice: "refactor", confidence: 1 }), QUESTION), undefined);
  assert.equal(parseDecisionResponse(withAnswer({ type: "choice", choice: "fix", confidence: 1.5 }), QUESTION), undefined);
  assert.equal(parseDecisionResponse(withAnswer({ type: "choice", choice: "fix" }), QUESTION), undefined);
  assert.equal(parseDecisionResponse(withAnswer({ type: "noul", noul: 0.9 }), QUESTION), undefined);
  assert.equal(parseDecisionResponse({ answers: {} }, QUESTION), undefined);
  assert.equal(parseDecisionResponse({}, QUESTION), undefined);
  assert.equal(parseDecisionResponse(null, QUESTION), undefined);
});

test("posts to /v1/systemone with bearer auth and fails open on errors", async () => {
  const config = readSystemOneConfig({ TYPESAFE_API_KEY: "tsk-test" });
  assert.ok(config);
  assert.equal(systemOneUrl(config.baseUrl), "https://api.typesafe.ai/v1/systemone");

  let seenUrl;
  let seenInit;
  const ok = createHttpSystemOneClient(config, async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return response("fix", 0.9);
  });
  assert.deepEqual(await ok.decide({ question: QUESTION, state: "fix the test" }), {
    choice: "fix",
    confidence: 0.9,
  });
  assert.equal(seenUrl, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seenInit.method, "POST");
  assert.equal(seenInit.headers.authorization, "Bearer tsk-test");
  assert.equal(JSON.parse(seenInit.body).questions[QUESTION.id].type, "choice");

  const httpError = createHttpSystemOneClient(config, async () => new Response("nope", { status: 500 }));
  assert.equal(await httpError.decide({ question: QUESTION, state: "x" }), undefined);

  const throws = createHttpSystemOneClient(config, async () => {
    throw new Error("network down");
  });
  assert.equal(await throws.decide({ question: QUESTION, state: "x" }), undefined);

  const badJson = createHttpSystemOneClient(config, async () => new Response("{not json", { status: 200 }));
  assert.equal(await badJson.decide({ question: QUESTION, state: "x" }), undefined);
});

test("client is only created when TYPESAFE_API_KEY is set", () => {
  assert.equal(createSystemOneClient({}), undefined);
  assert.ok(
    createSystemOneClient({ TYPESAFE_API_KEY: "k" }, async () => new Response("{}")),
  );
});

test("config uses SDK env names, defaults, and per-decision thresholds", () => {
  const defaults = readSystemOneConfig({ TYPESAFE_API_KEY: "k" });
  assert.equal(defaults.baseUrl, SYSTEM_ONE_DEFAULTS.baseUrl);
  assert.equal(defaults.model, SYSTEM_ONE_DEFAULTS.model);
  assert.equal(defaults.timeoutMs, SYSTEM_ONE_DEFAULTS.timeoutMs);
  assert.deepEqual(defaults.thresholds, SYSTEM_ONE_DEFAULTS.thresholds);

  const custom = readSystemOneConfig({
    TYPESAFE_API_KEY: "  k  ",
    TYPESAFE_BASE_URL: "https://example.test/",
    TYPESAFE_DEFAULT_MODEL: "  custom-model  ",
    PI_SYSTEM_ONE_TIMEOUT_MS: "999999",
    PI_SYSTEM_ONE_MIN_CONFIDENCE: "0.7",
    PI_SYSTEM_ONE_MIN_CONFIDENCE_RISK: "0.9",
  });
  assert.equal(custom.apiKey, "k");
  assert.equal(custom.baseUrl, "https://example.test");
  assert.equal(custom.model, "custom-model");
  assert.equal(custom.timeoutMs, 30_000);
  assert.deepEqual(custom.thresholds, { intent: 0.7, risk: 0.9, completion: 0.7 });

  const clamped = readSystemOneConfig({
    TYPESAFE_API_KEY: "k",
    PI_SYSTEM_ONE_MIN_CONFIDENCE_INTENT: "2",
  });
  assert.equal(clamped.thresholds.intent, 1);

  assert.equal(readSystemOneConfig({}), undefined);
  assert.equal(readSystemOneConfig({ TYPESAFE_API_KEY: "   " }), undefined);
});
