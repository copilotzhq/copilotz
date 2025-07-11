import type { ProviderFactory, ProviderConfig, ChatMessage } from '../types.ts';

interface GeminiPart {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string;
  };
}

interface GeminiMessage {
  parts: GeminiPart[];
  role: 'user' | 'model';
}

export const geminiProvider: ProviderFactory = (config: ProviderConfig) => {
  const transformMessages = (messages: ChatMessage[]) => {
    const systemPrompts: string[] = [];
    const geminiMessages: GeminiMessage[] = [];
    
    messages.forEach(msg => {
      if (msg.role === 'system') {
        systemPrompts.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
      } else {
        const parts: GeminiPart[] = [];
        
        // Handle multimodal content (OpenAI-style arrays)
        if (Array.isArray(msg.content)) {
          msg.content.forEach((item: any) => {
            if (item.type === 'text') {
              parts.push({ text: item.text });
            } else if (item.type === 'image_url' && item.image_url?.url) {
              // Convert OpenAI image format to Gemini format
              const url = item.image_url.url;
              if (url.startsWith('data:')) {
                const [mimeType, base64Data] = url.substring(5).split(';base64,');
                parts.push({
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Data
                  }
                });
              }
            } else if (item.type === 'input_audio' && item.input_audio?.data) {
              // Convert OpenAI audio format to Gemini format
              parts.push({
                inline_data: {
                  mime_type: `audio/${item.input_audio.format || 'wav'}`,
                  data: item.input_audio.data
                }
              });
            } else if (item.type === 'file' && item.file?.file_data) {
              // Convert OpenAI file format to Gemini format
              const fileData = item.file.file_data;
              if (fileData.startsWith('data:')) {
                const [mimeType, base64Data] = fileData.substring(5).split(';base64,');
                parts.push({
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Data
                  }
                });
              }
            }
          });
        } else {
          // Simple text content
          parts.push({ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
        }

        geminiMessages.push({
          parts,
          role: msg.role === 'user' ? 'user' : 'model'
        });
      }
    });

    return {
      messages: geminiMessages,
      systemInstruction: systemPrompts.length > 0 
        ? { parts: [{ text: systemPrompts.join('\n') }] }
        : undefined
    };
  };

  return {
    endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${config.model || 'gemini-2.0-flash-lite-preview-02-05'}:streamGenerateContent?key=${config.apiKey}&alt=sse`,
    
    headers: (config: ProviderConfig) => ({
      'Content-Type': 'application/json',
    }),
    
    transformMessages,
    
    body: (messages: ChatMessage[], config: ProviderConfig) => {
      const transformed = transformMessages(messages);
      
      const safetySettings = [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ];

      return {
        contents: transformed.messages,
        generationConfig: {
          temperature: config.temperature || 0,
          maxOutputTokens: config.maxTokens || 1000,
          topP: config.topP,
          topK: config.topK,
          candidateCount: config.candidateCount,
          stopSequences: config.stopSequences || config.stop,
          responseMimeType: config.responseType === 'json' 
            ? 'application/json' 
            : config.responseMimeType,
        },
        safetySettings,
        systemInstruction: transformed.systemInstruction,
      };
    },
    
    extractContent: (data: any) => {
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    }
  };
}; 