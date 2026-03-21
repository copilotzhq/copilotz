import type { ProviderFactory, ProviderConfig, ChatMessage, ChatContentPart, ExtractedPart } from '../types.ts';

export const ollamaProvider: ProviderFactory = (config: ProviderConfig) => {
  return {
    endpoint: `${config.baseUrl || config.apiKey || 'http://localhost:11434'}/api/chat`,
    
    headers: (config: ProviderConfig) => ({
      'Content-Type': 'application/json',
    }),
    
    body: (messages: ChatMessage[], config: ProviderConfig) => {
      const ollamaMessages = messages.map((msg) => {
        if (Array.isArray(msg.content)) {
          const parts = msg.content as ChatContentPart[];
          const text = parts
            .filter((p) => p.type === 'text')
            .map((p) => (p as Extract<ChatContentPart, { type: 'text' }>).text)
            .join('\n');
          const images: string[] = [];
          for (const p of parts) {
            if (p.type === 'image_url' && p.image_url?.url && p.image_url.url.startsWith('data:')) {
              const base64 = p.image_url.url.split(',')[1];
              if (base64) images.push(base64);
            } else if (p.type === 'file' && typeof p.file?.file_data === 'string' && p.file.file_data.startsWith('data:')) {
              const base64 = p.file.file_data.split(',')[1];
              if (base64) images.push(base64);
            }
          }
          const m: any = { role: msg.role, content: text };
          if (images.length > 0) m.images = images;
          return m;
        }
        return { role: msg.role, content: msg.content } as any;
      });

      return {
        model: config.model || 'llama3.2',
        messages: ollamaMessages,
        stream: true,
        options: {
          temperature: config.temperature || 0,
          num_predict: config.maxTokens || 1000,
          top_p: config.topP,
          top_k: config.topK,
          repeat_penalty: config.repeatPenalty,
          seed: config.seed,
          stop: config.stop,
          num_ctx: config.numCtx,
        },
      };
    },
    
    extractContent: (data: any): ExtractedPart[] | null => {
      const content = data?.message?.content;
      if (!content) return null;
      return [{ text: content }];
    },

    streamOptions: { format: 'jsonl' },
  };
}; 