/** DeepSeek provider adapter wire protocol. @module */
// deno-lint-ignore-file no-explicit-any
// Private vendor-wire decoder: payload shapes are provider-controlled JSON.
import type {
  ChatContentPart,
  ChatMessage,
  ExtractedPart,
  ProviderConfig,
  ProviderFactory,
  ProviderFinishReason,
  ProviderUsageUpdate,
} from "../../internal/types.ts";
import { providerEndpoint } from "../transport/index.ts";
import {
  matchingNativeBlocks,
  stringField,
} from "../native-reasoning/index.ts";

function extractDeepSeekUsage(data: any): ProviderUsageUpdate | null {
  const usage = data?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  return {
    inputTokens: typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : undefined,
    outputTokens: typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : undefined,
    reasoningTokens:
      typeof usage.completion_tokens_details?.reasoning_tokens === "number"
        ? usage.completion_tokens_details.reasoning_tokens
        : undefined,
    cacheReadInputTokens: typeof usage.prompt_cache_hit_tokens === "number"
      ? usage.prompt_cache_hit_tokens
      : undefined,
    totalTokens: typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : undefined,
    rawUsage: usage as Record<string, unknown>,
  };
}

function extractOpenAICompatibleFinishReason(
  data: any,
): ProviderFinishReason | null {
  const reason = data?.choices?.[0]?.finish_reason;
  if (reason === "length") return "length";
  if (reason === "stop") return "stop";
  if (reason === "tool_calls" || reason === "function_call") {
    return "tool_calls";
  }
  if (reason === "content_filter") return "content_filter";
  return typeof reason === "string" ? "unknown" : null;
}

export const deepseekProvider: ProviderFactory = (config: ProviderConfig) => {
  let reasoningContent = "";

  return {
    endpoint: providerEndpoint(
      config.baseUrl,
      "https://api.deepseek.com/v1",
      "chat/completions",
    ),

    headers: (config: ProviderConfig) => ({
      ...(config.extraHeaders ?? {}),
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    }),

    body: (messages: ChatMessage[], config: ProviderConfig) => {
      // DeepSeek chat is text-first; flatten non-text to text
      const dsMessages = messages.map((msg) => {
        const nativeBlocks = matchingNativeBlocks(
          msg,
          config,
          "deepseek",
          "deepseek.chat.completions",
          config.model || "deepseek-chat",
        );
        const nativeReasoning = nativeBlocks?.map((block) =>
          stringField(block, "reasoning_content")
        ).filter((value): value is string => value !== undefined).join("");
        if (Array.isArray(msg.content)) {
          const text = (msg.content as ChatContentPart[])
            .filter((p) => p.type === "text")
            .map((p) => (p as Extract<ChatContentPart, { type: "text" }>).text)
            .join("");
          return {
            role: msg.role,
            content: text,
            ...(nativeReasoning ? { reasoning_content: nativeReasoning } : {}),
          } as any;
        }
        return {
          role: msg.role,
          content: msg.content,
          ...(nativeReasoning ? { reasoning_content: nativeReasoning } : {}),
        } as any;
      });

      return {
        model: config.model || "deepseek-chat",
        messages: dsMessages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: config.temperature || 0,
        max_tokens: config.maxTokens || 1000,
        top_p: config.topP,
        presence_penalty: config.presencePenalty,
        frequency_penalty: config.frequencyPenalty,
        stop: config.stop,
        response_format: config.responseType === "json"
          ? { type: "json_object" }
          : undefined,
      };
    },

    extractContent: (data: any): ExtractedPart[] | null => {
      const delta = data?.choices?.[0]?.delta;
      const parts: ExtractedPart[] = [];
      if (
        typeof delta?.reasoning_content === "string" && delta.reasoning_content
      ) {
        parts.push({ text: delta.reasoning_content, isReasoning: true });
      }
      if (typeof delta?.content === "string" && delta.content) {
        parts.push({ text: delta.content });
      }
      return parts.length > 0 ? parts : null;
    },

    nativeReasoningApi: "deepseek.chat.completions",
    extractNativeReasoning: (data: any): Record<string, unknown>[] | null => {
      const choice = data?.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.reasoning_content === "string") {
        reasoningContent += delta.reasoning_content;
      }
      return choice?.finish_reason === "stop" && reasoningContent
        ? [{ reasoning_content: reasoningContent }]
        : null;
    },
    isStreamActivity: (data: any) => Boolean(data?.choices?.[0]),
    extractUsage: extractDeepSeekUsage,
    extractFinishReason: extractOpenAICompatibleFinishReason,
  };
};
