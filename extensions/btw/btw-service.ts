import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const BTW_TIMEOUT_MS = 30_000;
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

  const timeoutSignal = AbortSignal.timeout(BTW_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const messages = await buildMessages(ctx);
  const tools = await loadTools(ctx);
  messages.push({
    role: "user",
    content: [{ type: "text", text: normalizedQuestion }],
    timestamp: Date.now(),
  });

  const options = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    signal: requestSignal,
    maxTokens: Math.min(BTW_MAX_TOKENS, model.maxTokens),
    timeoutMs: BTW_TIMEOUT_MS,
    maxRetries: 0,
    cacheRetention: "short",
    sessionId: ctx.sessionManager.getSessionId(),
    ...(ctx.thinkingLevel && ctx.thinkingLevel !== "off"
      ? { reasoning: ctx.thinkingLevel }
      : {}),
  };
  let toolCallCount = 0;

  try {
    for (let round = 0; round <= BTW_MAX_TOOL_ROUNDS; round += 1) {
      const response = await completeModel(
        model,
        {
          systemPrompt: `${ctx.getSystemPrompt()}\n\n${BTW_SYSTEM_SUFFIX}`,
          messages,
          ...(round < BTW_MAX_TOOL_ROUNDS && tools.length > 0
            ? { tools }
            : {}),
        },
        options,
      );

      if (response.stopReason === "aborted") {
        throw new BtwError("Side question cancelled.");
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
        if (round >= BTW_MAX_TOOL_ROUNDS || toolCallCount > BTW_MAX_TOOL_CALLS) {
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
            requestSignal,
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
          if (requestSignal.aborted) {
            throw new BtwError("Side question cancelled or timed out.");
          }
          messages.push(toolError(
            toolCall,
            error instanceof Error ? error.message : "Tool execution failed.",
          ));
        }
      }
    }
  } catch (error) {
    if (error instanceof BtwError) throw error;
    if (requestSignal.aborted) {
      throw new BtwError("Side question cancelled or timed out.");
    }
    throw new BtwError(error instanceof Error ? error.message : "Side question failed.");
  }

  throw new BtwError("The model did not answer within the read-only tool limit.");
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
