import { Tiktoken } from "js-tiktoken";

import type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ExtractedPart,
  ProcessStreamOptions,
  ProviderConfig,
  StreamCallback,
  ToolDefinition,
  ToolInvocation,
} from "./types.ts";

const TOOL_RESULTS_CONTINUATION_CUE = "<continue_after_tool_results/>";
const LOCAL_DEFAULT_STOP_SEQUENCES = ["<function_results>"];
const TOOL_RESULTS_CONTINUATION_BLOCK = `<continue_after_tool_results>
Continue based on the function results above.
Do not repeat the previous assistant message.
If no user-facing reply is necessary, respond with exactly <no_response/>.
Never output the <continue_after_tool_results> block itself.
</continue_after_tool_results>`;
const NO_RESPONSE_SELF_CLOSING_TAG = "<no_response/>";
const NO_RESPONSE_EMPTY_BLOCK_TAG = "<no_response></no_response>";
const INTERNAL_LITERAL_CONTROL_TAGS = [
  TOOL_RESULTS_CONTINUATION_CUE,
  NO_RESPONSE_SELF_CLOSING_TAG,
  NO_RESPONSE_EMPTY_BLOCK_TAG,
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeStructuredTagNames(tagNames: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const candidate of tagNames) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!/^[a-z][a-z0-9_-]*$/i.test(trimmed)) continue;

    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    normalized.push(trimmed);
  }

  return normalized;
}

/**
 * Formats chat messages with instructions and applies length limits
 */
export function formatMessages(
  { messages, instructions, config, tools }: ChatRequest,
): ChatMessage[] {
  // Build system content with instructions and tool definitions
  let systemContent = instructions ||
    messages.filter((m) => m.role === "system").map((m) => m.content).join(
      "\n\n",
    );

  // Add tool definitions to system prompt if tools are provided
  if (tools && tools.length > 0) {
    const toolSystemPrompt = generateToolSystemPrompt(tools);
    systemContent = systemContent
      ? `${toolSystemPrompt}\n\n${systemContent}`
      : toolSystemPrompt;
  }

  // Add system message if content exists
  const systemMessage: ChatMessage[] = systemContent
    ? [{ role: "system", content: systemContent }]
    : [];

  let formattedMessages = [
    ...systemMessage,
    ...messages.filter((m) => m.role !== "system"),
  ];

  // Apply length limit if specified
  if (config?.maxLength) {
    formattedMessages = limitMessageLength(
      formattedMessages,
      config.maxLength - (systemContent?.length || 0),
    );
  }

  // Ensure system message is first if it exists
  if (systemContent && formattedMessages[0]?.role !== "system") {
    formattedMessages = [
      { role: "system", content: systemContent },
      ...formattedMessages,
    ];
  }

  // Present tool results as assistant-side context, materialize each
  // assistant message's own tool-call block into its own content, then
  // collapse consecutive messages from the same sender to avoid provider
  // errors with repeated assistant turns while preserving chronology.
  const normalizedMessages = mergeConsecutiveMessages(
    formattedMessages.map(materializeHistoryMessage),
  );

  return appendContinuationCueIfNeeded(normalizedMessages);
}

function isEmptyContent(content: ChatMessage["content"]): boolean {
  if (typeof content === "string") return content.length === 0;
  return content.length === 0;
}

function toContentParts(content: ChatMessage["content"]): ChatContentPart[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : [...content];
}

function mergeMessageContent(
  left: ChatMessage["content"],
  right: ChatMessage["content"],
): ChatMessage["content"] {
  if (isEmptyContent(left)) return right;
  if (isEmptyContent(right)) return left;

  if (typeof left === "string" && typeof right === "string") {
    return `${left}\n\n${right}`;
  }

  return [
    ...toContentParts(left),
    { type: "text", text: "\n\n" },
    ...toContentParts(right),
  ];
}

function prependTextToContent(
  prefix: string,
  content: ChatMessage["content"],
): ChatMessage["content"] {
  if (typeof content === "string") {
    return content.length > 0 ? `${prefix}\n${content}` : prefix;
  }

  return [
    {
      type: "text",
      text: content.length > 0 ? `${prefix}\n` : prefix,
    },
    ...content,
  ];
}

