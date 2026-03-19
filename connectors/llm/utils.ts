import { Tiktoken } from "js-tiktoken";

import type { ChatMessage, ChatRequest, ChatResponse, ToolDefinition, ToolInvocation } from './types.ts';

/**
 * Formats chat messages with instructions and applies length limits
 */
export function formatMessages({ messages, instructions, config, tools }: ChatRequest): ChatMessage[] {

  // Build system content with instructions and tool definitions
  let systemContent = instructions || messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');

  // Add tool definitions to system prompt if tools are provided
  if (tools && tools.length > 0) {
    const toolSystemPrompt = generateToolSystemPrompt(tools);
    systemContent = systemContent
      ? `${toolSystemPrompt}\n\n${systemContent}`
      : toolSystemPrompt;
  }

  // Add system message if content exists
  const systemMessage: ChatMessage[] = systemContent
    ? [{ role: 'system', content: systemContent }]
    : [];

  let formattedMessages = [...systemMessage, ...messages.filter(m => m.role !== 'system')];

  // Apply length limit if specified
  if (config?.maxLength) {
    formattedMessages = limitMessageLength(
      formattedMessages,
      config.maxLength - (systemContent?.length || 0)
    );
  }

  // Ensure system message is first if it exists
  if (systemContent && formattedMessages[0]?.role !== 'system') {
    formattedMessages = [{ role: 'system', content: systemContent }, ...formattedMessages];
  }

  // Convert tool messages to assistant text so providers that require structured tool_calls don't reject the payload.
  // We still rehydrate <function_calls> from either top-level message.toolCalls or metadata.toolCalls for assistant messages.
  formattedMessages = formattedMessages.map((m) => ({
    ...m,
    // Present tool results as regular context to the model to avoid provider tool-call constraints
    role: m.role === 'tool' ? 'user' : m.role,
    content: m.content,
  }));

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
export async function countTokens(messages: ChatMessage[], response: string): Promise<number> {
  try {
    const base = await fetch('https://tiktoken.pages.dev/js/o200k_base.json', {cache: 'force-cache'}).then(res => res.json());
    const encoding = new Tiktoken(base);
    const allContent = messages.map(m => m.content).join(' ') + response;
    const tokens = encoding.encode(allContent);
    // const tokens= [1,2];
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
  // fullResponse should be the RAW response including any <function_calls> blocks,
  // while chunks passed to onChunk are filtered to exclude tool-call tokens.
  let fullResponse = '';
  let buffer = '';
  // Filter out <function_calls> blocks from streaming content
  const filterState: {
    inside: boolean;
    pending: string; // stores boundary overlap for start/end tags across tokens
  } = { inside: false, pending: '' };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Process any remaining buffered data
        if (buffer) {
          processBufferedLines(buffer, (filtered) => {
            if (filtered) onChunk(filtered);
          }, extractContent, (raw) => {
            fullResponse += raw; // accumulate RAW content for downstream parsing
          }, filterState);
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
            // Accumulate RAW content
            fullResponse += content;
            // Emit filtered chunk (handle cross-token boundaries)
            const filtered = filterToolCallTokensStreaming(content, filterState);
            if (filtered) onChunk(filtered);
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
  onFilteredChunk: (chunk: string) => void,
  extractContent: (data: any) => string | null,
  onContent: (content: string) => void,
  state: { inside: boolean; pending: string }
): void {
  const lines = buffer.split('\n');
  lines.forEach(line => {
    const data = parseSSEData(line);
    if (data) {
      const content = extractContent(data);
      if (content) {
        const filtered = filterToolCallTokensStreaming(content, state);
        if (filtered) onFilteredChunk(filtered);
        onContent(content);
      }
    }
  });
}

function filterToolCallTokensStreaming(
  input: string,
  state: { inside: boolean; pending: string }
): string {
  const startTag = '<function_calls>';
  const endTag = '</function_calls>';

  let s = state.pending + input;
  state.pending = '';
  let output = '';

  // Helper to compute the longest suffix of text that is a prefix of tag
  const suffixPrefix = (text: string, tag: string): number => {
    const maxLen = Math.min(text.length, tag.length - 1);
    for (let len = maxLen; len > 0; len--) {
      if (text.slice(-len) === tag.slice(0, len)) return len;
    }
    return 0;
  };

  // Process iteratively removing balanced blocks
  while (s.length > 0) {
    if (!state.inside) {
      const idx = s.indexOf(startTag);
      if (idx === -1) {
        // No start tag in this chunk
        // Keep a trailing overlap as pending to detect a tag split across tokens
        const overlap = suffixPrefix(s, startTag);
        if (overlap > 0) {
          output += s.slice(0, s.length - overlap);
          state.pending = s.slice(s.length - overlap);
        } else {
          output += s;
        }
        s = '';
      } else {
        // Output before tag, then enter inside
        output += s.slice(0, idx);
        s = s.slice(idx + startTag.length);
        state.inside = true;
      }
    } else {
      const endIdx = s.indexOf(endTag);
      if (endIdx === -1) {
        // Entire remainder is inside the tag; keep overlap to catch end tag
        const overlap = suffixPrefix(s, endTag);
        state.pending = s.slice(s.length - overlap);
        s = '';
      } else {
        // Skip content inside and consume end tag, exit inside
        s = s.slice(endIdx + endTag.length);
        state.inside = false;
      }
    }
  }

  return output;
}

// =============================================================================
// STANDARDIZED TOOL CALLING FUNCTIONS
// =============================================================================

export function generateToolSystemPrompt(tools: ToolDefinition[]): string {
  const toolDefinitions = tools.map(tool => JSON.stringify(tool)).join('\n');

  return `
=== TOOL USAGE ===

In this environment you have access to a set of tools you can use to answer the user's question.

=== RULES ===

1. You may talk to the human normally and call tools in the same response.
2. If a tool is needed, produce JSONL objects between <function_calls> … </function_calls>.  
   • Required keys: "name", "arguments"  
   • No extra keys.  
3. Do not wrap the JSON in markdown fences or add other braces.  
4. Example:

\`\`\` 
<function_calls>
{ "name": "function_name", "arguments": { "key_1": "value_1", "key_2": "value_2" } }
{ "name": "function_name_2","arguments": { "key_1": "value_1", "key_2": "value_2", "key_3": "value_3"} }
</function_calls>
Hi, I'm going to execute two function calls.
\`\`\`

VERY IMPORTANT, PAY ATTENTION TO THIS >>>>>> ALWAYS Start your messages with the <function_calls> block when you have a tool to call.

=== TOOL CATALOG (read-only) ===

\`\`\`json
${toolDefinitions}
\`\`\``;
}

/**
 * Rehydrate a <function_calls> block from recorded tool calls, if present in message metadata
 */
export function buildFunctionCallsBlock(toolCalls: ToolInvocation[]): string {
  const objects = toolCalls.map(call => {
    let args: any;
    try { args = typeof call.args === "string" ? JSON.parse(call.args) : call.args; } catch { args = call.args; }
    const obj: any = { name: call.tool.id, arguments: args };
    if (call.id) obj.tool_call_id = call.id;
    return JSON.stringify(obj);
  });
  return [`<function_calls>`, ...objects, `</function_calls>`].join('\n');
}

/**
 * Parse tool calls from AI response using the Anthropic-style <tool_calls> JSON block
 */
export function parseToolCallsFromResponse(response: string): { cleanResponse: string; tool_calls: ToolInvocation[] } {
  const toolCalls: ToolInvocation[] = [];
  let cleanResponse = response;

  // 1) Recover missing closing tags by balancing braces inside the last <function_calls>
  //    If we find an opening tag without a closing one, attempt to extract until balanced JSON objects are complete,
  //    then synthetically append the closing tag to allow the standard parser to run.
  const startTag = '<function_calls>';
  const endTag = '</function_calls>';

  const hasStart = response.includes(startTag);
  const hasEnd = response.includes(endTag);

  if (hasStart && !hasEnd) {
    const startIdx = response.lastIndexOf(startTag);
    if (startIdx !== -1) {
      const after = response.slice(startIdx + startTag.length);
      // Attempt to extract valid JSON objects from the tail; if at least one is found, treat as valid and close the tag
      const objs = extractJsonObjects(after);
      if (objs.length > 0) {
        // Reconstruct a closed block to be parsed by the standard path
        const rebuilt = response.slice(0, startIdx) + startTag + after + endTag;
        response = rebuilt;
      }
    }
  }

  // Regex to match <function_calls> ... </function_calls> block(s)
  const toolCallsPattern = /<function_calls>([\s\S]*?)<\/function_calls>/g;
  const matches = [...response.matchAll(toolCallsPattern)];

  for (const match of matches) {
    const blockContent = match[1].trim();

    const jsonObjects = extractJsonObjects(blockContent);
    for (const jsonStr of jsonObjects) {
      try {
        const obj = JSON.parse(jsonStr);
        if (obj && typeof obj.name === 'string') {
          const executionId = crypto.randomUUID();
            toolCalls.push({
              id: executionId,
              tool: {
                id: obj.name
              },
              args: JSON.stringify(obj.arguments)
            });
        }
      } catch { /* ignore malformed object */ }
    }

    cleanResponse = cleanResponse.replace(match[0], '').trimStart();
  }

  return { cleanResponse, tool_calls: toolCalls };
}

/**
 * Extract complete JSON objects from a string using proper bracket matching
 */
function extractJsonObjects(content: string): string[] {
  const jsonObjects: string[] = [];
  let i = 0;

  while (i < content.length) {
    // Skip whitespace
    while (i < content.length && /\s/.test(content[i])) {
      i++;
    }

    if (i >= content.length) break;

    // Look for opening brace
    if (content[i] === '{') {
      const startPos = i;
      let braceCount = 1;
      i++; // Move past the opening brace

      // Find the matching closing brace
      while (i < content.length && braceCount > 0) {
        if (content[i] === '{') {
          braceCount++;
        } else if (content[i] === '}') {
          braceCount--;
        } else if (content[i] === '"') {
          // Skip quoted strings to avoid counting braces inside strings
          i++;
          while (i < content.length && content[i] !== '"') {
            if (content[i] === '\\') {
              i++; // Skip escaped character
            }
            i++;
          }
        }
        i++;
      }

      if (braceCount === 0) {
        // Found complete JSON object
        const jsonStr = content.slice(startPos, i);
        jsonObjects.push(jsonStr);
      }
    } else {
      // Skip non-JSON character
      i++;
    }
  }

  return jsonObjects;
}