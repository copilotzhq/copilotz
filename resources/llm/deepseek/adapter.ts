import type {
  ChatContentPart,
  ChatMessage,
  ExtractedPart,
  ProviderConfig,
  ProviderFactory,
  ProviderFinishReason,
  ProviderUsageUpdate,
} from "@/runtime/llm/types.ts";

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
  return {
    endpoint: "https://api.deepseek.com/v1/chat/completions",

    headers: (config: ProviderConfig) => ({
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    }),

    body: (messages: ChatMessage[], config: ProviderConfig) => {
      // DeepSeek chat is text-first; flatten non-text to text
      const dsMessages = messages.map((msg) => {
        if (Array.isArray(msg.content)) {
          const text = (msg.content as ChatContentPart[])
            .filter((p) => p.type === "text")
            .map((p) => (p as Extract<ChatContentPart, { type: "text" }>).text)
            .join("\n");
          return { role: msg.role, content: text } as any;
        }
        return { role: msg.role, content: msg.content } as any;
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
      const content = data?.choices?.[0]?.delta?.content;
      if (!content) return null;
      return [{ text: content }];
    },

    extractUsage: extractDeepSeekUsage,
    extractFinishReason: extractOpenAICompatibleFinishReason,
  };
};