function prependBlocksToContent(
  blocks: string[],
  content: ChatMessage["content"],
): ChatMessage["content"] {
  const normalizedBlocks = blocks.filter((block) => block.trim().length > 0);
  if (normalizedBlocks.length === 0) return content;
  return prependTextToContent(normalizedBlocks.join("\n"), content);
}

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;

  return content
    .filter((part) => part.type === "text")
    .map((part) => (part as Extract<ChatContentPart, { type: "text" }>).text)
    .join("");
}

function extractRouteTargetsFromMetadata(
  metadata: ChatMessage["metadata"],
): string[] {
  if (!metadata || typeof metadata !== "object") return [];

  const routing = (metadata as { routing?: unknown }).routing;
  if (!routing || typeof routing !== "object") return [];

  const routeTo = (routing as { routeTo?: unknown }).routeTo;
  if (!Array.isArray(routeTo)) return [];

  const seen = new Set<string>();
  const targets: string[] = [];

  for (const candidate of routeTo) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    targets.push(trimmed);
  }

  return targets;
}

export function buildRouteToBlock(routeTargets: string[]): string {
  const normalizedTargets = extractRouteTargetsFromMetadata({
    routing: { routeTo: routeTargets },
  });

  return normalizedTargets
    .map((target) => `<route_to>${target}</route_to>`)
    .join("\n");
}

function materializeAssistantControlBlocks(message: ChatMessage): ChatMessage {
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  const routeTargets = extractRouteTargetsFromMetadata(message.metadata);

  if (
    message.role !== "assistant" ||
    (toolCalls.length === 0 && routeTargets.length === 0)
  ) {
    return message;
  }

  try {
    const blocks: string[] = [];
    if (routeTargets.length > 0) {
      blocks.push(buildRouteToBlock(routeTargets));
    }
    if (toolCalls.length > 0) {
      blocks.push(buildFunctionCallsBlock(toolCalls));
    }
    return {
      ...message,
      content: prependBlocksToContent(blocks, message.content),
      toolCalls: undefined,
      tool_call_id: undefined,
    };
  } catch {
    return message;
  }
}

function materializeToolResults(message: ChatMessage): ChatMessage {
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  if (
    (message.role !== "tool" && message.role !== "tool_result") ||
    toolCalls.length === 0
  ) {
    return message;
  }

  try {
    return {
      ...message,
      content: buildFunctionResultsBlock(toolCalls, contentToText(message.content)),
      toolCalls: undefined,
      tool_call_id: undefined,
    };
  } catch {
    return {
      ...message,
      toolCalls: undefined,
    };
  }
}

function materializeHistoryMessage(message: ChatMessage): ChatMessage {
  if (message.role === "assistant") {
    return materializeAssistantControlBlocks(message);
  }

  if (message.role === "tool" || message.role === "tool_result") {
    const toolResultMessage = materializeToolResults(message);
    return {
      ...toolResultMessage,
      role: "assistant",
    };
  }

  return message;
}

function mergeConsecutiveMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.role !== "system" &&
      message.role !== "system" &&
      typeof previous.senderId === "string" &&
      typeof message.senderId === "string" &&
      previous.senderId === message.senderId &&
      previous.role === message.role &&
      (!Array.isArray(previous.toolCalls) || previous.toolCalls.length === 0) &&
      (!Array.isArray(message.toolCalls) || message.toolCalls.length === 0)
    ) {
      merged[merged.length - 1] = {
        ...previous,
        content: mergeMessageContent(previous.content, message.content),
        tool_call_id: undefined,
        toolCalls: undefined,
      };
      continue;
    }

    merged.push(message);
  }

  return merged;
}

function appendContinuationCueIfNeeded(messages: ChatMessage[]): ChatMessage[] {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") {
    return messages;
  }

  const lastContent = contentToText(lastMessage.content);
  if (!lastContent.includes("<function_results>")) {
    return messages;
  }

  return [
    ...messages,
    {
      role: "user",
      content: TOOL_RESULTS_CONTINUATION_CUE,
    },
  ];
}

function normalizeStopValues(value?: string | string[]): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0
    );
  }
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

