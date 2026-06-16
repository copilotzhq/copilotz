import type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ExtractedPart,
  ProcessStreamOptions,
  ProviderConfig,
  ProviderFinishReason,
  ProviderUsageUpdate,
  StreamCallback,
  TokenUsage,
  ToolDefinition,
  ToolInvocation,
} from "@/runtime/llm/types.ts";

const TOOL_RESULTS_CONTINUATION_CUE =
  `<continue_after_tool_results>Continue your response based on the tool results above. Do not repeat earlier content. If no reply is needed, respond with <no_response/>.</continue_after_tool_results>`;
const LOCAL_DEFAULT_STOP_SEQUENCES = [
  "<tool_results>",
  "</tool_results>",
];
const NO_RESPONSE_SELF_CLOSING_TAG = "<no_response/>";
const NO_RESPONSE_EMPTY_BLOCK_TAG = "<no_response></no_response>";
const INTERNAL_LITERAL_CONTROL_TAGS = [
  NO_RESPONSE_SELF_CLOSING_TAG,
  NO_RESPONSE_EMPTY_BLOCK_TAG,
];
export const COPILOTZ_CONTROL_TAGS = [
  "tool_calls",
  "tool_results",
  "route_to",
  "ask_to",
  "no_response",
  "continue_after_tool_results",
] as const;

/**
 * Non-canonical tool-call dialects some models emit instead of the canonical
 * `<tool_calls>` JSONL block (e.g. Anthropic/MiniMax XML). They are hidden from
 * the user-visible stream and recognized as "tool intent" so we can recover the
 * call or trigger a corrective retry. Provider-agnostic on purpose.
 */
const STREAMING_HIDDEN_DIALECT_TAGS = [
  "minimax:tool_call",
  "tool_call",
  "function_calls",
] as const;

/**
 * Literal special-token markers some model servers leak as raw text when their
 * native tool/message framing is not parsed server-side. These never appear in
 * legitimate output, so they are always safe to strip.
 */
const STRUCTURAL_LEAK_LITERALS = [
  "]<]minimax[>[",
  "]~!b[",
  "]~b]",
  "[e~[",
] as const;

/**
 * Recognizes an opening/closing tool-call marker from any known dialect
 * (canonical or native). Used to decide whether an otherwise-unparsed response
 * was actually a malformed tool attempt that should be corrected and retried.
 */
const TOOL_INTENT_MARKER_PATTERN =
  /<\/?(?:[a-z0-9_]+:)?(?:tool_call|tool_calls|function_call|function_calls|invoke|tool_use)\b/i;

const APPROX_CHARS_PER_TOKEN = 4;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeStructuredTagNames(tagNames: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const candidate of tagNames) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!/^[a-z][a-z0-9_:-]*$/i.test(trimmed)) continue;

    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    normalized.push(trimmed);
  }

  return normalized;
}

