import type { ProviderFactory, ProviderConfig, ChatMessage, ChatContentPart, StreamCallback } from '../types.ts';

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

    processStream: async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      onChunk: StreamCallback,
      _extractContent: (data: any) => string | null,
      config: ProviderConfig,
    ): Promise<string> => {
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let fullResponse = "";

      const parseLine = (line: string): any | null => {
        if (!line.startsWith("data:")) return null;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      };

      const handleData = (data: any) => {
        if (data.type === "content_block_delta" && data.delta) {
          if (data.delta.type === "thinking_delta") {
            const thinkingChunk = data.delta.thinking || "";
            if (thinkingChunk && config.outputReasoning !== false) {
              onChunk(thinkingChunk, { isReasoning: true });
            }
          } else if (data.delta.type === "text_delta") {
            const textChunk = data.delta.text || "";
            if (textChunk) {
              onChunk(textChunk);
              fullResponse += textChunk;
            }
          }
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            if (buffer) {
              for (const line of buffer.split("\n")) {
                const data = parseLine(line);
                if (data) handleData(data);
              }
            }
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const data = parseLine(line);
            if (data) handleData(data);
          }
        }
      } catch (error) {
        console.error("Anthropic Stream processing error:", error);
        throw error;
      }

      return fullResponse;
    },
  };
}; 