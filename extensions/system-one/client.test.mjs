import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChoiceContext,
  buildNoulContext,
  createRegistrySystemOneClient,
  createSystemOneClient,
  parseDecisionResult,
  parseNoulResult,
  STATE_FIELD,
} from "./client.ts";
import { readSystemOneConfig, SYSTEM_ONE_DEFAULTS } from "./config.ts";

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

function classifierResult(answers, stopReason = "stop") {
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-latest",
    answers,
    stopReason,
    timestamp: 0,
  };
}

function fakeRegistry({ model = { id: "jev-latest" }, result } = {}) {
  const calls = { models: [], classify: [] };
  return {
    calls,
    registry: {
      getModelOfType(type, provider, modelId) {
        calls.models.push({ type, provider, modelId });
        return model;
      },
      async classify(selected, context, options) {
        calls.classify.push({ model: selected, context, options });
        return result;
      },
    },
  };
}

function config(overrides = {}) {
  return {
    ...readSystemOneConfig({ TYPESAFE_API_KEY: "k" }),
    ...overrides,
  };
}

test("maps a choice decision to one Pi classifier question", async () => {
  const { registry, calls } = fakeRegistry({
    result: classifierResult({
      [QUESTION.id]: {
        type: "choice",
        choice: "fix",
        confidence: 0.8,
        probabilities: { fix: 0.8, review: 0.2, other: 0.0 },
      },
    }),
  });
  const client = createRegistrySystemOneClient(registry, config());
  assert.ok(client);

  const result = await client.decide({
    question: QUESTION,
    state: "x".repeat(100),
    maxStateCharacters: 10,
  });

  assert.deepEqual(result, {
    choice: "fix",
    confidence: 0.8,
    probabilities: { fix: 0.8, review: 0.2 },
  });
  assert.deepEqual(calls.models[0], {
    type: "classifier",
    provider: "typesafe",
    modelId: "jev-latest",
  });
  assert.deepEqual(calls.classify[0].context.state, {
    [STATE_FIELD]: "x".repeat(10),
  });
  assert.deepEqual(calls.classify[0].context.questions, {
    [QUESTION.id]: {
      type: "choice",
      instructions: QUESTION.instructions,
      criteria: QUESTION.criteria,
    },
  });
  assert.ok(calls.classify[0].options.signal instanceof AbortSignal);
});

test("maps noul questions to bool questions with default criteria", async () => {
  const { registry, calls } = fakeRegistry({
    result: classifierResult({
      q0: { type: "bool", probability: 0.77 },
      q1: { type: "bool", probability: 0.12 },
    }),
  });
  const client = createRegistrySystemOneClient(registry, config());
  assert.ok(client);

  const result = await client.assessNoul({
    questions: [
      { id: "q0", instructions: "is a?" },
      { id: "q1", instructions: "is b?", criteria: { true: "yes", false: "no" } },
    ],
    state: "task",
    maxStateCharacters: 2,
  });

  assert.deepEqual(result, { probabilities: { q0: 0.77, q1: 0.12 } });
  assert.deepEqual(calls.classify[0].context.state, {
    [STATE_FIELD]: "ta",
  });
  assert.deepEqual(calls.classify[0].context.questions.q0, {
    type: "bool",
    instructions: "is a?",
    criteria: {
      true: "The statement is true.",
      false: "The statement is false.",
    },
  });
  assert.deepEqual(calls.classify[0].context.questions.q1.criteria, {
    true: "yes",
    false: "no",
  });
});

test("parses and validates a choice result", () => {
  const withAnswer = (answer) => classifierResult({ [QUESTION.id]: answer });

  assert.deepEqual(
    parseDecisionResult(
      withAnswer({ type: "choice", choice: "fix", confidence: 0.8 }),
      QUESTION,
    ),
    { choice: "fix", confidence: 0.8 },
  );
  assert.deepEqual(
    parseDecisionResult(
      withAnswer({
        type: "choice",
        choice: "fix",
        confidence: 0.8,
        probabilities: { fix: 0.8, review: 0.2, other: 0.0 },
      }),
      QUESTION,
    ),
    { choice: "fix", confidence: 0.8, probabilities: { fix: 0.8, review: 0.2 } },
  );

  assert.equal(
    parseDecisionResult(withAnswer({ type: "choice", choice: "refactor", confidence: 1 }), QUESTION),
    undefined,
  );
  assert.equal(
    parseDecisionResult(withAnswer({ type: "choice", choice: "fix", confidence: 1.5 }), QUESTION),
    undefined,
  );
  assert.equal(
    parseDecisionResult(withAnswer({ type: "choice", choice: "fix" }), QUESTION),
    undefined,
  );
  assert.equal(
    parseDecisionResult(withAnswer({ type: "bool", probability: 0.9 }), QUESTION),
    undefined,
  );
  assert.equal(parseDecisionResult(classifierResult({}, "error"), QUESTION), undefined);
  assert.equal(parseDecisionResult(undefined, QUESTION), undefined);
});

