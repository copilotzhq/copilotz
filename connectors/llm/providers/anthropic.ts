import type { ProviderFactory, ProviderConfig, ChatMessage, ChatContentPart } from '../types.ts';

export const anthropicProvider: ProviderFactory = (config: ProviderConfig) => {
  const transformMessages = (messages: ChatMessage[]) => {
    // Anthropic requires system prompts to be separate from messages
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
        // Anthropic expects content blocks: { type: 'text'|'image', ... }
        let contentBlocks: any[] = [];
        if (typeof msg.content === 'string') {
          contentBlocks = [{ type: 'text', text: msg.content }];
        } else if (Array.isArray(msg.content)) {
          contentBlocks = (msg.content as ChatContentPart[]).flatMap((p) => {
            if (p.type === 'text') return [{ type: 'text', text: p.text }];
            if (p.type === 'image_url' && p.image_url?.url) {
              const url = p.image_url.url;
              if (typeof url === 'string' && url.startsWith('data:')) {
                const header = url.substring(5); // mime;base64,....
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
                const header = fileData.substring(5); // mime;base64,....
                const [mimeType, base64Data] = header.split(';base64,');
                if (base64Data) {
                  return [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } }];
                }
              }
            }
            // input_audio not supported in this path yet
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

      return {
        model: config.model || 'claude-3-haiku-20240307',
        messages: transformed.messages,
        stream: true,
        temperature: config.temperature || 0,
        max_tokens: config.maxTokens || 1000,
        top_p: config.topP,
        top_k: config.topK,
        stop_sequences: config.stopSequences || config.stop,
        system: transformed.system,
        metadata: config.metadata,
      };
    },

    extractContent: (data: any) => {
      return data?.delta?.text || null;
    },

  };
}; 