export function withDefaultStopSequences(
  config: ProviderConfig,
): ProviderConfig {
  const mergedStops = [
    ...new Set([
      ...normalizeStopValues(config.stopSequences),
      ...normalizeStopValues(config.stop),
    ]),
  ];

  if (mergedStops.length === 0) return config;

  return {
    ...config,
    stop: mergedStops,
    stopSequences: mergedStops,
  };
}

export function getLocalStopSequences(config?: ProviderConfig): string[] {
  return [
    ...new Set([
      ...normalizeStopValues(config?.stopSequences),
      ...normalizeStopValues(config?.stop),
      ...LOCAL_DEFAULT_STOP_SEQUENCES,
    ]),
  ];
}

type LocalStopState = {
  pending: string;
  matchedStop?: string;
};

function applyLocalStopSequences(
  input: string,
  stopSequences: string[],
  state: LocalStopState,
): { text: string; matchedStop?: string } {
  if (stopSequences.length === 0) {
    return { text: input };
  }

  const combined = state.pending + input;
  state.pending = "";

  let earliestIndex = -1;
  let matchedStop: string | undefined;

  for (const stop of stopSequences) {
    const index = combined.indexOf(stop);
    if (index === -1) continue;
    if (earliestIndex === -1 || index < earliestIndex) {
      earliestIndex = index;
      matchedStop = stop;
    }
  }

  if (earliestIndex !== -1) {
    state.matchedStop = matchedStop;
    return {
      text: combined.slice(0, earliestIndex),
      matchedStop,
    };
  }

  const overlap = suffixPrefixAny(combined, stopSequences);
  if (overlap > 0) {
    state.pending = combined.slice(combined.length - overlap);
    return { text: combined.slice(0, combined.length - overlap) };
  }

  return { text: combined };
}

/**
 * Limits the total character length of messages, keeping the most recent ones
 */
