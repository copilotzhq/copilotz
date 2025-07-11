import type { ProviderFactory, ProviderConfig, ChatMessage, StreamCallback } from '../types.ts';

/**
 * Special handler for Ollama's JSONL streaming format
 */
export async function processOllamaStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onChunk: StreamCallback,
    extractContent: (data: any) => string | null
): Promise<string> {
    const decoder = new TextDecoder('utf-8');
    let fullResponse = '';
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                // Process any remaining buffered data
                if (buffer.trim()) {
                    try {
                        const data = JSON.parse(buffer.trim());
                        const content = extractContent(data);
                        if (content) {
                            onChunk(content);
                            fullResponse += content;
                        }
                    } catch (error) {
                        console.warn('Failed to parse remaining Ollama data:', error);
                    }
                }
                break;
            }

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const data = JSON.parse(line.trim());
                        const content = extractContent(data);
                        if (content) {
                            onChunk(content);
                            fullResponse += content;
                        }
                    } catch (error) {
                        console.warn('Failed to parse Ollama JSON:', error, 'Line:', line);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Ollama stream processing error:', error);
        throw error;
    }

    return fullResponse;
}

export const ollamaProvider: ProviderFactory = (config: ProviderConfig) => {
  return {
    endpoint: `${config.baseUrl || config.apiKey || 'http://localhost:11434'}/api/chat`,
    
    headers: (config: ProviderConfig) => ({
      'Content-Type': 'application/json',
    }),
    
    body: (messages: ChatMessage[], config: ProviderConfig) => ({
      model: config.model || 'llama3.2',
      messages,
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
    }),
    
    extractContent: (data: any) => {
      return data?.message?.content || null;
    },

    // Ollama-specific stream processor
    processStream: processOllamaStream
  };
}; 