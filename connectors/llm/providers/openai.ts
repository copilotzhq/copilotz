import type { ProviderFactory, ProviderConfig, ChatMessage, ChatContentPart, ExtractedPart, ProviderUsageUpdate } from '../types.ts';

function extractOpenAIUsage(data: any): ProviderUsageUpdate | null {
  const usage = data?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  return {
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
    reasoningTokens:
      typeof usage.completion_tokens_details?.reasoning_tokens === "number"
        ? usage.completion_tokens_details.reasoning_tokens
        : undefined,
    cacheReadInputTokens:
      typeof usage.prompt_tokens_details?.cached_tokens === "number"
        ? usage.prompt_tokens_details.cached_tokens
        : undefined,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
    rawUsage: usage as Record<string, unknown>,
  };
}

export const openaiProvider: ProviderFactory = (config: ProviderConfig) => {
  return {
    endpoint: 'https://api.openai.com/v1/chat/completions',

    headers: (config: ProviderConfig) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    }),

    body: (messages: ChatMessage[], config: ProviderConfig) => {
      const openaiMessages = messages.map(msg => {
        if (Array.isArray(msg.content)) {
          const parts = (msg.content as ChatContentPart[]).flatMap((p) => {
            if (p.type === 'text') {
              return [{ type: 'text', text: p.text }];
            }
            if (p.type === 'image_url' && p.image_url?.url) {
              return [{ type: 'image_url', image_url: { url: p.image_url.url } }];
            }
            if (p.type === 'input_audio' && p.input_audio?.data) {
              return [{ type: 'input_audio', input_audio: { data: p.input_audio.data, format: p.input_audio.format || 'wav' } }];
            }
            if (p.type === 'file' && p.file?.file_data) {
              const data = p.file.file_data;
              if (typeof data === 'string' && data.startsWith('data:')) {
                return [{ type: 'image_url', image_url: { url: data } }];
              }
            }
            return [] as any[];
          });
          return { role: msg.role, content: parts } as any;
        }
        return { role: msg.role, content: msg.content } as any;
      });

      const modelName = config.model || 'gpt-4o-mini';
      const bodyConfig: any = {
        model: modelName,
        messages: openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: config.temperature || 1,
        top_p: config.topP,
        presence_penalty: config.presencePenalty,
        frequency_penalty: config.frequencyPenalty,
        stop: config.stop,
        seed: config.seed,
        user: config.user,
        reasoning_effort: config.reasoningEffort,
        verbosity: config.verbosity,
        response_format: config.responseType === 'json'
          ? { type: 'json_object' }
          : undefined,
      };

      {
        const maxComp = config.maxCompletionTokens ?? config.maxTokens ?? 1000;
        if (typeof maxComp === 'number') bodyConfig.max_completion_tokens = maxComp;
      }

      return bodyConfig;
    },

    extractContent: (data: any): ExtractedPart[] | null => {
      const delta = data?.choices?.[0]?.delta;
      if (!delta || typeof delta !== "object") return null;

      const parts: ExtractedPart[] = [];

      const reasoning = delta.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        parts.push({ text: reasoning, isReasoning: true });
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        parts.push({ text: delta.content });
      }

      return parts.length > 0 ? parts : null;
    },

    extractUsage: extractOpenAIUsage,
  };
};