test("requires every noul answer to be a valid bool", () => {
  const result = classifierResult({
    q0: { type: "bool", probability: 0.9 },
    q1: { type: "bool", probability: 2 },
    q2: { type: "choice", choice: "x", confidence: 1 },
  });
  // q1/q2 are invalid, so the whole assessment is rejected rather than silently
  // scoring those candidates as 0.
  assert.equal(parseNoulResult(result, ["q0", "q1"]), undefined);
  assert.equal(parseNoulResult(result, ["q0", "q2"]), undefined);
  assert.deepEqual(parseNoulResult(result, ["q0"]), {
    probabilities: { q0: 0.9 },
  });
  assert.equal(parseNoulResult(classifierResult({}), ["q0"]), undefined);
  assert.equal(parseNoulResult(undefined, ["q0"]), undefined);
  assert.equal(parseNoulResult(result, []), undefined);
  assert.equal(parseNoulResult(classifierResult({}, "aborted"), ["q0"]), undefined);
});

test("fails open when the model is absent or the result is an error", async () => {
  const missing = fakeRegistry({ model: null });
  assert.equal(createRegistrySystemOneClient(missing.registry, config()), undefined);

  const { registry } = fakeRegistry({
    result: classifierResult({}, "error"),
  });
  const client = createRegistrySystemOneClient(registry, config());
  assert.ok(client);
  assert.equal(await client.decide({ question: QUESTION, state: "x" }), undefined);
  assert.equal(
    await client.assessNoul({ questions: [{ id: "q0", instructions: "?" }], state: "x" }),
    undefined,
  );
});

test("a throwing custom registry also fails open", async () => {
  const registry = {
    getModelOfType() {
      return { id: "jev-latest" };
    },
    async classify() {
      throw new Error("registry down");
    },
  };
  const client = createRegistrySystemOneClient(registry, config());
  assert.ok(client);
  assert.equal(await client.decide({ question: QUESTION, state: "x" }), undefined);
});

test("context builders expose only the bounded state and the questions", () => {
  const choice = buildChoiceContext({
    question: QUESTION,
    state: "state",
    maxStateCharacters: 3,
  });
  assert.deepEqual(choice.state, { [STATE_FIELD]: "sta" });
  assert.deepEqual(Object.keys(choice.questions), [QUESTION.id]);

  const noul = buildNoulContext({
    questions: [{ id: "q0", instructions: "?" }],
    state: "state",
    maxStateCharacters: 2,
  });
  assert.deepEqual(noul.state, { [STATE_FIELD]: "st" });
  assert.deepEqual(noul.questions.q0.criteria, {
    true: "The statement is true.",
    false: "The statement is false.",
  });
});

test("client is only created when configured", () => {
  const { registry } = fakeRegistry();
  assert.equal(createSystemOneClient(registry, {}), undefined);
  assert.ok(createSystemOneClient(registry, { TYPESAFE_API_KEY: "k" }));
  assert.ok(createSystemOneClient(registry, { PI_SYSTEM_ONE_ENABLED: "1" }));
  assert.equal(
    createSystemOneClient(registry, {
      TYPESAFE_API_KEY: "k",
      PI_SYSTEM_ONE_ENABLED: "0",
    }),
    undefined,
  );
  assert.ok(
    createSystemOneClient(registry, {}, { requireApiKey: false }),
  );
});

test("config selects the provider/model and parses thresholds", () => {
  const defaults = readSystemOneConfig({ TYPESAFE_API_KEY: "k" });
  assert.equal(defaults.provider, SYSTEM_ONE_DEFAULTS.provider);
  assert.equal(defaults.model, SYSTEM_ONE_DEFAULTS.model);
  assert.equal(defaults.timeoutMs, SYSTEM_ONE_DEFAULTS.timeoutMs);
  assert.deepEqual(defaults.thresholds, SYSTEM_ONE_DEFAULTS.thresholds);

  const custom = readSystemOneConfig({
    TYPESAFE_API_KEY: "  k  ",
    PI_SYSTEM_ONE_PROVIDER: "  openrouter  ",
    PI_SYSTEM_ONE_MODEL: "  typesafe/jev-1.14  ",
    PI_SYSTEM_ONE_TIMEOUT_MS: "999999",
    PI_SYSTEM_ONE_MIN_CONFIDENCE: "0.7",
    PI_SYSTEM_ONE_MIN_CONFIDENCE_RISK: "0.9",
  });
  assert.equal(custom.provider, "openrouter");
  assert.equal(custom.model, "typesafe/jev-1.14");
  assert.equal(custom.timeoutMs, 30_000);
  assert.deepEqual(custom.thresholds, {
    intent: 0.7,
    risk: 0.9,
    completion: 0.7,
    context: 0.7,
  });

  // The legacy model variable still works when the new one is absent.
  const legacy = readSystemOneConfig({
    TYPESAFE_API_KEY: "k",
    TYPESAFE_DEFAULT_MODEL: "  jev-preview  ",
  });
  assert.equal(legacy.model, "jev-preview");

  const clamped = readSystemOneConfig({
    TYPESAFE_API_KEY: "k",
    PI_SYSTEM_ONE_MIN_CONFIDENCE_INTENT: "2",
  });
  assert.equal(clamped.thresholds.intent, 1);

  assert.equal(readSystemOneConfig({}), undefined);
  assert.equal(readSystemOneConfig({ TYPESAFE_API_KEY: "   " }), undefined);
  assert.equal(readSystemOneConfig({ PI_SYSTEM_ONE_ENABLED: "1" }).provider, "typesafe");
  assert.ok(readSystemOneConfig({}, { requireApiKey: false }));
});