function limitMessageLength(
  messages: ChatMessage[],
  limit: number,
): ChatMessage[] {
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
          content: message.content.slice(-remainingSpace),
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
export async function countTokens(
  messages: ChatMessage[],
  response: string,
): Promise<number> {
  try {
    const base = await fetch("https://tiktoken.pages.dev/js/o200k_base.json", {
      cache: "force-cache",
    }).then((res) => res.json());
    const encoding = new Tiktoken(base);
    const allContent = messages.map((m) => m.content).join(" ") + response;
    const tokens = encoding.encode(allContent);
    // const tokens= [1,2];
    return tokens.length;
  } catch (error) {
    console.warn("Token counting failed:", error);
    // Fallback to approximate count (4 chars per token)
    const totalText = messages.map((m) => m.content).join(" ") + response;
    return Math.ceil(totalText.length / 4);
  }
}

/**
 * Creates a mock response for testing
 */
export function createMockResponse(request: ChatRequest): ChatResponse {
  const prompt = formatMessages(request);
  const answer = typeof request.answer === "string"
    ? request.answer
    : JSON.stringify(request.answer);

  return {
    prompt,
    answer,
    tokens: 0,
  };
}

/**
 * Parses Server-Sent Events data
 */
export function parseSSEData(line: string): any | null {
  if (!line.startsWith("data:")) return null;

  const data = line.slice(5).trim();
  if (data === "[DONE]") return null;

  try {
    return JSON.parse(data);
  } catch (error) {
    console.warn("Failed to parse SSE data:", error, "Line:", line);
    return null;
  }
}

/**
 * Parses a single line according to the stream format.
 * SSE: expects `data: {...}` prefix.  JSONL: raw JSON per line.
 */
function parseLine(line: string, format: "sse" | "jsonl"): any | null {
  if (format === "jsonl") {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return parseSSEData(line);
}

/**
 * Unified stream processor for all LLM providers.
 *
 * Each provider only needs to implement `extractContent` which maps a parsed
 * event object to an array of `ExtractedPart`s (text + optional isReasoning flag).
 * This function handles SSE/JSONL parsing, `<function_calls>` filtering,
 * reasoning gating, and buffer management — so providers don't have to.
 */
export async function processStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk: StreamCallback,
  extractContent: (data: any) => ExtractedPart[] | null,
  options?: ProcessStreamOptions,
): Promise<{ content: string; reasoning: string }> {
  const decoder = new TextDecoder("utf-8");
  const format = options?.format ?? "sse";
  const config = options?.config;
  // fullResponse accumulates RAW content (including <function_calls> blocks)
  // so parseToolCallsFromResponse can extract them downstream.
  let fullResponse = "";
  let reasoningResponse = "";
  let buffer = "";
  const localStopSequences = getLocalStopSequences(options?.config).length > 0
    ? (options?.localStopSequences ?? getLocalStopSequences(options?.config))
    : (options?.localStopSequences ?? []);
  const localStopState: LocalStopState = { pending: "" };
  let stoppedByLocalStop = false;
  const filterState: {
    activeTag: string | null;
    pending: string;
    controlPending: string;
  } = {
    activeTag: null,
    pending: "",
    controlPending: "",
  };

  const appendVisibleContent = (text: string) => {
    if (!text) return;
    fullResponse += text;
    const filtered = filterTaggedControlTokensStreaming(
      text,
      filterState,
      options?.extractedBlockTags ?? [],
    );
    if (filtered) onChunk(filtered);
  };

  const flushLocalStopPending = () => {
    if (!localStopState.pending || stoppedByLocalStop) return;
    const pending = localStopState.pending;
    localStopState.pending = "";
    appendVisibleContent(pending);
  };

  const handleParts = (parts: ExtractedPart[]) => {
    for (const part of parts) {
      if (part.isReasoning) {
        reasoningResponse += part.text;
        if (config?.outputReasoning !== false) {
          onChunk(part.text, { isReasoning: true });
        }
      } else {
        const localStopResult = applyLocalStopSequences(
          part.text,
          localStopSequences,
          localStopState,
        );
        appendVisibleContent(localStopResult.text);
        if (localStopResult.matchedStop) {
          stoppedByLocalStop = true;
          options?.onLocalStop?.(localStopResult.matchedStop);
          return true;
        }
      }
    }

    return false;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        if (buffer) {
          for (const line of buffer.split("\n")) {
            const data = parseLine(line, format);
            if (data) {
              const parts = extractContent(data);
              if (parts) {
                const shouldStop = handleParts(parts);
                if (shouldStop) break;
              }
            }
          }
        }
        flushLocalStopPending();
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const data = parseLine(line, format);
        if (data) {
          const parts = extractContent(data);
          if (parts) {
            const shouldStop = handleParts(parts);
            if (shouldStop) break;
          }
        }
      }

      if (stoppedByLocalStop) {
        break;
      }
    }
  } catch (error) {
    if (!stoppedByLocalStop) {
      console.error("Stream processing error:", error);
      throw error;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore release errors
    }
  }

  if (options?.postProcess) {
    fullResponse = options.postProcess(fullResponse);
  }

  return { content: fullResponse, reasoning: reasoningResponse };
}

export function filterToolCallTokensStreaming(
  input: string,
  state: { inside: boolean; pending: string; controlPending?: string },
): string {
  const nextState = {
    activeTag: state.inside ? "function_calls" : null,
    pending: state.pending,
    controlPending: state.controlPending ?? "",
  };
  const filtered = filterTaggedControlTokensStreaming(input, nextState, []);
  state.inside = nextState.activeTag === "function_calls";
  state.pending = nextState.pending;
  state.controlPending = nextState.controlPending;
  return filtered;
}

