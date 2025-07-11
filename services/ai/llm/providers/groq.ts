import type { ProviderFactory, ProviderConfig, ChatMessage } from '../types.ts';

export const groqProvider: ProviderFactory = (config: ProviderConfig) => {
  return {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    
    headers: (config: ProviderConfig) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    }),
    
    body: (messages: ChatMessage[], config: ProviderConfig) => ({
      model: config.model || 'llama3-8b-8192',
      messages,
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
    }),
    
    extractContent: (data: any) => {
      return data?.choices?.[0]?.delta?.content || null;
    }
  };
}; 