/**
 * Formats chat messages with instructions and applies estimated input limits.
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

  const systemEstimatedTokens = systemContent
    ? approximateTokenCount(systemContent)
    : 0;

  // Materialize first so tool I/O is embedded in `content` (tool_results /
  // tool_calls blocks). The input limiter only inspects `content` (plus
  // multimodal parts); it cannot see structured `toolCalls` on the wire.
  let normalizedMessages = formattedMessages.map(materializeHistoryMessage);

  // Apply estimated input budget if specified. We preserve the system prompt and
  // trim only the remaining history budget.
  if (config?.limitEstimatedInputTokens) {
    normalizedMessages = limitMessageEstimatedInputTokens(
      normalizedMessages,
      config.limitEstimatedInputTokens - systemEstimatedTokens,
    );
  }

  // Ensure system message is first if it exists
  if (systemContent && normalizedMessages[0]?.role !== "system") {
    normalizedMessages = [
      { role: "system", content: systemContent },
      ...normalizedMessages,
    ];
  }

  // Collapse consecutive messages from the same sender to avoid provider
  // errors with repeated assistant turns while preserving chronology.
  const mergedMessages = mergeConsecutiveMessages(normalizedMessages);

  return appendContinuationCueIfNeeded(mergedMessages);
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

function stripTaggedBlocksFromText(text: string, tagNames: string[]): string {
  let stripped = text;
  for (const tagName of normalizeStructuredTagNames(tagNames)) {
    const tag = escapeRegex(tagName);
    stripped = stripped.replace(
      new RegExp(`<${tag}>[\\s\\S]*?(?:<\\/${tag}>|$)`, "g"),
      "",
    );
  }
  return stripped;
}

function stripTaggedBlocksFromContent(
  content: ChatMessage["content"],
  tagNames: string[],
): ChatMessage["content"] {
  if (typeof content === "string") {
    return stripTaggedBlocksFromText(content, tagNames);
  }

  const strippedParts = content.flatMap((part): ChatContentPart[] => {
    if (part.type !== "text") return [part];
    const text = stripTaggedBlocksFromText(part.text, tagNames);
    return text.length > 0 ? [{ ...part, text }] : [];
  });

  return strippedParts.length > 0 ? strippedParts : "";
}

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;

  return content
    .filter((part) => part.type === "text")
    .map((part) => (part as Extract<ChatContentPart, { type: "text" }>).text)
    .join("");
}

function mediaEstimateLabel(
  type: string,
  value: string,
  mime?: string,
): string {
  if (value.startsWith("data:")) {
    const markerIndex = value.indexOf(";base64,");
    const mimeFromDataUrl = markerIndex === -1
      ? ""
      : value.slice(5, markerIndex);
    return `[${type}:${mime ?? (mimeFromDataUrl || "inline")}]`;
  }
  return value;
}

function inlineMediaEstimateLabel(type: string, mime?: string): string {
  return `[${type}:${mime ?? "inline"}]`;
}

/**
 * Text used for rough input-token budgeting before sending to a provider.
 * Inline media is represented by a compact placeholder instead of raw base64:
 * provider APIs bill media by their own modality rules, and counting transport
 * base64 here can drop the entire newest multimodal message before it reaches
 * the LLM.
 *
 * Does not serialize `toolCalls`; use after {@link materializeHistoryMessage}
 * so tool I/O lives in `content` (e.g. &lt;tool_results&gt; blocks).
 */
