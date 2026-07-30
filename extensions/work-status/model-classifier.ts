import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { summarizeWork, type WorkType } from "./work-status.ts";

const CLASSIFIER_TIMEOUT_MS = 2_000;
const MAX_PROMPT_CHARACTERS = 6_000;
const VALID_WORK_TYPES = new Set<WorkType>([
  "design",
  "plan",
  "implement",
  "test",
  "review",
  "fix",
  "explore",
]);

const SYSTEM_PROMPT = `Classify the user's current software-engineering task.
Return exactly one JSON object and no other text:
{"type":"design|plan|implement|test|review|fix|explore","summary":"concise task summary"}

Use the dominant intent, not individual keywords. Keep summary in the user's language and under 40 characters.`;

export interface WorkClassification {
  type: WorkType;
  summary: string;
}

interface CompletionResponse {
  stopReason?: string;
  content?: Array<{ type: string; text?: string }>;
}

type CompleteModel = (
  model: NonNullable<ExtensionContext["model"]>,
  context: {
    systemPrompt: string;
    messages: Array<{
      role: "user";
      content: Array<{ type: "text"; text: string }>;
      timestamp: number;
    }>;
  },
  options: Record<string, unknown>,
) => Promise<CompletionResponse>;

const classificationCache = new Map<string, WorkClassification>();

export async function classifyWorkWithModel(
  prompt: string,
  ctx: ExtensionContext,
  completeModel: CompleteModel = loadAndComplete,
): Promise<WorkClassification | undefined> {
  const model = ctx.model;
  const normalizedPrompt = prompt.trim();
  if (!model || !normalizedPrompt) return undefined;

  // Never run the classifier with reasoning when the model explicitly cannot disable it.
  if (model.reasoning && model.thinkingLevelMap?.off === null) return undefined;

  const promptHash = createHash("sha256").update(normalizedPrompt).digest("hex");
  const cacheKey = `${model.provider}/${model.id}:${promptHash}`;
  const cached = classificationCache.get(cacheKey);
  if (cached) return cached;

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return undefined;

    const timeoutSignal = AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS);
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, timeoutSignal])
      : timeoutSignal;
    const response = await completeModel(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: normalizedPrompt.slice(0, MAX_PROMPT_CHARACTERS),
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal,
        maxTokens: 96,
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
        // Deliberately omit `reasoning`: completeSimple disables extended thinking.
      },
    );

    const classification = parseClassification(response);
    if (classification) {
      if (classificationCache.size >= 128) {
        const oldestKey = classificationCache.keys().next().value;
        if (oldestKey) classificationCache.delete(oldestKey);
      }
      classificationCache.set(cacheKey, classification);
    }
    return classification;
  } catch {
    return undefined;
  }
}

export function parseClassification(
  response: CompletionResponse,
): WorkClassification | undefined {
  if (response.stopReason !== "stop") return undefined;

  const text = (response.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) return undefined;

  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      !VALID_WORK_TYPES.has(value.type as WorkType) ||
      typeof value.summary !== "string" ||
      !value.summary.trim()
    ) {
      return undefined;
    }

    return {
      type: value.type as WorkType,
      summary: summarizeWork(value.summary),
    };
  } catch {
    return undefined;
  }
}

async function loadAndComplete(
  ...args: Parameters<CompleteModel>
): Promise<CompletionResponse> {
  const { completeSimple } = await import("@earendil-works/pi-ai/compat");
  const [model, context, options] = args;
  return completeSimple(model, context, options as any);
}
