import type {
  ChatRequest,
  ChatResponse,
  ProviderConfig,
  ProviderFallbackConfig,
  ProviderName,
  ProviderRegistry,
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
  parseInternalControlTagsFromResponse,
  parseTaggedBlocksFromResponse,
  parseToolCallsFromResponse,
  withDefaultStopSequences,
} from "@/runtime/llm/utils.ts";
import { normalizeProviderUsage } from "@/runtime/llm/usage.ts";
import { runProviderStream } from "@/runtime/llm/stream.ts";
import {
  classifyLLMError,
  getErrorMessage,
  getErrorStatus,
  LLMProviderError,
  type LLMProviderAttempt,
} from "@/runtime/llm/errors.ts";

export { classifyLLMError, LLMProviderError } from "@/runtime/llm/errors.ts";
export type { LLMProviderAttempt } from "@/runtime/llm/errors.ts";

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
  const fallbackChangesProvider = override?.provider &&
    override.provider !== baseConfig.provider;
  const candidate = {
    ...baseConfig,
    ...(override ?? {}),
    ...(fallbackChangesProvider && !override?.apiKey
      ? { apiKey: undefined }
      : {}),
    fallbacks: undefined,
  } as ProviderConfig;

  candidate.apiKey = resolveProviderApiKey(candidate, env);
  return withDefaultStopSequences(candidate);
}

function parseAssistantResponse(
  response: string,
  extractedBlockTags: string[] = [],
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
    toolCalls = parsed.toolCalls;
  }
  if (extractedBlockTags.length > 0) {
    const parsed = parseTaggedBlocksFromResponse(
      cleanResponse,
      extractedBlockTags,
    );
    cleanResponse = parsed.cleanResponse;
    extractedTags = parsed.extractedTags;
  } else {
    cleanResponse = cleanResponse.trim();
  }
  if (
    cleanResponse.includes("<no_response") ||
    cleanResponse.includes("<tool_results>") ||
    cleanResponse.includes("<continue_after_tool_results")
  ) {
    const parsed = parseInternalControlTagsFromResponse(cleanResponse);
    cleanResponse = parsed.cleanResponse;
  } else {
    cleanResponse = cleanResponse.trim();
  }

  return { cleanResponse, toolCalls, extractedTags };
}

function warnFallbackAttempt(
  error: unknown,
  attempt: ProviderConfig,
  reason: string | null,
  nextAttempt: ProviderConfig,
): void {
  try {
    console.warn("[llm] Attempting fallback after provider error", {
      provider: attempt.provider,
      model: attempt.model,
      reason,
      message: getErrorMessage(error),
      fallbackProvider: nextAttempt.provider,
      fallbackModel: nextAttempt.model,
    });
  } catch {
    // Ignore logging failures.
  }
}

/**
 * Unified AI Chat endpoint.
 *
 * Streams an LLM response through the configured provider.
 * Falls back to alternative providers on error when `config.fallbacks`
 * is set and visible streaming hasn't started yet.
 */
export async function chat(
  request: ChatRequest,
  config: ProviderConfig,
  env: Record<string, string> = {},
  stream?: StreamCallback,
  providerRegistry?: ProviderRegistry,
): Promise<ChatResponse> {
  if (request.answer) {
    return createMockResponse(request);
  }

  const baseConfig = {
    ...config,
    ...request.config,
  } as ProviderConfig;

  const providerFromRequest =
    (request as ChatRequest & { provider?: ProviderName }).provider;
  if (!baseConfig.provider && providerFromRequest) {
    baseConfig.provider = providerFromRequest;
  }
  if (!baseConfig.provider) {
    throw new Error("No LLM provider configured for chat request");
  }

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

  const registry = await getProviderRegistry(providerRegistry);
  let lastError: unknown = null;
  const attempts: LLMProviderAttempt[] = [];
  let recoveryPrefix = "";

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

    const trackedStream = stream
      ? ((chunk: string, options?: { isReasoning?: boolean }) => {
        if (chunk.length > 0 && !options?.isReasoning) {
          recoveryPrefix += chunk;
        }
        stream(chunk, options);
      })
      : undefined;

    const prefixBeforeAttempt = recoveryPrefix;
    const attemptMessages = prefixBeforeAttempt.length > 0
      ? [
        ...messages,
        { role: "assistant" as const, content: prefixBeforeAttempt },
        {
          role: "user" as const,
          content:
            "<recovery_instruction>Continue exactly where you left off. Do not repeat earlier content.</recovery_instruction>",
        },
      ]
      : messages;

    try {
      const streamResult = await runProviderStream(
        attemptMessages,
        trackedStream,
        attemptConfig,
        providerAPI,
        request.extractTags,
      );

      const fullContent = prefixBeforeAttempt + streamResult.content;
      const parsed = parseAssistantResponse(
        fullContent,
        request.extractTags ?? [],
      );

      const usageStatus = streamResult.stoppedByLocalStop
        ? "aborted"
        : "completed";
      const usage = normalizeProviderUsage(streamResult.usage, usageStatus) ??
        await estimateUsage(messages, parsed.cleanResponse, usageStatus);
      const cost = await estimateUsageCost(attemptConfig, usage ?? undefined);
      const totalTokens = usage.totalTokens ??
        await countTokens(messages, parsed.cleanResponse);

      return {
        prompt: messages,
        answer: parsed.cleanResponse,
        ...(streamResult.reasoning && { reasoning: streamResult.reasoning }),
        tokens: totalTokens,
        finishReason: streamResult.finishReason,
        usage,
        ...(cost ? { cost } : {}),
        provider: attemptProvider,
        model: attemptConfig.model,
        ...(parsed.toolCalls.length > 0 && { toolCalls: parsed.toolCalls }),
        ...(Object.keys(parsed.extractedTags).length > 0 && {
          extractedTags: parsed.extractedTags,
        }),
        metadata: {
          provider: attemptProvider,
          timestamp: new Date().toISOString(),
          messageCount: request.messages.length,
        },
      };
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

      warnFallbackAttempt(
        error,
        attemptConfig,
        reason,
        attemptConfigs[index + 1],
      );
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
