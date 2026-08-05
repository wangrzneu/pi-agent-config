import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// Each model round (request plus its tool executions) gets its own fresh
// timeout. One global deadline (originally 30s) made any multi-round exchange
// abort with "Side question cancelled.": the first round of a cold Fireworks
// anthropic-messages request alone measured 20–24s (with occasional spikes
// beyond 30s), leaving no budget for the follow-up rounds that produce the
// final answer. With per-round budgets, a slow cold start no longer eats the
// whole exchange; warm rounds measure ~2s, so a typical answer finishes in
// ~25–45s. The overall cap keeps the exchange bounded no matter what.
const BTW_ROUND_TIMEOUT_MS = 45_000;
const BTW_TOTAL_TIMEOUT_MS = 120_000;
const BTW_MAX_TOKENS = 1_024;
const BTW_MAX_TOOL_ROUNDS = 4;
const BTW_MAX_TOOL_CALLS = 12;
const BTW_SYSTEM_SUFFIX = `You are answering a temporary side question about the current conversation.
You may use the available read-only tools to inspect and search files when that helps answer accurately.
Do not claim to modify files or run commands, and do not continue the main task. Answer the side
question directly and concisely.`;

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface CompletionResponse {
  role?: "assistant";
  stopReason?: string;
  errorMessage?: string;
  content?: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | ToolCall
  >;
  [key: string]: unknown;
}

interface BtwTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<
      { type: "text"; text: string } |
      { type: "image"; data: string; mimeType: string }
    >;
    details?: unknown;
  }>;
}

type CompleteModel = (
  model: NonNullable<ExtensionCommandContext["model"]>,
  context: {
    systemPrompt: string;
    messages: unknown[];
    tools?: BtwTool[];
  },
  options: Record<string, unknown>,
) => Promise<CompletionResponse>;

type BuildMessages = (
  ctx: ExtensionCommandContext,
) => Promise<unknown[]>;

type LoadTools = (
  ctx: ExtensionCommandContext,
) => Promise<BtwTool[]>;

export class BtwError extends Error {}

