import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderConfig,
  ProviderFallbackConfig,
  ProviderFallbackReason,
  ProviderFinishReason,
  ProviderName,
  StreamCallback,
  ToolInvocation,
} from "@/runtime/llm/types.ts";
import { estimateUsageCost } from "@/runtime/llm/pricing.ts";
import { resolveProviderApiKey, toLLMConfig } from "@/runtime/llm/config.ts";
import {
  countTokens,
  createMockResponse,
  estimateUsage,
  formatMessages,
  getLocalStopSequences,
  parseInternalControlTagsFromResponse,
  parseTaggedBlocksFromResponse,
  parseToolCallsFromResponse,
  processStream,
  withDefaultStopSequences,
} from "@/runtime/llm/utils.ts";
import { streamPost, type StreamResponse } from "@/runtime/http.ts";
import type {
  ProviderRegistry,
  ProviderUsageUpdate,
  TokenUsage,
} from "@/runtime/llm/types.ts";

const DEFAULT_FALLBACK_REASONS: ProviderFallbackReason[] = [
  "timeout",
  "network",
  "rate_limit",
  "server_error",
  "provider_error",
];
const MAX_TEXT_CONTINUATION_ROUNDS = 1;
const MAX_TOOL_CALL_REPAIR_ROUNDS = 1;
const TEXT_CONTINUATION_CUE = `
Continue the previous assistant response exactly where it stopped.
Do not repeat earlier content.
Do not summarize.
Do not call tools.
Return only the continuation text.
`.trim();
const TOOL_CALL_REPAIR_CUE = `
Your previous response was cut off while emitting a <function_calls> block.
Return only one complete valid <function_calls>...</function_calls> block.
Do not include prose.
`.trim();

export type LLMProviderAttempt = {
  provider: ProviderName;
  model?: string;
  reason?: ProviderFallbackReason | null;
  status?: number;
  message?: string;
};

export class LLMProviderError extends Error {
  reason: ProviderFallbackReason | null;
  provider: ProviderName;
  model?: string;
  status?: number;
  attempts: LLMProviderAttempt[];
  fallbackAttempted: boolean;
  visibleStreamStarted: boolean;

