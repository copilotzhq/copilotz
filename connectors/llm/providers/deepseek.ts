import type { ProviderFactory, ProviderConfig, ChatMessage, ChatContentPart } from '../types.ts';

export const deepseekProvider: ProviderFactory = (config: ProviderConfig) => {
  return {
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    
    headers: (config: ProviderConfig) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    }),
    
    body: (messages: ChatMessage[], config: ProviderConfig) => {
      // DeepSeek chat is text-first; flatten non-text to text
      const dsMessages = messages.map((msg) => {
        if (Array.isArray(msg.content)) {
          const text = (msg.content as ChatContentPart[])
            .filter((p) => p.type === 'text')
            .map((p) => (p as Extract<ChatContentPart, { type: 'text' }>).text)
            .join('\n');
          return { role: msg.role, content: text } as any;
        }
        return { role: msg.role, content: msg.content } as any;
      });

      return {
        model: config.model || 'deepseek-chat',
        messages: dsMessages,
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