export async function askBtw(
  question: string,
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
  completeModel: CompleteModel = loadAndComplete,
  buildMessages: BuildMessages = loadSessionMessages,
  loadTools: LoadTools = loadReadOnlyTools,
): Promise<string> {
  const model = ctx.model;
  if (!model) throw new BtwError("No model selected.");

  const normalizedQuestion = question.trim();
  if (!normalizedQuestion) throw new BtwError("Enter a side question.");

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new BtwError(auth.error);

  const userSignal = signal;
  const overallSignal = AbortSignal.timeout(BTW_TOTAL_TIMEOUT_MS);
  const messages = await buildMessages(ctx);
  const tools = await loadTools(ctx);
  messages.push({
    role: "user",
    content: [{ type: "text", text: normalizedQuestion }],
    timestamp: Date.now(),
  });

  // `reasoning` inherits the current thinking level (same as the main session)
  // when enabled, but the exchange never mutates the session's level. Side
  // questions are short-lived; the read-only tools give the model enough
  // context to answer directly. `signal`/`timeoutMs` are per-round and set
  // inside the loop; this is the shared base for every round.
  const baseOptions = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    maxTokens: Math.min(BTW_MAX_TOKENS, model.maxTokens),
    maxRetries: 0,
    cacheRetention: "short",
    sessionId: ctx.sessionManager.getSessionId(),
    ...(ctx.thinkingLevel && ctx.thinkingLevel !== "off"
      ? { reasoning: ctx.thinkingLevel }
      : {}),
  };
  let toolCallCount = 0;

  let activeSignal: AbortSignal | undefined;

  // One model round: request (optionally with read-only tools) plus the tools'
  // executions, all bounded by one fresh round timeout.
  const runRound = async (provideTools: boolean): Promise<{
    response: CompletionResponse;
    roundTimeout: AbortSignal;
    roundSignal: AbortSignal;
  }> => {
    const roundTimeout = AbortSignal.timeout(BTW_ROUND_TIMEOUT_MS);
    const roundSignal = userSignal
      ? AbortSignal.any([userSignal, overallSignal, roundTimeout])
      : AbortSignal.any([overallSignal, roundTimeout]);
    activeSignal = roundSignal;
    const response = await completeModel(
      model,
      {
        systemPrompt: `${ctx.getSystemPrompt()}\n\n${BTW_SYSTEM_SUFFIX}`,
        messages,
        ...(provideTools && tools.length > 0 ? { tools } : {}),
      },
      {
        ...baseOptions,
        signal: roundSignal,
        timeoutMs: BTW_ROUND_TIMEOUT_MS,
      },
    );
    return { response, roundTimeout, roundSignal };
  };

  try {
    for (let round = 0; round < BTW_MAX_TOOL_ROUNDS; round += 1) {
      const { response, roundTimeout, roundSignal } = await runRound(true);

      if (response.stopReason === "aborted") {
        throw new BtwError(abortMessage(userSignal, overallSignal, roundTimeout));
      }
      if (response.stopReason === "error") {
        throw new BtwError(response.errorMessage || "Side question failed.");
      }

      const toolCalls = (response.content ?? []).filter(
        (block): block is ToolCall => block.type === "toolCall",
      );
      if (toolCalls.length === 0) {
        const answer = extractAnswer(response);
        if (!answer) throw new BtwError("The model returned an empty answer.");
        return answer;
      }

      messages.push(response);
      for (const toolCall of toolCalls) {
        toolCallCount += 1;
        const tool = tools.find((candidate) => candidate.name === toolCall.name);
        if (toolCallCount > BTW_MAX_TOOL_CALLS) {
          messages.push(toolError(
            toolCall,
            "The read-only tool budget is exhausted. Answer with the information already available.",
          ));
          continue;
        }
        if (!tool) {
          messages.push(toolError(toolCall, `Tool "${toolCall.name}" is not available.`));
          continue;
        }

        try {
          const result = await tool.execute(
            toolCall.id,
            toolCall.arguments,
            roundSignal,
          );
          messages.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: result.content,
            details: result.details,
            isError: false,
            timestamp: Date.now(),
          });
        } catch (error) {
          if (roundSignal.aborted) {
            throw new BtwError(abortMessage(userSignal, overallSignal, roundTimeout));
          }
          messages.push(toolError(
            toolCall,
            error instanceof Error ? error.message : "Tool execution failed.",
          ));
        }
      }
    }

    // All tool rounds are used up. Run one final round without tools so the
    // model answers from what it already gathered (the budget-exhausted tool
    // results above already told it to); without this, an exchange that burned
    // its tool budget used to die with "read-only tool limit" even though the
    // model had enough material to answer.
    const { response: finalResponse, roundTimeout: finalRoundTimeout } =
      await runRound(false);
    if (finalResponse.stopReason === "aborted") {
      throw new BtwError(abortMessage(userSignal, overallSignal, finalRoundTimeout));
    }
    if (finalResponse.stopReason === "error") {
      throw new BtwError(
        finalResponse.errorMessage || "Side question failed.",
      );
    }
    const answer = extractAnswer(finalResponse);
    if (!answer) {
      throw new BtwError("The model did not answer within the read-only tool limit.");
    }
    return answer;
  } catch (error) {
    if (error instanceof BtwError) throw error;
    if (userSignal?.aborted) {
      throw new BtwError("Side question cancelled.");
    }
    if (overallSignal.aborted || activeSignal?.aborted) {
      throw new BtwError("Side question timed out.");
    }
    throw new BtwError(error instanceof Error ? error.message : "Side question failed.");
  }
}

function abortMessage(
  userSignal: AbortSignal | undefined,
  overallSignal: AbortSignal,
  roundTimeout: AbortSignal,
): string {
  if (userSignal?.aborted) return "Side question cancelled.";
  if (overallSignal.aborted || roundTimeout.aborted) {
    return "Side question timed out.";
  }
  return "Side question cancelled.";
}

function extractAnswer(response: CompletionResponse): string {
  return (response.content ?? [])
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function toolError(toolCall: ToolCall, message: string): unknown {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: message }],
    isError: true,
    timestamp: Date.now(),
  };
}

async function loadSessionMessages(
  ctx: ExtensionCommandContext,
): Promise<unknown[]> {
  const { buildSessionContext, convertToLlm } =
    await import("@earendil-works/pi-coding-agent");
  const session = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  );
  return convertToLlm(session.messages);
}

async function loadAndComplete(
  ...args: Parameters<CompleteModel>
): Promise<CompletionResponse> {
  const { completeSimple } = await import("@earendil-works/pi-ai/compat");
  const [model, context, options] = args;
  return completeSimple(model, context as any, options as any);
}

async function loadReadOnlyTools(
  ctx: ExtensionCommandContext,
): Promise<BtwTool[]> {
  const { createReadOnlyTools } =
    await import("@earendil-works/pi-coding-agent");
  return createReadOnlyTools(ctx.cwd) as BtwTool[];
}