export function filterTaggedControlTokensStreaming(
  input: string,
  state: { activeTag: string | null; pending: string; controlPending?: string },
  extractedBlockTags: string[],
): string {
  const structuredTags = normalizeStructuredTagNames([
    "function_calls",
    ...extractedBlockTags,
  ]).map((name) => ({
    name,
    startTag: `<${name}>`,
    endTag: `</${name}>`,
  }));

  let s = state.pending + input;
  state.pending = "";
  let output = "";

  while (s.length > 0) {
    if (!state.activeTag) {
      let nextMatch:
        | { index: number; tagName: string; tagLength: number }
        | null = null;

      for (const tag of structuredTags) {
        const index = s.indexOf(tag.startTag);
        if (index === -1) continue;
        if (!nextMatch || index < nextMatch.index) {
          nextMatch = {
            index,
            tagName: tag.name,
            tagLength: tag.startTag.length,
          };
        }
      }

      if (!nextMatch) {
        let overlap = 0;
        for (const tag of structuredTags) {
          overlap = Math.max(overlap, suffixPrefix(s, tag.startTag));
        }
        if (overlap > 0) {
          output += s.slice(0, s.length - overlap);
          state.pending = s.slice(s.length - overlap);
        } else {
          output += s;
        }
        s = "";
      } else {
        output += s.slice(0, nextMatch.index);
        s = s.slice(nextMatch.index + nextMatch.tagLength);
        state.activeTag = nextMatch.tagName;
      }
    } else {
      const activeTag = structuredTags.find((tag) => tag.name === state.activeTag);
      if (!activeTag) {
        state.activeTag = null;
        continue;
      }
      const endIdx = s.indexOf(activeTag.endTag);
      if (endIdx === -1) {
        const overlap = suffixPrefix(s, activeTag.endTag);
        state.pending = s.slice(s.length - overlap);
        s = "";
      } else {
        s = s.slice(endIdx + activeTag.endTag.length);
        state.activeTag = null;
      }
    }
  }

  const literalState = { pending: state.controlPending ?? "" };
  const filteredOutput = stripLiteralControlTagsStreaming(
    output,
    literalState,
    INTERNAL_LITERAL_CONTROL_TAGS,
  );
  state.controlPending = literalState.pending;

  return filteredOutput;
}

// =============================================================================
// STANDARDIZED TOOL CALLING FUNCTIONS
// =============================================================================

export function generateToolSystemPrompt(tools: ToolDefinition[]): string {
  const toolDefinitions = tools.map((tool) => JSON.stringify(tool)).join("\n");

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
5. Tool outputs may appear later as <function_results> blocks. Treat them as returned execution results and never generate <function_results> yourself.
6. If you later receive the exact user message <continue_after_tool_results/>, apply the following continuation rule:

${TOOL_RESULTS_CONTINUATION_BLOCK}

=== TOOL CATALOG (read-only) ===

\`\`\`json
${toolDefinitions}
\`\`\``;
}

/**
 * Rehydrate a <function_calls> block from recorded tool calls, if present in message metadata
 */
export function buildFunctionCallsBlock(toolCalls: ToolInvocation[]): string {
  const objects = toolCalls.map((call) => {
    let args: any;
    try {
      args = typeof call.args === "string" ? JSON.parse(call.args) : call.args;
    } catch {
      args = call.args;
    }
    const obj: any = { name: call.tool.id, arguments: args };
    if (call.id) obj.tool_call_id = call.id;
    return JSON.stringify(obj);
  });
  return [`<function_calls>`, ...objects, `</function_calls>`].join("\n");
}

function normalizeToolResultOutput(
  call: ToolInvocation,
  fallbackContent?: string,
): unknown {
  if (typeof call.output !== "undefined") {
    return call.output;
  }

  if (fallbackContent && fallbackContent.length > 0) {
    return fallbackContent;
  }

  return null;
}

export function buildFunctionResultsBlock(
  toolResults: ToolInvocation[],
  fallbackContent?: string,
): string {
  const objects = toolResults.map((call) => {
    const obj: Record<string, unknown> = {
      name: call.tool.id,
      output: normalizeToolResultOutput(
        call,
        toolResults.length === 1 ? fallbackContent : undefined,
      ),
    };
    if (call.id) obj.tool_call_id = call.id;
    if (call.status) obj.status = call.status;
    return JSON.stringify(obj);
  });

  return [`<function_results>`, ...objects, `</function_results>`].join("\n");
}

/**
 * Parse tool calls from AI response using the Anthropic-style <tool_calls> JSON block
 */
export function parseToolCallsFromResponse(
  response: string,
): { cleanResponse: string; tool_calls: ToolInvocation[] } {
  const toolCalls: ToolInvocation[] = [];
  let cleanResponse = response;

  // 1) Recover missing closing tags by balancing braces inside the last <function_calls>
  //    If we find an opening tag without a closing one, attempt to extract until balanced JSON objects are complete,
  //    then synthetically append the closing tag to allow the standard parser to run.
  const startTag = "<function_calls>";
  const endTag = "</function_calls>";

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
        if (obj && typeof obj.name === "string") {
          const executionId = crypto.randomUUID();
          toolCalls.push({
            id: executionId,
            tool: {
              id: obj.name,
            },
            args: JSON.stringify(obj.arguments),
          });
        }
      } catch { /* ignore malformed object */ }
    }

    cleanResponse = cleanResponse.replace(match[0], "").trimStart();
  }

  return { cleanResponse, tool_calls: toolCalls };
}

