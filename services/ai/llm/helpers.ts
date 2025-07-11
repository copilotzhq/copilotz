import { getEncoding } from "npm:js-tiktoken";
import type { ChatMessage, ChatRequest, ChatResponse, ProviderConfig } from './types.ts';

/**
 * Formats chat messages with instructions and applies length limits
 */
export function formatMessages({ messages, instructions, config }: ChatRequest): ChatMessage[] {
  // Add system message if instructions exist
  const systemMessage: ChatMessage[] = instructions 
    ? [{ role: 'system', content: instructions }]
    : [];

  let formattedMessages = [...systemMessage, ...messages];

  // Apply length limit if specified
  if (config?.maxLength) {
    formattedMessages = limitMessageLength(
      formattedMessages,
      config.maxLength - (instructions?.length || 0)
    );
  }

  // Ensure system message is first if it exists
  if (instructions && formattedMessages[0]?.role !== 'system') {
    formattedMessages = [{ role: 'system', content: instructions }, ...formattedMessages];
  }

  return formattedMessages;
}

/**
 * Limits the total character length of messages, keeping the most recent ones
 */
function limitMessageLength(messages: ChatMessage[], limit: number): ChatMessage[] {
  const result: ChatMessage[] = [];
  let totalLength = 0;

  // Process messages from newest to oldest
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message.content) continue;

    const messageLength = message.content.length;
    
    if (totalLength + messageLength <= limit) {
      result.unshift(message);
      totalLength += messageLength;
    } else {
      // Truncate the message to fit remaining space
      const remainingSpace = limit - totalLength;
      if (remainingSpace > 0) {
        result.unshift({
          ...message,
          content: message.content.slice(-remainingSpace)
        });
      }
      break;
    }
  }

  return result;
}

/**
 * Counts tokens in messages and response using tiktoken
 */
export function countTokens(messages: ChatMessage[], response: string): number {
  try {
    const encoding = getEncoding("cl100k_base");
    const allContent = messages.map(m => m.content).join(' ') + response;
    const tokens = encoding.encode(allContent);
    return tokens.length;
  } catch (error) {
    console.warn('Token counting failed:', error);
    // Fallback to approximate count (4 chars per token)
    const totalText = messages.map(m => m.content).join(' ') + response;
    return Math.ceil(totalText.length / 4);
  }
}

/**
 * Creates a mock response for testing
 */
export function createMockResponse(request: ChatRequest): ChatResponse {
  const prompt = formatMessages(request);
  const answer = typeof request.answer === 'string' 
    ? request.answer 
    : JSON.stringify(request.answer);
  
  return {
    prompt,
    answer,
    tokens: 0
  };
}

/**
 * Parses Server-Sent Events data
 */
export function parseSSEData(line: string): any | null {
  if (!line.startsWith('data:')) return null;
  
  const data = line.slice(5).trim();
  if (data === '[DONE]') return null;
  
  try {
    return JSON.parse(data);
  } catch (error) {
    console.warn('Failed to parse SSE data:', error, 'Line:', line);
    return null;
  }
}

/**
 * Processes streaming response chunks
 */
export async function processStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk: (chunk: string) => void,
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
        if (buffer) {
          processBufferedLines(buffer, onChunk, extractContent, (content) => {
            fullResponse += content;
          });
        }
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      lines.forEach(line => {
        const data = parseSSEData(line);
        if (data) {
          const content = extractContent(data);
          if (content) {
            onChunk(content);
            fullResponse += content;
          }
        }
      });
    }
  } catch (error) {
    console.error('Stream processing error:', error);
    throw error;
  }

  return fullResponse;
}

function processBufferedLines(
  buffer: string,
  onChunk: (chunk: string) => void,
  extractContent: (data: any) => string | null,
  onContent: (content: string) => void
): void {
  const lines = buffer.split('\n');
  lines.forEach(line => {
    const data = parseSSEData(line);
    if (data) {
      const content = extractContent(data);
      if (content) {
        onChunk(content);
        onContent(content);
      }
    }
  });
} 