  constructor(
    message: string,
    options: {
      reason: ProviderFallbackReason | null;
      provider: ProviderName;
      model?: string;
      status?: number;
      attempts?: LLMProviderAttempt[];
      fallbackAttempted?: boolean;
      visibleStreamStarted?: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "LLMProviderError";
    this.reason = options.reason;
    this.provider = options.provider;
    this.model = options.model;
    this.status = options.status;
    this.attempts = options.attempts ?? [];
    this.fallbackAttempted = options.fallbackAttempted ?? false;
    this.visibleStreamStarted = options.visibleStreamStarted ?? false;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

let defaultProviderRegistryPromise: Promise<ProviderRegistry> | undefined;

async function getProviderRegistry(
  registry?: ProviderRegistry,
): Promise<ProviderRegistry> {
  if (registry) return registry;
  if (!defaultProviderRegistryPromise) {
    defaultProviderRegistryPromise = import("@/runtime/llm/registry.ts")
      .then((mod) => mod.providers);
  }
  return await defaultProviderRegistryPromise;
}

function buildAttemptConfig(
  baseConfig: ProviderConfig,
  env: Record<string, string>,
  override?: ProviderFallbackConfig,
): ProviderConfig {
  const candidate = {
    ...baseConfig,
    ...(override ?? {}),
    fallbacks: undefined,
    fallbackOn: undefined,
  } as ProviderConfig;

  candidate.apiKey = resolveProviderApiKey(candidate, env);
  return withDefaultStopSequences(candidate);
}

export function classifyLLMError(
  error: unknown,
): ProviderFallbackReason | null {
  const requestError = error as {
    status?: number;
    statusText?: string;
    name?: string;
    message?: string;
  };

  if (requestError?.status === 401 || requestError?.status === 403) {
    return null;
  }

  if (
    requestError?.name === "AbortError" ||
    requestError?.status === 408 ||
    requestError?.status === 504
  ) {
    return "timeout";
  }

  if (requestError?.status === 429) {
    return "rate_limit";
  }

  if (
    typeof requestError?.status === "number" &&
    requestError.status >= 500
  ) {
    return "server_error";
  }

  if (
    typeof requestError?.status === "number" &&
    requestError.status >= 400
  ) {
    return "provider_error";
  }

  if (error instanceof Error) {
    return "network";
  }

  return null;
}

function shouldAttemptFallback(
  error: unknown,
  fallbackOn?: ProviderFallbackReason[],
): boolean {
  const reason = classifyLLMError(error);
  if (!reason) return false;

  const allowedReasons = Array.isArray(fallbackOn) && fallbackOn.length > 0
    ? fallbackOn
    : DEFAULT_FALLBACK_REASONS;

  return allowedReasons.includes(reason);
}

function getErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeProviderUsage(
  usage: ProviderUsageUpdate | undefined,
  status: TokenUsage["status"],
): TokenUsage | null {
  if (!usage) return null;

  const inputTokens = typeof usage.inputTokens === "number"
    ? usage.inputTokens
    : undefined;
  const outputTokens = typeof usage.outputTokens === "number"
    ? usage.outputTokens
    : undefined;
  const reasoningTokens = typeof usage.reasoningTokens === "number"
    ? usage.reasoningTokens
    : undefined;
  const cacheReadInputTokens = typeof usage.cacheReadInputTokens === "number"
    ? usage.cacheReadInputTokens
    : undefined;
  const cacheCreationInputTokens =
    typeof usage.cacheCreationInputTokens === "number"
      ? usage.cacheCreationInputTokens
      : undefined;
  const totalTokens = typeof usage.totalTokens === "number"
    ? usage.totalTokens
    : (inputTokens !== undefined && outputTokens !== undefined)
    ? inputTokens + outputTokens
    : undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined &&
    cacheReadInputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    totalTokens === undefined &&
    !usage.rawUsage
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens,
    source: "provider",
    status,
    rawUsage: usage.rawUsage ?? null,
  };
}

function sumUsageNumber(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

function mergeProviderUsage(
  left: ProviderUsageUpdate | undefined,
  right: ProviderUsageUpdate | undefined,
): ProviderUsageUpdate | undefined {
  if (!left) return right;
  if (!right) return left;

  return {
    inputTokens: sumUsageNumber(left.inputTokens, right.inputTokens),
    outputTokens: sumUsageNumber(left.outputTokens, right.outputTokens),
    reasoningTokens: sumUsageNumber(
      left.reasoningTokens,
      right.reasoningTokens,
    ),
    cacheReadInputTokens: sumUsageNumber(
      left.cacheReadInputTokens,
      right.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: sumUsageNumber(
      left.cacheCreationInputTokens,
      right.cacheCreationInputTokens,
    ),
    totalTokens: sumUsageNumber(left.totalTokens, right.totalTokens),
    rawUsage: {
      segments: [left.rawUsage ?? null, right.rawUsage ?? null],
    },
  };
}

function mergeExtractedTags(
  left: Record<string, string[]>,
  right: Record<string, string[]>,
): Record<string, string[]> {
  const merged = { ...left };
  for (const [key, values] of Object.entries(right)) {
    merged[key] = [...(merged[key] ?? []), ...values];
  }
  return merged;
}

function hasDanglingFunctionCallsBlock(response: string): boolean {
  const startTag = "<function_calls>";
  const endTag = "</function_calls>";
  return response.lastIndexOf(startTag) > response.lastIndexOf(endTag);
}

function parseAssistantResponse(
  response: string,
  extractedBlockTags: string[] = [],
  options: { preserveWhitespace?: boolean } = {},
): {
  cleanResponse: string;
  toolCalls: ToolInvocation[];
  extractedTags: Record<string, string[]>;
} {
  let cleanResponse = response;
  let toolCalls: ToolInvocation[] = [];
  let extractedTags: Record<string, string[]> = {};

  {
    const parsed = parseToolCallsFromResponse(response);
    cleanResponse = parsed.cleanResponse;
    toolCalls = parsed.tool_calls;
  }
  if (extractedBlockTags.length > 0) {
    const parsed = parseTaggedBlocksFromResponse(
      cleanResponse,
      extractedBlockTags,
    );
    cleanResponse = parsed.cleanResponse;
    extractedTags = parsed.extractedTags;
  } else if (!options.preserveWhitespace) {
    cleanResponse = cleanResponse.trim();
  }
  if (
    cleanResponse.includes("<no_response") ||
    cleanResponse.includes("<function_results>") ||
    cleanResponse.includes("<continue_after_tool_results")
  ) {
    const parsed = parseInternalControlTagsFromResponse(cleanResponse);
    cleanResponse = parsed.cleanResponse;
  } else if (!options.preserveWhitespace) {
    cleanResponse = cleanResponse.trim();
  }

  return { cleanResponse, toolCalls, extractedTags };
}

/**
 * Unified AI Chat endpoint with comprehensive multimodal support
 * Handles text, images, audio, video, and documents across all providers
 *
 * @param request - The chat request
 * @param config - The provider configuration
 * @param env - The environment variables
 * @param stream - The stream callback
 * @returns The chat response
 */

export async function chat(
  request: ChatRequest,
  config: ProviderConfig,
  env: Record<string, string> = {},
  stream?: StreamCallback,
  providerRegistry?: ProviderRegistry,
): Promise<ChatResponse> {
  // Handle mock responses
  if (request.answer) {
    return createMockResponse(request);
  }
  const baseConfig = {
    ...config,
    ...request.config,
  } as ProviderConfig;

  const providerFromRequest =
    (request as ChatRequest & { provider?: ProviderName })
      .provider;
  if (!baseConfig.provider && providerFromRequest) {
    baseConfig.provider = providerFromRequest;
  }
  if (!baseConfig.provider) {
    throw new Error("No LLM provider configured for chat request");
  }

  // Format messages — merge provider `config` into the request so
  // `limitEstimatedInputTokens` (and any future ChatRequest-scoped options)
  // apply. `llm_call` passes LLM options only via the second argument, so
  // `request.config` is often undefined.
  const messages = formatMessages({
    ...request,
    messages: request.messages,
    config: toLLMConfig(baseConfig),
  });

  const attemptConfigs = [
    buildAttemptConfig(baseConfig, env),
    ...(baseConfig.fallbacks ?? []).map((fallback) =>
      buildAttemptConfig(baseConfig, env, fallback)
    ),
  ];

  let lastError: unknown = null;
  const attempts: LLMProviderAttempt[] = [];
  const registry = await getProviderRegistry(providerRegistry);

  for (let index = 0; index < attemptConfigs.length; index++) {
    const attemptConfig = attemptConfigs[index];
    const attemptProvider = attemptConfig.provider!;
    const providerFactory = registry[attemptProvider];
    if (!providerFactory) {
      throw new Error(
        `Provider '${attemptProvider}' is not supported. Available providers: ${
          Object.keys(registry).join(", ")
        }`,
      );
    }
    const providerAPI = providerFactory(attemptConfig);
    const localStopSequences = getLocalStopSequences(attemptConfig);
    const requestConfig = {
      ...attemptConfig,
      stop: undefined,
      stopSequences: undefined,
    } satisfies ProviderConfig;
    let visibleStreamStarted = false;
    const trackedStream = stream
      ? ((chunk: string, options?: { isReasoning?: boolean }) => {
        if (chunk.length > 0 || options?.isReasoning) {
          visibleStreamStarted = true;
        }
        stream(chunk, options);
      })
      : undefined;

    try {
      const runProviderStream = async (
        runMessages: ChatMessage[],
        onStream: StreamCallback | undefined,
      ) => {
        const finalMessages = providerAPI.transformMessages
          ? providerAPI.transformMessages(runMessages)
          : runMessages;
        const abortController = new AbortController();
        const response = await streamPost(
          providerAPI.endpoint,
          providerAPI.body(
            Array.isArray(finalMessages) ? finalMessages : runMessages,
            requestConfig,
          ),
          {
            headers: providerAPI.headers(requestConfig),
            signal: abortController.signal,
          },
        ) as StreamResponse;

        const reader = response.stream.getReader();
        return await processStream(
          reader,
          onStream || (() => {}),
          providerAPI.extractContent,
          {
            ...providerAPI.streamOptions,
            config: attemptConfig,
            extractedBlockTags: request.extractTags,
            extractUsage: providerAPI.extractUsage,
            extractFinishReason: providerAPI.extractFinishReason,
            localStopSequences,
            onLocalStop: () => abortController.abort(),
          },
        );
      };

      let streamResult = await runProviderStream(messages, trackedStream);

      let cleanResponse = streamResult.content;
      let toolCalls: ToolInvocation[] = [];
      let extractedTags: Record<string, string[]> = {};
      let parsedResponse = parseAssistantResponse(
        streamResult.content,
        request.extractTags ?? [],
      );
      cleanResponse = parsedResponse.cleanResponse;
      toolCalls = parsedResponse.toolCalls;
      extractedTags = parsedResponse.extractedTags;
      let aggregateUsage = streamResult.usage;
      let aggregateReasoning = streamResult.reasoning;
      let finalFinishReason: ProviderFinishReason | null =
        streamResult.finishReason;

      if (
        streamResult.finishReason === "length" &&
        hasDanglingFunctionCallsBlock(streamResult.content)
      ) {
        for (let i = 0; i < MAX_TOOL_CALL_REPAIR_ROUNDS; i++) {
          const repairResult = await runProviderStream([
            ...messages,
            { role: "assistant", content: streamResult.content },
            { role: "user", content: TOOL_CALL_REPAIR_CUE },
          ], undefined);
          aggregateUsage = mergeProviderUsage(
            aggregateUsage,
            repairResult.usage,
          );
          aggregateReasoning = `${aggregateReasoning}${repairResult.reasoning}`;
          finalFinishReason = repairResult.finishReason ?? finalFinishReason;

          const repaired = parseAssistantResponse(
            repairResult.content,
            request.extractTags ?? [],
          );
          if (repaired.toolCalls.length > 0) {
            toolCalls = repaired.toolCalls;
            extractedTags = mergeExtractedTags(
              extractedTags,
              repaired.extractedTags,
            );
            break;
          }
        }
      } else if (streamResult.finishReason === "length") {
        for (let i = 0; i < MAX_TEXT_CONTINUATION_ROUNDS; i++) {
          const continuationResult = await runProviderStream([
            ...messages,
            { role: "assistant", content: cleanResponse },
            { role: "user", content: TEXT_CONTINUATION_CUE },
          ], trackedStream);
          aggregateUsage = mergeProviderUsage(
            aggregateUsage,
            continuationResult.usage,
          );
          aggregateReasoning =
            `${aggregateReasoning}${continuationResult.reasoning}`;
          finalFinishReason = continuationResult.finishReason ??
            finalFinishReason;

          const continued = parseAssistantResponse(
            continuationResult.content,
            request.extractTags ?? [],
            { preserveWhitespace: true },
          );
          cleanResponse = `${cleanResponse}${continued.cleanResponse}`;
          extractedTags = mergeExtractedTags(
            extractedTags,
            continued.extractedTags,
          );
          if (continuationResult.finishReason !== "length") break;
        }
      }

      const usageStatus: TokenUsage["status"] = streamResult.stoppedByLocalStop
        ? "aborted"
        : "completed";
      const usage = normalizeProviderUsage(aggregateUsage, usageStatus) ??
        await estimateUsage(messages, cleanResponse, usageStatus);
      const cost = await estimateUsageCost(attemptConfig, usage ?? undefined);
      const totalTokens = usage.totalTokens ??
        await countTokens(messages, cleanResponse);

      const chatResponse: ChatResponse = {
        prompt: messages,
        answer: cleanResponse,
        ...(aggregateReasoning && { reasoning: aggregateReasoning }),
        tokens: totalTokens,
        finishReason: finalFinishReason,
        usage,
        ...(cost ? { cost } : {}),
        provider: attemptProvider,
        model: attemptConfig.model,
        ...(toolCalls.length > 0 && { toolCalls }),
        ...(Object.keys(extractedTags).length > 0 && { extractedTags }),
      };

      const responseWithMetadata = {
        ...chatResponse,
        metadata: {
          provider: attemptProvider,
          timestamp: new Date().toISOString(),
          messageCount: request.messages.length,
        },
      };

      return responseWithMetadata;
    } catch (error) {
      lastError = error;
      const reason = classifyLLMError(error);
      attempts.push({
        provider: attemptProvider,
        model: attemptConfig.model,
        reason,
        status: getErrorStatus(error),
        message: getErrorMessage(error),
      });

      const hasFallback = index < attemptConfigs.length - 1;
      if (
        !hasFallback ||
        visibleStreamStarted ||
        !shouldAttemptFallback(error, baseConfig.fallbackOn)
      ) {
        throw new LLMProviderError(getErrorMessage(error), {
          reason,
          provider: attemptProvider,
          model: attemptConfig.model,
          status: getErrorStatus(error),
          attempts,
          fallbackAttempted: attempts.length > 1,
          visibleStreamStarted,
          cause: error,
        });
      }
    }
  }

  if (lastError) {
    const lastAttempt = attempts[attempts.length - 1];
    throw new LLMProviderError(getErrorMessage(lastError), {
      reason: lastAttempt?.reason ?? classifyLLMError(lastError),
      provider: lastAttempt?.provider ?? baseConfig.provider,
      model: lastAttempt?.model ?? baseConfig.model,
      status: lastAttempt?.status ?? getErrorStatus(lastError),
      attempts,
      fallbackAttempted: attempts.length > 1,
      cause: lastError,
    });
  }
  throw new Error(
    "LLM chat exhausted all attempts without returning a response",
  );
}

export * from "@/runtime/llm/types.ts";
