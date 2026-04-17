import type {
  ChatRequest,
  ChatResponse,
  ProviderFallbackConfig,
  ProviderFallbackReason,
  ProviderConfig,
  ProviderName,
  StreamCallback,
  ToolInvocation,
} from "@/runtime/llm/types.ts";
import { estimateUsageCost } from "@/runtime/llm/pricing.ts";
import { resolveProviderApiKey } from "@/runtime/llm/config.ts";
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

function classifyFallbackReason(error: unknown): ProviderFallbackReason | null {
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
  const reason = classifyFallbackReason(error);
  if (!reason) return false;

  const allowedReasons = Array.isArray(fallbackOn) && fallbackOn.length > 0
    ? fallbackOn
    : DEFAULT_FALLBACK_REASONS;

  return allowedReasons.includes(reason);
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

  const providerFromRequest = (request as ChatRequest & { provider?: ProviderName })
    .provider;
  if (!baseConfig.provider && providerFromRequest) {
    baseConfig.provider = providerFromRequest;
  }
  if (!baseConfig.provider) {
    throw new Error("No LLM provider configured for chat request");
  }

  // Format messages
  const messages = formatMessages({
    ...request,
    messages: request.messages,
  });

  const attemptConfigs = [
    buildAttemptConfig(baseConfig, env),
    ...(baseConfig.fallbacks ?? []).map((fallback) =>
      buildAttemptConfig(baseConfig, env, fallback)
    ),
  ];

  let lastError: unknown = null;
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
    const finalMessages = providerAPI.transformMessages
      ? providerAPI.transformMessages(messages)
      : messages;

    let visibleStreamStarted = false;
    const abortController = new AbortController();
    const trackedStream = stream
      ? ((chunk: string, options?: { isReasoning?: boolean }) => {
        if (chunk.length > 0 || options?.isReasoning) {
          visibleStreamStarted = true;
        }
        stream(chunk, options);
      })
      : undefined;

    try {
      const response = await streamPost(
        providerAPI.endpoint,
        providerAPI.body(
          Array.isArray(finalMessages) ? finalMessages : messages,
          requestConfig,
        ),
        {
          headers: providerAPI.headers(requestConfig),
          signal: abortController.signal,
        },
      ) as StreamResponse;

      const reader = response.stream.getReader();
      const streamResult = await processStream(
        reader,
        trackedStream || (() => {}),
        providerAPI.extractContent,
        {
          ...providerAPI.streamOptions,
          config: attemptConfig,
          extractedBlockTags: request.extractTags,
          extractUsage: providerAPI.extractUsage,
          localStopSequences,
          onLocalStop: () => abortController.abort(),
        },
      );

      let cleanResponse = streamResult.content;
      let toolCalls: ToolInvocation[] = [];
      let extractedTags: Record<string, string[]> = {};
      {
        const parsed = parseToolCallsFromResponse(streamResult.content);
        cleanResponse = parsed.cleanResponse;
        toolCalls = parsed.tool_calls;
      }
      {
        const parsed = parseTaggedBlocksFromResponse(
          cleanResponse,
          request.extractTags ?? [],
        );
        cleanResponse = parsed.cleanResponse;
        extractedTags = parsed.extractedTags;
      }
      {
        const parsed = parseInternalControlTagsFromResponse(cleanResponse);
        cleanResponse = parsed.cleanResponse;
      }

      const usageStatus: TokenUsage["status"] = streamResult.stoppedByLocalStop
        ? "aborted"
        : "completed";
      const usage = normalizeProviderUsage(streamResult.usage, usageStatus) ??
        await estimateUsage(messages, streamResult.content, usageStatus);
      const cost = await estimateUsageCost(attemptConfig, usage ?? undefined);
      const totalTokens = usage.totalTokens ??
        await countTokens(messages, streamResult.content);

      const chatResponse: ChatResponse = {
        prompt: messages,
        answer: cleanResponse,
        ...(streamResult.reasoning && { reasoning: streamResult.reasoning }),
        tokens: totalTokens,
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

      const hasFallback = index < attemptConfigs.length - 1;
      if (
        !hasFallback ||
        visibleStreamStarted ||
        !shouldAttemptFallback(error, baseConfig.fallbackOn)
      ) {
        throw error;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("LLM chat exhausted all attempts without returning a response");
}

export * from "@/runtime/llm/types.ts";
