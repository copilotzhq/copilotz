import type { ProviderFactory, ProviderConfig, ChatMessage, ChatContentPart, ExtractedPart } from '../types.ts';

const EFFORT_BUDGET_MAP: Record<string, number> = {
  minimal: 1024,
  low: 4096,
  medium: 16384,
  high: 65536,
};

export const anthropicProvider: ProviderFactory = (config: ProviderConfig) => {
  const transformMessages = (messages: ChatMessage[]) => {
    const systemPrompts: string[] = [];
    const userMessages: any[] = [];

    messages.forEach(msg => {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemPrompts.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          const text = (msg.content as ChatContentPart[])
            .filter(p => p.type === 'text')
            .map(p => (p as Extract<ChatContentPart, { type: 'text' }>).text)
            .join('\n');
          if (text) systemPrompts.push(text);
        }
      } else {
        let contentBlocks: any[] = [];
        if (typeof msg.content === 'string') {
          contentBlocks = [{ type: 'text', text: msg.content }];
        } else if (Array.isArray(msg.content)) {
          contentBlocks = (msg.content as ChatContentPart[]).flatMap((p) => {
            if (p.type === 'text') return [{ type: 'text', text: p.text }];
            if (p.type === 'image_url' && p.image_url?.url) {
              const url = p.image_url.url;
              if (typeof url === 'string' && url.startsWith('data:')) {
                const header = url.substring(5);
                const [mimeType, base64Data] = header.split(';base64,');
                if (base64Data) {
                  return [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } }];
                }
              }
              return [{ type: 'image', source: { type: 'url', url } }];
            }
            if (p.type === 'file' && p.file?.file_data) {
              const fileData = p.file.file_data;
              if (typeof fileData === 'string' && fileData.startsWith('data:')) {
                const header = fileData.substring(5);
                const [mimeType, base64Data] = header.split(';base64,');
                if (base64Data) {
                  return [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } }];
                }
              }
            }
            return [] as any[];
          });
        }
        userMessages.push({ role: msg.role, content: contentBlocks });
      }
    });

    return {
      messages: userMessages,
      system: systemPrompts.join('\n') || undefined
    };
  };

  return {
    endpoint: 'https://api.anthropic.com/v1/messages',

    headers: (config: ProviderConfig) => ({
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey || '',
      'anthropic-version': '2023-06-01',
    }),

    transformMessages,

    body: (messages: ChatMessage[], config: ProviderConfig) => {
      const transformed = transformMessages(messages);

      const budgetTokens = config.reasoningEffort
        ? EFFORT_BUDGET_MAP[config.reasoningEffort]
        : undefined;
      const maxTokens = config.maxTokens || 1000;

      const body: Record<string, unknown> = {
        model: config.model || 'claude-3-haiku-20240307',
        messages: transformed.messages,
        stream: true,
        temperature: config.temperature || 0,
        max_tokens: budgetTokens ? Math.max(maxTokens, budgetTokens + 1) : maxTokens,
        top_p: config.topP,
        top_k: config.topK,
        stop_sequences: config.stopSequences || config.stop,
        system: transformed.system,
        metadata: config.metadata,
      };

      if (budgetTokens) {
        body.thinking = { type: "enabled", budget_tokens: budgetTokens };
        delete body.temperature;
      }

      return body;
    },

    extractContent: (data: any): ExtractedPart[] | null => {
      if (data.type !== 'content_block_delta' || !data.delta) return null;
      const parts: ExtractedPart[] = [];

      if (data.delta.type === 'thinking_delta') {
        const thinking = data.delta.thinking || '';
        if (thinking) parts.push({ text: thinking, isReasoning: true });
      } else if (data.delta.type === 'text_delta') {
        const text = data.delta.text || '';
        if (text) parts.push({ text });
      }

      return parts.length > 0 ? parts : null;
    },
  };
};
