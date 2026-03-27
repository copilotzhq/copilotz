import type {
  ChatRequest,
  ChatResponse,
  ProviderFallbackConfig,
  ProviderFallbackReason,
  ProviderConfig,
  ProviderName,
  StreamCallback,
  ToolInvocation,
} from "./types.ts";
import { getProvider } from "./providers/index.ts";
import {
  countTokens,
  createMockResponse,
  formatMessages,
  parseInternalControlTagsFromResponse,
  parseToolCallsFromResponse,
  processStream,
  withDefaultStopSequences,
} from "./utils.ts";
import { streamPost, type StreamResponse } from "../request/index.ts";

const DEFAULT_FALLBACK_REASONS: ProviderFallbackReason[] = [
  "timeout",
  "network",
  "rate_limit",
  "server_error",
  "provider_error",
];

function resolveApiKey(
  config: ProviderConfig,
  env: Record<string, string>,
): string | undefined {
  const provider = config.provider;
  if (!provider) {
    return config.apiKey || env.OPENAI_API_KEY;
  }

  return config.apiKey ||
    env[`${provider.toUpperCase()}_API_KEY`] ||
    env[`${provider.toUpperCase()}_KEY`] ||
    env.OPENAI_API_KEY;
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

  candidate.apiKey = resolveApiKey(candidate, env);
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

  for (let index = 0; index < attemptConfigs.length; index++) {
    const attemptConfig = attemptConfigs[index];
    const attemptProvider = attemptConfig.provider!;
    const providerFactory = getProvider(attemptProvider);
    const providerAPI = providerFactory(attemptConfig);
    const finalMessages = providerAPI.transformMessages
      ? providerAPI.transformMessages(messages)
      : messages;

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
      const response = await streamPost(
        providerAPI.endpoint,
        providerAPI.body(
          Array.isArray(finalMessages) ? finalMessages : messages,
          attemptConfig,
        ),
        {
          headers: providerAPI.headers(attemptConfig),
        },
      ) as StreamResponse;

      const reader = response.stream.getReader();
      const streamResult = await processStream(
        reader,
        trackedStream || (() => {}),
        providerAPI.extractContent,
        { ...providerAPI.streamOptions, config: attemptConfig },
      );

      let cleanResponse = streamResult.content;
      let toolCalls: ToolInvocation[] = [];
      {
        const parsed = parseToolCallsFromResponse(streamResult.content);
        cleanResponse = parsed.cleanResponse;
        toolCalls = parsed.tool_calls;
      }
      {
        const parsed = parseInternalControlTagsFromResponse(cleanResponse);
        cleanResponse = parsed.cleanResponse;
      }

      const chatResponse: ChatResponse = {
        prompt: messages,
        answer: cleanResponse,
        ...(streamResult.reasoning && { reasoning: streamResult.reasoning }),
        tokens: await countTokens(messages, streamResult.content),
        provider: attemptProvider,
        model: attemptConfig.model,
        ...(toolCalls.length > 0 && { toolCalls }),
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

export * from "./types.ts";