export function parseInternalControlTagsFromResponse(
  response: string,
): { cleanResponse: string; suppressResponse: boolean } {
  let cleanResponse = response;
  let suppressResponse = false;

  const noResponsePattern = /<no_response\s*\/>|<no_response>\s*<\/no_response>/g;
  const hasNoResponse = noResponsePattern.test(cleanResponse);
  noResponsePattern.lastIndex = 0;
  if (hasNoResponse) {
    suppressResponse = true;
    cleanResponse = cleanResponse.replace(noResponsePattern, "");
  }

  cleanResponse = cleanResponse
    .replace(/<function_results>[\s\S]*?(?:<\/function_results>|$)/g, "")
    .replace(/<continue_after_tool_results\s*\/>/g, "")
    .replace(/<continue_after_tool_results>[\s\S]*?<\/continue_after_tool_results>/g, "")
    .trim();

  return { cleanResponse, suppressResponse };
}

export function parseTaggedBlocksFromResponse(
  response: string,
  tagNames: string[],
): { cleanResponse: string; extractedTags: Record<string, string[]> } {
  const extractedTags: Record<string, string[]> = {};
  let cleanResponse = response;

  for (const tagName of normalizeStructuredTagNames(tagNames)) {
    const pattern = new RegExp(
      `<${escapeRegex(tagName)}>([\\s\\S]*?)<\\/${escapeRegex(tagName)}>`,
      "gi",
    );
    const values: string[] = [];

    cleanResponse = cleanResponse.replace(pattern, (_match, inner: string) => {
      const value = typeof inner === "string" ? inner.trim() : "";
      if (value.length > 0) values.push(value);
      return "";
    });

    if (values.length > 0) {
      extractedTags[tagName] = values;
    }
  }

  return { cleanResponse: cleanResponse.trim(), extractedTags };
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
    if (content[i] === "{") {
      const startPos = i;
      let braceCount = 1;
      i++; // Move past the opening brace

      // Find the matching closing brace
      while (i < content.length && braceCount > 0) {
        if (content[i] === "{") {
          braceCount++;
        } else if (content[i] === "}") {
          braceCount--;
        } else if (content[i] === '"') {
          // Skip quoted strings to avoid counting braces inside strings
          i++;
          while (i < content.length && content[i] !== '"') {
            if (content[i] === "\\") {
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

function suffixPrefix(text: string, tag: string): number {
  const maxLen = Math.min(text.length, tag.length - 1);
  for (let len = maxLen; len > 0; len--) {
    if (text.slice(-len) === tag.slice(0, len)) return len;
  }
  return 0;
}

function suffixPrefixAny(text: string, tags: string[]): number {
  let maxOverlap = 0;
  for (const tag of tags) {
    maxOverlap = Math.max(maxOverlap, suffixPrefix(text, tag));
  }
  return maxOverlap;
}

function stripLiteralControlTagsStreaming(
  input: string,
  state: { pending: string },
  tags: string[],
): string {
  let s = state.pending + input;
  state.pending = "";
  let output = "";

  while (s.length > 0) {
    let earliestIdx = -1;
    let matchedTag = "";

    for (const tag of tags) {
      const idx = s.indexOf(tag);
      if (
        idx !== -1 &&
        (earliestIdx === -1 || idx < earliestIdx ||
          (idx === earliestIdx && tag.length > matchedTag.length))
      ) {
        earliestIdx = idx;
        matchedTag = tag;
      }
    }

    if (earliestIdx === -1) {
      const overlap = suffixPrefixAny(s, tags);
      if (overlap > 0) {
        output += s.slice(0, s.length - overlap);
        state.pending = s.slice(s.length - overlap);
      } else {
        output += s;
      }
      break;
    }

    output += s.slice(0, earliestIdx);
    s = s.slice(earliestIdx + matchedTag.length);
  }

  return output;
}