function wirePayloadTextForTokenEstimate(
  content: ChatMessage["content"],
): string {
  if (typeof content === "string") return content;

  const chunks: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      chunks.push((part as Extract<ChatContentPart, { type: "text" }>).text);
      continue;
    }
    if (part.type === "image_url" && part.image_url?.url) {
      chunks.push(mediaEstimateLabel("image", part.image_url.url));
      continue;
    }
    if (part.type === "input_audio" && part.input_audio?.data) {
      chunks.push(
        inlineMediaEstimateLabel(
          "audio",
          part.input_audio.format
            ? `audio/${part.input_audio.format}`
            : undefined,
        ),
      );
      continue;
    }
    if (part.type === "file" && part.file?.file_data) {
      chunks.push(
        mediaEstimateLabel(
          "file",
          part.file.file_data,
          part.file.mime_type,
        ),
      );
    }
  }
  return chunks.join("\n");
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
      blocks.push(buildToolCallsBlock(toolCalls));
    }
    return {
      ...message,
      content: prependBlocksToContent(
        blocks,
        stripTaggedBlocksFromContent(
          message.content,
          [
            ...(routeTargets.length > 0 ? ["route_to"] : []),
            ...(toolCalls.length > 0 ? ["tool_calls"] : []),
          ],
        ),
      ),
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
    const content = stripTaggedBlocksFromContent(
      message.content,
      ["tool_results"],
    );
    return {
      ...message,
      content: buildToolResultsBlock(
        toolCalls,
        contentToText(content),
      ),
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
  if (!lastContent.includes("<tool_results>")) {
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

/**
 * Resolve the stop sequences a provider adapter should send natively.
 *
 * Prefers the runtime-resolved {@link ProviderConfig.nativeStopSequences}
 * (populated by `runProviderStream` with the full client-side stop set,
 * including Copilotz control tags) and falls back to the caller-provided
 * `stopSequences`/`stop` for direct adapter usage (e.g. tests).
 *
 * Returns `undefined` when there is nothing to send. When `maxCount` is given
 * (e.g. Gemini caps at 5), the list is truncated, keeping user-intent stops
 * first; any dropped control tags remain enforced client-side.
 */
export function resolveProviderStopSequences(
  config: ProviderConfig,
  options?: { maxCount?: number },
): string[] | undefined {
  const base = config.nativeStopSequences &&
      config.nativeStopSequences.length > 0
    ? config.nativeStopSequences
    : [
      ...normalizeStopValues(config.stopSequences),
      ...normalizeStopValues(config.stop),
    ];

  const deduped = [...new Set(base.filter((value) => value.length > 0))];
  if (deduped.length === 0) return undefined;

  const max = options?.maxCount;
  const capped = typeof max === "number" && max > 0
    ? deduped.slice(0, max)
    : deduped;

  return capped.length > 0 ? capped : undefined;
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
function limitMessageEstimatedInputTokens(
  messages: ChatMessage[],
  limitTokens: number,
): ChatMessage[] {
  if (limitTokens <= 0) {
    return messages.filter((message) => message.role === "system");
  }

  const result: ChatMessage[] = [];
  let totalTokens = 0;

  // Process messages from newest to oldest
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message.content) continue;
    if (message.role === "system") {
      result.unshift(message);
      continue;
    }

    const messageText = wirePayloadTextForTokenEstimate(message.content);
    const messageTokens = approximateTokenCount(messageText);

    if (totalTokens + messageTokens <= limitTokens) {
      result.unshift(message);
      totalTokens += messageTokens;
    } else {
      // Truncate text messages to fit the remaining estimated token budget.
      const remainingTokens = limitTokens - totalTokens;
      if (remainingTokens > 0 && typeof message.content === "string") {
        const remainingChars = remainingTokens * APPROX_CHARS_PER_TOKEN;
        result.unshift({
          ...message,
          content: message.content.slice(-remainingChars),
        });
      }
      break;
    }
  }

  return result;
}

/**
 * Counts tokens in messages and response using a lightweight character-based approximation.
 */
export async function countTokens(
  messages: ChatMessage[],
  response: string,
): Promise<number> {
  const totalText = messages.map((m) => contentToText(m.content)).join(" ") +
    response;
  return approximateTokenCount(totalText);
}

export async function estimateUsage(
  messages: ChatMessage[],
  response: string,
  status: TokenUsage["status"],
  metadata?: Pick<TokenUsage, "statusReason" | "stopSequence">,
): Promise<TokenUsage> {
  const inputText = messages.map((m) => contentToText(m.content)).join(" ");
  const outputText = response;
  const totalText = inputText + outputText;

  return {
    inputTokens: approximateTokenCount(inputText),
    outputTokens: approximateTokenCount(outputText),
    totalTokens: approximateTokenCount(totalText),
    source: "estimated",
    status,
    ...(metadata?.statusReason ? { statusReason: metadata.statusReason } : {}),
    ...(metadata?.stopSequence ? { stopSequence: metadata.stopSequence } : {}),
    rawUsage: null,
  };
}

function approximateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
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
 * This function handles SSE/JSONL parsing, `<tool_calls>` filtering,
 * reasoning gating, and buffer management — so providers don't have to.
 */
export async function processStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk: StreamCallback,
  extractContent: (data: any) => ExtractedPart[] | null,
  options?: ProcessStreamOptions,
): Promise<{
  content: string;
  reasoning: string;
  usage?: ProviderUsageUpdate;
  usageFinalized?: Promise<{
    usage?: ProviderUsageUpdate;
    finishReason: ProviderFinishReason | null;
  }>;
  finishReason: ProviderFinishReason | null;
  stoppedByLocalStop: boolean;
  localStopReason?: "local_stop_sequence";
  localStopSequence?: string;
}> {
  const decoder = new TextDecoder("utf-8");
  const format = options?.format ?? "sse";
  const config = options?.config;
  // fullResponse accumulates RAW content (including <tool_calls> blocks)
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
  let usage: ProviderUsageUpdate | undefined;
  let finishReason: ProviderFinishReason | null = null;
  let releaseInBackground = false;

  const mergeUsage = (update: ProviderUsageUpdate | null | undefined) => {
    if (!update) return;
    usage = {
      inputTokens: update.inputTokens ?? usage?.inputTokens,
      outputTokens: update.outputTokens ?? usage?.outputTokens,
      reasoningTokens: update.reasoningTokens ?? usage?.reasoningTokens,
      cacheReadInputTokens: update.cacheReadInputTokens ??
        usage?.cacheReadInputTokens,
      cacheCreationInputTokens: update.cacheCreationInputTokens ??
        usage?.cacheCreationInputTokens,
      totalTokens: update.totalTokens ?? usage?.totalTokens,
      rawUsage: update.rawUsage ?? usage?.rawUsage ?? null,
    };
  };

  const mergeFinishReason = (
    update: ProviderFinishReason | null | undefined,
  ) => {
    if (update) finishReason = update;
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

  const parseUsageOnlyLine = (line: string) => {
    const data = parseLine(line, format);
    if (!data) return;
    mergeUsage(options?.extractUsage?.(data));
    mergeFinishReason(options?.extractFinishReason?.(data));
  };

  const drainForFinalUsage = async (
    pendingLines: string[] = [],
  ): Promise<{
    usage?: ProviderUsageUpdate;
    finishReason: ProviderFinishReason | null;
  }> => {
    try {
      for (const line of pendingLines) parseUsageOnlyLine(line);

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer) {
            for (const line of buffer.split("\n")) parseUsageOnlyLine(line);
            buffer = "";
          }
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) parseUsageOnlyLine(line);
      }
    } catch (error) {
      if ((error as { name?: unknown })?.name !== "AbortError") {
        console.warn("Stream final usage drain failed:", error);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore release errors
      }
    }

    return {
      ...(usage ? { usage } : {}),
      finishReason,
    };
  };

  const buildLocalStopResult = (pendingLines: string[] = []) => {
    const usageFinalized = options?.continueAfterLocalStop === true
      ? drainForFinalUsage(pendingLines)
      : undefined;
    if (usageFinalized) releaseInBackground = true;
    const content = options?.postProcess
      ? options.postProcess(fullResponse)
      : fullResponse;

    return {
      content,
      reasoning: reasoningResponse,
      ...(usage ? { usage } : {}),
      ...(usageFinalized ? { usageFinalized } : {}),
      finishReason,
      stoppedByLocalStop,
      localStopReason: "local_stop_sequence" as const,
      ...(localStopState.matchedStop
        ? { localStopSequence: localStopState.matchedStop }
        : {}),
    };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        if (buffer) {
          const bufferedLines = buffer.split("\n");
          for (let i = 0; i < bufferedLines.length; i++) {
            const line = bufferedLines[i];
            const data = parseLine(line, format);
            if (data) {
              mergeUsage(options?.extractUsage?.(data));
              mergeFinishReason(options?.extractFinishReason?.(data));
              const parts = extractContent(data);
              if (parts) {
                const shouldStop = handleParts(parts);
                if (shouldStop) {
                  return buildLocalStopResult(bufferedLines.slice(i + 1));
                }
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

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const data = parseLine(line, format);
        if (data) {
          mergeUsage(options?.extractUsage?.(data));
          mergeFinishReason(options?.extractFinishReason?.(data));
          const parts = extractContent(data);
          if (parts) {
            const shouldStop = handleParts(parts);
            if (shouldStop) {
              return buildLocalStopResult(lines.slice(i + 1));
            }
          }
        }
      }
    }
  } catch (error) {
    if (!stoppedByLocalStop) {
      if ((error as { name?: unknown })?.name !== "AbortError") {
        console.error("Stream processing error:", error);
      }
      throw error;
    }
  } finally {
    if (!releaseInBackground) {
      try {
        reader.releaseLock();
      } catch {
        // ignore release errors
      }
    }
  }

  if (options?.postProcess) {
    fullResponse = options.postProcess(fullResponse);
  }

  return {
    content: fullResponse,
    reasoning: reasoningResponse,
    ...(usage ? { usage } : {}),
    finishReason,
    stoppedByLocalStop,
    ...(stoppedByLocalStop
      ? { localStopReason: "local_stop_sequence" as const }
      : {}),
    ...(localStopState.matchedStop
      ? { localStopSequence: localStopState.matchedStop }
      : {}),
  };
}

export function filterToolCallTokensStreaming(
  input: string,
  state: { inside: boolean; pending: string; controlPending?: string },
): string {
  const nextState = {
    activeTag: state.inside ? "tool_calls" : null,
    pending: state.pending,
    controlPending: state.controlPending ?? "",
  };
  const filtered = filterTaggedControlTokensStreaming(input, nextState, []);
  state.inside = nextState.activeTag === "tool_calls";
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
    ...COPILOTZ_CONTROL_TAGS,
    ...STREAMING_HIDDEN_DIALECT_TAGS,
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
      const activeTag = structuredTags.find((tag) =>
        tag.name === state.activeTag
      );
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
    [...INTERNAL_LITERAL_CONTROL_TAGS, ...STRUCTURAL_LEAK_LITERALS],
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
2. To call a tool, emit one JSON object per line between a single <tool_calls> … </tool_calls> block.
   • Each object has exactly two keys: "name" (string) and "arguments" (object). No other keys.
   • "arguments" is a JSON object and may contain nested objects/arrays.
3. Use ONLY this <tool_calls> JSON format. Do NOT use any built-in or native tool/function-calling
   syntax. Specifically, never emit <minimax:tool_call>, <invoke>, <parameter>, <function_call>,
   <function=...>, tool_use blocks, XML parameter tags, or markdown code fences around the JSON.
4. Example (note the nested arguments object):

<tool_calls>
{ "name": "tool_name", "arguments": { "key_1": "value_1", "options": { "limit": 10, "tags": ["a", "b"] } } }
{ "name": "tool_name_2", "arguments": { "query": "value" } }
</tool_calls>
Sure — running those now.

5. Tool outputs may appear later as <tool_results> blocks. Treat them as returned execution results and never generate <tool_results> yourself.

=== TOOL CATALOG (read-only) ===

\`\`\`json
${toolDefinitions}
\`\`\``;
}

/**
 * Rehydrate a <tool_calls> block from recorded tool calls, if present in message metadata
 */
export function buildToolCallsBlock(toolCalls: ToolInvocation[]): string {
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
  return [`<tool_calls>`, ...objects, `</tool_calls>`].join("\n");
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

export function buildToolResultsBlock(
  toolResults: ToolInvocation[],
  fallbackContent?: string,
): string {
  const objects = toolResults.map((call) => {
    const obj: Record<string, unknown> = {
      name: call.tool.id,
    };
    const fallback = toolResults.length === 1 ? fallbackContent : undefined;
    if (
      typeof call.output !== "undefined" ||
      (fallback && fallback.length > 0)
    ) {
      obj.output = normalizeToolResultOutput(call, fallback);
    }
    if (call.id) obj.tool_call_id = call.id;
    if (call.status) obj.status = call.status;
    return JSON.stringify(obj);
  });

  return [`<tool_results>`, ...objects, `</tool_results>`].join("\n");
}

/**
 * Coerce an XML `<parameter>` value to a JS value, mirroring MiniMax's reference
 * parser: try JSON (objects/arrays/numbers/booleans/null), else keep the string.
 */
function coerceXmlParamValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

const XML_INVOKE_PATTERN =
  /<invoke\b[^>]*\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/invoke>/gi;
const XML_PARAMETER_PATTERN =
  /<parameter\b[^>]*\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/parameter>/gi;

/**
 * Recover tool calls emitted in the generalist Anthropic/MiniMax XML dialect:
 *   <invoke name="tool"><parameter name="k">value</parameter></invoke>
 * Works regardless of any surrounding wrapper (`<minimax:tool_call>`,
 * `<function_calls>`, etc.). Only invocations with at least one parameter are
 * returned; bare or mangled invocations are left for the corrective-retry path
 * so we never fabricate empty arguments.
 */
export function parseXmlInvokeToolCalls(response: string): ToolInvocation[] {
  const calls: ToolInvocation[] = [];
  XML_INVOKE_PATTERN.lastIndex = 0;
  for (const invoke of response.matchAll(XML_INVOKE_PATTERN)) {
    const name = (invoke[1] ?? invoke[2] ?? invoke[3] ?? "").trim();
    if (!name) continue;
    const inner = invoke[4] ?? "";
    const args: Record<string, unknown> = {};
    let paramCount = 0;
    XML_PARAMETER_PATTERN.lastIndex = 0;
    for (const param of inner.matchAll(XML_PARAMETER_PATTERN)) {
      const key = (param[1] ?? param[2] ?? param[3] ?? "").trim();
      if (!key) continue;
      const rawValue = (param[4] ?? "").replace(/^\n/, "").replace(/\n$/, "");
      args[key] = coerceXmlParamValue(rawValue);
      paramCount++;
    }
    if (paramCount === 0) continue;
    calls.push({
      id: crypto.randomUUID(),
      tool: { id: name },
      args: JSON.stringify(args),
    });
  }
  return calls;
}

/** Remove the structural special-token literals that some servers leak. */
export function stripStructuralLeakTokens(text: string): string {
  let out = text;
  for (const literal of STRUCTURAL_LEAK_LITERALS) {
    out = out.split(literal).join("");
  }
  return out;
}

/**
 * Strip recognized tool-call dialect markup (and structural leak tokens) from
 * text. Used both when a dialect call is recovered and as the final safety net
 * on the malformed-tool-call path, so protocol markup never reaches the user.
 */
export function sanitizeUserFacingText(text: string): string {
  let out = text
    .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/gi, "")
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "")
    .replace(/<invoke\b[\s\S]*?<\/invoke>/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
  // Remove any residual stray dialect tags (open or close) that survived,
  // e.g. mismatched </tool_calls>, dangling <invoke ...> / <parameter ...>.
  out = out.replace(
    /<\/?(?:[a-z0-9_]+:)?(?:tool_call|tool_calls|function_call|function_calls|invoke|parameter|tool_use)(?:\b[^>]*)?>/gi,
    "",
  );
  return stripStructuralLeakTokens(out).trim();
}

/**
 * Detect whether a response that produced no parsed tool calls nonetheless
 * looks like a (malformed) tool-call attempt. Canonical `<tool_calls>` markup
 * always counts; non-canonical dialects additionally require a known tool name
 * to be present, to avoid treating incidental prose/code as a tool intent.
 */
export function responseHasToolIntent(
  text: string,
  knownToolNames: string[] = [],
): boolean {
  if (!TOOL_INTENT_MARKER_PATTERN.test(text)) return false;
  if (/<\/?tool_calls\b/i.test(text)) return true;
  return knownToolNames.some(
    (name) =>
      typeof name === "string" && name.length > 0 && text.includes(name),
  );
}

/**
 * Parse tool calls from AI response using the canonical <tool_calls> JSON block,
 * with a generalist fallback that recovers the Anthropic/MiniMax `<invoke>` XML
 * dialect. When `knownToolNames` is provided, dialect recovery is gated on a
 * matching tool name to avoid false positives.
 */
export function parseToolCallsFromResponse(
  response: string,
  knownToolNames?: string[],
): { cleanResponse: string; toolCalls: ToolInvocation[] } {
  const toolCalls: ToolInvocation[] = [];
  let cleanResponse = response;

  // 1) Recover missing closing tags by balancing braces inside the last <tool_calls>
  //    If we find an opening tag without a closing one, attempt to extract until balanced JSON objects are complete,
  //    then synthetically append the closing tag to allow the standard parser to run.
  const startTag = "<tool_calls>";
  const endTag = "</tool_calls>";
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
        const rebuilt = response.slice(0, startIdx) + startTag +
          objs.join("\n") + endTag;
        response = rebuilt;
        cleanResponse = rebuilt;
      } else {
        // Never expose partial protocol markup to users. If the model was cut
        // off before a valid JSON object was recoverable, drop the dangling
        // control block and keep only user-facing prose before it.
        const rebuilt = response.slice(0, startIdx);
        response = rebuilt;
        cleanResponse = rebuilt;
      }
    }
  }

  // Regex to match <tool_calls> ... </tool_calls> block(s)
  const toolCallsPattern = /<tool_calls>([\s\S]*?)<\/tool_calls>/g;
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

  // Generalist recovery: if no canonical block parsed, accept the well-specified
  // <invoke>/<parameter> XML dialect (Anthropic/MiniMax) so we avoid a costly
  // corrective round-trip for these documented formats.
  if (toolCalls.length === 0) {
    const xmlCalls = parseXmlInvokeToolCalls(response);
    const recovered = knownToolNames && knownToolNames.length > 0
      ? xmlCalls.filter((call) => knownToolNames.includes(call.tool.id))
      : xmlCalls;
    if (recovered.length > 0) {
      toolCalls.push(...recovered);
      cleanResponse = sanitizeUserFacingText(cleanResponse);
    }
  }

  return { cleanResponse, toolCalls };
}

