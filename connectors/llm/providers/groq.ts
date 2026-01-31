import type { ProviderFactory, ProviderConfig, ChatMessage, ChatContentPart } from '../types.ts';

export const groqProvider: ProviderFactory = (config: ProviderConfig) => {
  return {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    
    headers: (config: ProviderConfig) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    }),
    
    body: (messages: ChatMessage[], config: ProviderConfig) => {
      const groqMessages = messages.map(msg => {
        if (Array.isArray(msg.content)) {
          const parts = (msg.content as ChatContentPart[]).flatMap((p) => {
            if (p.type === 'text') return [{ type: 'text', text: p.text }];
            if (p.type === 'image_url' && p.image_url?.url) return [{ type: 'image_url', image_url: { url: p.image_url.url } }];
            if (p.type === 'file' && p.file?.file_data && typeof p.file.file_data === 'string' && p.file.file_data.startsWith('data:')) {
              return [{ type: 'image_url', image_url: { url: p.file.file_data } }];
            }
            // Groq likely does not support input_audio in Chat Completions yet; drop silently
            return [] as any[];
          });
          return { role: msg.role, content: parts } as any;
        }
        return { role: msg.role, content: msg.content } as any;
      });

      return {
        model: config.model || 'llama3-8b-8192',
        messages: groqMessages,
        stream: true,
        temperature: config.temperature || 0,
        max_tokens: config.maxTokens || 1000,
        top_p: config.topP,
        presence_penalty: config.presencePenalty,
        frequency_penalty: config.frequencyPenalty,
        stop: config.stop,
        response_format: config.responseType === 'json' 
          ? { type: 'json_object' } 
          : undefined,
      };
    },
    
    extractContent: (data: any) => {
      return data?.choices?.[0]?.delta?.content || null;
    }
  };
}; 