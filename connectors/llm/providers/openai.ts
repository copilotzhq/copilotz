import type { ProviderFactory, ProviderConfig, ChatMessage, ChatContentPart } from '../types.ts';

// Helper function to check if a model is a reasoning model
function isReasoningModel(model: string): boolean {
  return model.startsWith('o3') || model.startsWith('o4') || model.includes('o1') || model.startsWith('gpt-5');
}

function isGPT5Model(model: string): boolean {
  return model.startsWith('gpt-5');
}

export const openaiProvider: ProviderFactory = (config: ProviderConfig) => {
  return {
    endpoint: 'https://api.openai.com/v1/chat/completions',

    headers: (config: ProviderConfig) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    }),

    body: (messages: ChatMessage[], config: ProviderConfig) => {
      // Transform messages to OpenAI content parts
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
              // If it's a data URL for an image, convert to image_url
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

      // Token limits: OpenAI chat completions expects max_completion_tokens
      {
        const maxComp = config.maxCompletionTokens ?? config.maxTokens ?? 1000;
        if (typeof maxComp === 'number') bodyConfig.max_completion_tokens = maxComp;
      }

      return bodyConfig;
    },

    extractContent: (data: any) => {
      return data?.choices?.[0]?.delta?.content || null;
    },

  };
}; 