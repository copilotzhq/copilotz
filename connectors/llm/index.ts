import type {
  ChatRequest,
  ChatResponse,
  ProviderConfig,
  StreamCallback,
} from "./types.ts";
import { getProvider } from "./providers/index.ts";
import {
  countTokens,
  createMockResponse,
  formatMessages,
  parseToolCallsFromResponse,
  processStream,
  withDefaultStopSequences,
} from "./utils.ts";
import { streamPost, type StreamResponse } from "../request/index.ts";

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
  // Get provider from config or request
  const provider = config.provider || (request as any).provider;

  // Merge configurations
  const mergedConfig = withDefaultStopSequences({
    ...config,
    ...request.config,
    // Environment variables fallback (supports OPENAI_API_KEY and OPENAI_KEY-style names)
    apiKey: config.apiKey ||
      env[`${provider.toUpperCase()}_API_KEY`] ||
      env[`${provider.toUpperCase()}_KEY`] ||
      env.OPENAI_API_KEY,
  } as ProviderConfig);

  // Get provider API configuration
  const providerFactory = getProvider(provider);
  const providerAPI = providerFactory(mergedConfig);

  // Format messages
  let messages = formatMessages({
    ...request,
    messages: request.messages,
  });

  // Transform messages if needed (e.g., Anthropic, Gemini)
  const finalMessages = providerAPI.transformMessages
    ? providerAPI.transformMessages(messages)
    : messages;

  console.log("Final Messages", finalMessages);

  // Make API request using request connector
  const response = await streamPost(
    providerAPI.endpoint,
    providerAPI.body(
      Array.isArray(finalMessages) ? finalMessages : messages,
      mergedConfig,
    ),
    {
      headers: providerAPI.headers(mergedConfig),
    },
  ) as StreamResponse;

  const reader = response.stream.getReader();

  // Handle streaming response — all providers go through the shared processStream.
  // Provider-specific differences (SSE vs JSONL, reasoning extraction, post-processing)
  // are expressed via extractContent and streamOptions, not custom loops.
  const streamResult = await processStream(
    reader,
    stream || (() => {}),
    providerAPI.extractContent,
    { ...providerAPI.streamOptions, config: mergedConfig },
  );

  console.log("Stream result: ", streamResult);

  // Parse tool calls from response and strip them from the final answer
  let cleanResponse = streamResult.content;
  let tool_calls: any[] = [];
  {
    const parsed = parseToolCallsFromResponse(streamResult.content);
    cleanResponse = parsed.cleanResponse;
    tool_calls = parsed.tool_calls;
  }

  // Prepare comprehensive response
  const chatResponse: ChatResponse = {
    prompt: messages,
    answer: cleanResponse,
    ...(streamResult.reasoning && { reasoning: streamResult.reasoning }),
    tokens: await countTokens(messages, streamResult.content),
    provider,
    model: mergedConfig.model,
    ...(tool_calls.length > 0 && { toolCalls: tool_calls }),
  };

  // Add execution metadata
  const responseWithMetadata = {
    ...chatResponse,
    metadata: {
      provider,
      timestamp: new Date().toISOString(),
      messageCount: request.messages.length,
    },
  };

  return responseWithMetadata;
}

export * from "./types.ts";