export function parseInternalControlTagsFromResponse(
  response: string,
): { cleanResponse: string; suppressResponse: boolean } {
  let cleanResponse = response;
  let suppressResponse = false;

  const noResponsePattern =
    /<no_response\s*\/>|<no_response>\s*<\/no_response>/g;
  const hasNoResponse = noResponsePattern.test(cleanResponse);
  noResponsePattern.lastIndex = 0;
  if (hasNoResponse) {
    suppressResponse = true;
    cleanResponse = cleanResponse.replace(noResponsePattern, "");
  }

  cleanResponse = cleanResponse
    .replace(/<tool_results>[\s\S]*?(?:<\/tool_results>|$)/g, "")
    .replace(/<continue_after_tool_results\s*\/>/g, "")
    .replace(
      /<continue_after_tool_results>[\s\S]*?<\/continue_after_tool_results>/g,
      "",
    )
    .trim();

  return { cleanResponse, suppressResponse };
}

export function parseTaggedBlocksFromResponse(
  response: string,
  tagNames: string[],
): { cleanResponse: string; extractedTags: Record<string, string[]> } {
  const extractedTags: Record<string, string[]> = {};
  let cleanResponse = response;
  const normalizedTags = normalizeStructuredTagNames(tagNames);

  for (const tagName of normalizedTags) {
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

  let earliestDangling:
    | { index: number; tagName: string; openTagEnd: number }
    | null = null;

  for (const tagName of normalizedTags) {
    const openPattern = new RegExp(`<${escapeRegex(tagName)}\\b[^>]*>`, "gi");
    const closePattern = new RegExp(`</${escapeRegex(tagName)}>`, "gi");
    const opens = [...cleanResponse.matchAll(openPattern)]
      .filter((match) => !(match[0] ?? "").trimEnd().endsWith("/>"));
    const closes = [...cleanResponse.matchAll(closePattern)];
    if (opens.length <= closes.length) continue;

    const danglingOpen = opens[closes.length];
    if (danglingOpen?.index === undefined) continue;
    const openTag = danglingOpen[0] ?? "";
    const candidate = {
      index: danglingOpen.index,
      tagName,
      openTagEnd: danglingOpen.index + openTag.length,
    };
    if (!earliestDangling || candidate.index < earliestDangling.index) {
      earliestDangling = candidate;
    }
  }

  if (earliestDangling) {
    const value = cleanResponse.slice(earliestDangling.openTagEnd).trim();
    if (value.length > 0) {
      extractedTags[earliestDangling.tagName] = [
        ...(extractedTags[earliestDangling.tagName] ?? []),
        value,
      ];
    }
    cleanResponse = cleanResponse.slice(0, earliestDangling.index);
  }

  return { cleanResponse: cleanResponse.trim(), extractedTags };
}

export function findDanglingControlTags(
  response: string,
  tagNames: readonly string[] = COPILOTZ_CONTROL_TAGS,
): string[] {
  const dangling: string[] = [];

  for (const tagName of normalizeStructuredTagNames([...tagNames])) {
    const openPattern = new RegExp(`<${escapeRegex(tagName)}\\b[^>]*>`, "gi");
    const closePattern = new RegExp(`</${escapeRegex(tagName)}>`, "gi");
    const opens = [...response.matchAll(openPattern)]
      .filter((match) => {
        const raw = match[0] ?? "";
        return !raw.trimEnd().endsWith("/>");
      });
    const closes = [...response.matchAll(closePattern)];
    if (opens.length > closes.length) {
      dangling.push(tagName);
    }
  }

  return dangling;
}

export function stripDanglingControlTail(
  response: string,
  tagNames: readonly string[] = COPILOTZ_CONTROL_TAGS,
): string {
  let earliestDanglingStart = -1;

  for (const tagName of findDanglingControlTags(response, tagNames)) {
    const openTag = `<${tagName}`;
    const index = response.toLowerCase().lastIndexOf(openTag);
    if (index !== -1) {
      earliestDanglingStart = earliestDanglingStart === -1
        ? index
        : Math.min(earliestDanglingStart, index);
    }
  }

  return earliestDanglingStart === -1
    ? response
    : response.slice(0, earliestDanglingStart);
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
