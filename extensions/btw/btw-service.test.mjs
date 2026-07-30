import assert from "node:assert/strict";
import test from "node:test";
import { askBtw, BtwError } from "./btw-service.ts";

function createContext(overrides = {}) {
  return {
    model: {
      provider: "test-provider",
      id: "test-model",
      maxTokens: 8_192,
    },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return {
          ok: true,
          apiKey: "test-key",
          headers: { authorization: "test" },
          env: {},
        };
      },
    },
    sessionManager: {
      getSessionId() {
        return "session-1";
      },
    },
    thinkingLevel: "off",
    getSystemPrompt() {
      return "Main system prompt";
    },
    ...overrides,
  };
}

test("asks with current context, read-only tools, and no reasoning when off", async () => {
  let receivedContext;
  let receivedOptions;
  const ctx = createContext();
  const readTool = {
    name: "read",
    description: "Read a file",
    parameters: {},
    async execute() {
      throw new Error("not expected");
    },
  };

  const answer = await askBtw(
    "What did we decide?",
    ctx,
    undefined,
    async (_model, context, options) => {
      receivedContext = context;
      receivedOptions = options;
      return {
        stopReason: "stop",
        content: [{ type: "text", text: "Use the existing interface." }],
      };
    },
    async () => [
      {
        role: "assistant",
        content: [{ type: "text", text: "We chose the existing interface." }],
      },
    ],
    async () => [readTool],
  );

  assert.equal(answer, "Use the existing interface.");
  assert.deepEqual(receivedContext.tools, [readTool]);
  assert.equal(receivedContext.messages.length, 2);
  assert.equal(
    receivedContext.messages.at(-1).content[0].text,
    "What did we decide?",
  );
  assert.match(receivedContext.systemPrompt, /temporary side question/);
  assert.equal("reasoning" in receivedOptions, false);
  assert.equal(receivedOptions.maxRetries, 0);
  assert.equal(receivedOptions.sessionId, "session-1");
});

test("executes read-only tool calls in an isolated loop", async () => {
  const contexts = [];
  const executions = [];
  const tool = {
    name: "grep",
    description: "Search files",
    parameters: {},
    async execute(toolCallId, parameters) {
      executions.push({ toolCallId, parameters });
      return {
        content: [{ type: "text", text: "extensions/btw/index.ts: /btw" }],
        details: { matches: 1 },
      };
    },
  };

  const answer = await askBtw(
    "Where is /btw registered?",
    createContext(),
    undefined,
    async (_model, context) => {
      contexts.push({
        messages: structuredClone(context.messages),
        toolNames: context.tools?.map(({ name }) => name),
      });
      if (contexts.length === 1) {
        return {
          role: "assistant",
          stopReason: "toolUse",
          content: [{
            type: "toolCall",
            id: "call-1",
            name: "grep",
            arguments: { pattern: "btw", path: "extensions" },
          }],
        };
      }
      return {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "It is registered in extensions/btw/index.ts." }],
      };
    },
    async () => [],
    async () => [tool],
  );

  assert.equal(answer, "It is registered in extensions/btw/index.ts.");
  assert.deepEqual(executions, [{
    toolCallId: "call-1",
    parameters: { pattern: "btw", path: "extensions" },
  }]);
  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts[0].toolNames, ["grep"]);
  assert.equal(contexts[1].messages.at(-1).role, "toolResult");
  assert.equal(contexts[1].messages.at(-1).toolCallId, "call-1");
  assert.equal(contexts[1].messages.at(-1).isError, false);
});

test("inherits an enabled thinking level without changing the main session", async () => {
  let receivedOptions;
  const ctx = createContext({ thinkingLevel: "low" });

  await askBtw(
    "Explain this",
    ctx,
    undefined,
    async (_model, _context, options) => {
      receivedOptions = options;
      return {
        stopReason: "stop",
        content: [{ type: "text", text: "Explanation" }],
      };
    },
    async () => [],
    async () => [],
  );

  assert.equal(receivedOptions.reasoning, "low");
  assert.equal(ctx.thinkingLevel, "low");
});

test("fails without a model, auth, a question, or answer text", async () => {
  await assert.rejects(
    askBtw("Question", createContext({ model: undefined })),
    (error) => error instanceof BtwError && error.message === "No model selected.",
  );
  await assert.rejects(
    askBtw("  ", createContext()),
    (error) => error instanceof BtwError && error.message === "Enter a side question.",
  );
  await assert.rejects(
    askBtw(
      "Question",
      createContext({
        modelRegistry: {
          async getApiKeyAndHeaders() {
            return { ok: false, error: "Authentication unavailable." };
          },
        },
      }),
    ),
    (error) =>
      error instanceof BtwError &&
      error.message === "Authentication unavailable.",
  );
  await assert.rejects(
    askBtw(
      "Question",
      createContext(),
      undefined,
      async () => ({ stopReason: "stop", content: [] }),
      async () => [],
      async () => [],
    ),
    (error) =>
      error instanceof BtwError &&
      error.message === "The model returned an empty answer.",
  );
});

test("surfaces provider errors without writing to the session", async () => {
  const ctx = createContext();
  await assert.rejects(
    askBtw(
      "Question",
      ctx,
      undefined,
      async () => ({
        stopReason: "error",
        errorMessage: "Provider failed.",
      }),
      async () => [],
      async () => [],
    ),
    (error) =>
      error instanceof BtwError && error.message === "Provider failed.",
  );
  assert.equal("appendMessage" in ctx.sessionManager, false);
});
