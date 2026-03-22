import type { ChatRequest, ChatResponse, StreamCallback, ProviderConfig } from './types.ts';
import { getProvider } from './providers/index.ts';
import { formatMessages, countTokens, createMockResponse, processStream, parseToolCallsFromResponse, buildFunctionCallsBlock } from './utils.ts';
import { streamPost, type StreamResponse } from '../request/index.ts';

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
    stream?: StreamCallback
): Promise<ChatResponse> {
    // Handle mock responses
    if (request.answer) {
        return createMockResponse(request);
    }
    // Get provider from config or request
    const provider = config.provider || (request as any).provider;

    // Merge configurations
    const mergedConfig: ProviderConfig = {
        ...config,
        ...request.config,
        // Environment variables fallback (supports OPENAI_API_KEY and OPENAI_KEY-style names)
        apiKey: config.apiKey ||
            env[`${provider.toUpperCase()}_API_KEY`] ||
            env[`${provider.toUpperCase()}_KEY`] ||
            env.OPENAI_API_KEY,
    };

    // Get provider API configuration
    const providerFactory = getProvider(provider);
    const providerAPI = providerFactory(mergedConfig);

    // Format messages
    let messages = formatMessages({
        ...request,
        messages: request.messages
    });

    // Rehydrate <function_calls> for assistant messages from either top-level toolCalls or metadata.toolCalls
    messages = messages.map(m => {
        if (m.role === 'assistant') {
            const toolCalls = (m as any).toolCalls;
            if (toolCalls && Array.isArray(toolCalls)) {
                try {
                    const block = buildFunctionCallsBlock(toolCalls);
                    m.content = `${block}\n${m.content}`;
                } catch { /* ignore malformed */ }
            }
        }
        return m;
    });

    // Transform messages if needed (e.g., Anthropic, Gemini)
    const finalMessages = providerAPI.transformMessages
        ? providerAPI.transformMessages(messages)
        : messages;

    // Make API request using request connector
    const response = await streamPost(
        providerAPI.endpoint,
        providerAPI.body(
            Array.isArray(finalMessages) ? finalMessages : messages,
            mergedConfig
        ),
        {
            headers: providerAPI.headers(mergedConfig)
        }
    ) as StreamResponse;

    const reader = response.stream.getReader();

    // Handle streaming response — all providers go through the shared processStream.
    // Provider-specific differences (SSE vs JSONL, reasoning extraction, post-processing)
    // are expressed via extractContent and streamOptions, not custom loops.
    const fullResponse = await processStream(
        reader,
        stream || (() => { }),
        providerAPI.extractContent,
        { ...providerAPI.streamOptions, config: mergedConfig },
    );

    // Parse tool calls from response and strip them from the final answer
    let cleanResponse = fullResponse;
    let tool_calls: any[] = [];
    {
        const parsed = parseToolCallsFromResponse(fullResponse);
        cleanResponse = parsed.cleanResponse;
        tool_calls = parsed.tool_calls;
    }

    // Prepare comprehensive response
    const chatResponse: ChatResponse = {
        prompt: messages,
        answer: cleanResponse,
        tokens: await countTokens(messages, fullResponse),
        provider,
        model: mergedConfig.model,
        ...(tool_calls.length > 0 && { toolCalls: tool_calls })
    };

    // Add execution metadata
    const responseWithMetadata = {
        ...chatResponse,
        metadata: {
            provider,
            timestamp: new Date().toISOString(),
            messageCount: request.messages.length,
        }
    };

    return responseWithMetadata;
}


export * from './types.ts';