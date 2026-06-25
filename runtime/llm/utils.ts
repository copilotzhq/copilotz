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
  "<tool_results",
  "</tool_results>",
  "<continue_after_tool_results",
  "<result",
  "</result>",
  "<tool_result",
  "</tool_result>",
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
 * Protocol tags that must never be visible to users. Canonical `<tool_calls>`
 * blocks are parsed; non-canonical tool-call dialects trigger recovery; result
 * and continuation tags trigger local stops.
 */
const STREAMING_HIDDEN_PROTOCOL_TAGS = [
  "minimax:tool_call",
  "tool_call",
  "invoke",
  "parameter",
  "function_call",
  "function_calls",
  "tool_use",
  "tool",
  "tool_result",
  "result",
  "target_ids",
  "mm:think",
  "think",
  "thought",
  "thinking",
  "reasoning",
  "malformed_tool_call_recovery",
  "visible_reasoning_markup_recovery",
  "recovery_previous_response_context",
  "recovery_required_action",
  "recovery_tool_call_rules",
  "recovery_problem",
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
  /<\/?(?:[a-z0-9_]+:)?(?:tool_call|tool_calls|function_call|function_calls|invoke|parameter|tool_use|tool)\b/i;
const MALFORMED_TOOL_INTENT_MARKER_PATTERN =
  /<\/?(?:[a-z0-9_]+:)?(?:tool_call|function_call|function_calls|invoke|parameter|tool_use|tool)\b/i;
const REASONING_MARKUP_PATTERN =
  /<\/?(?:mm:)?(?:think|thought|thinking|reasoning)\b/i;
const USER_FACING_PROTOCOL_MARKER_PATTERN =
  /<\/?(?:[a-z0-9_]+:)?(?:tool_call|tool_calls|function_call|function_calls|invoke|parameter|tool_use|tool|tool_result|tool_results|result|continue_after_tool_results|target_ids|think|thought|thinking|reasoning|malformed_tool_call_recovery|visible_reasoning_markup_recovery|recovery_previous_response_context|recovery_required_action|recovery_tool_call_rules|recovery_problem)\b/i;

const APPROX_CHARS_PER_TOKEN = 4;

export type DegenerateRepetitionDetection = {
  startIndex: number;
  endIndex: number;
  reason: "low_entropy_periodic_tail";
  periodTokens: string[];
  scores: {
    normalizedEntropy: number;
    uniqueRatio: number;
    topTokenRatio: number;
    periodicity: number;
  };
};

type DegenerateRepetitionOptions = {
  maxTailChars?: number;
  windowSizes?: number[];
  minWindowTokens?: number;
  maxPeriod?: number;
  minRepeats?: number;
  normalizedEntropyMax?: number;
  uniqueRatioMax?: number;
  topTokenRatioMin?: number;
  periodicityMin?: number;
};

type RepetitionToken = {
  value: string;
  start: number;
  end: number;
};

const DEFAULT_REPETITION_OPTIONS: Required<DegenerateRepetitionOptions> = {
  maxTailChars: 4000,
  windowSizes: [48, 64, 96, 128, 192, 256],
  minWindowTokens: 48,
  maxPeriod: 16,
  minRepeats: 4,
  normalizedEntropyMax: 0.45,
  uniqueRatioMax: 0.25,
  topTokenRatioMin: 0.30,
  periodicityMin: 0.85,
};

function getEnvVar(key: string): string | undefined {
  try {
    const anyGlobal = globalThis as unknown as {
      Deno?: { env?: { get?: (name: string) => string | undefined } };
      process?: { env?: Record<string, string | undefined> };
    };
    const fromDeno = anyGlobal?.Deno?.env?.get?.(key);
    if (typeof fromDeno === "string") return fromDeno;
    const fromNode = anyGlobal?.process?.env?.[key];
    if (typeof fromNode === "string") return fromNode;
  } catch {
    // Ignore env lookup failures in unsupported runtimes.
  }
  return undefined;
}

/**
 * Diagnostic flag for stop-sequence behavior. Enable with
 * `COPILOTZ_DEBUG_STOP=1` (or the broad `COPILOTZ_DEBUG=1`) to log the native
 * stop sequences sent to providers, local stop matches, and whether a provider
 * keeps generating after a stop sequence (measured during the post-stop drain).
 */
export function isStopDebugEnabled(): boolean {
  return getEnvVar("COPILOTZ_DEBUG_STOP") === "1" ||
    getEnvVar("COPILOTZ_DEBUG") === "1";
}

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

function findStructuredStartTag(
  input: string,
  tagName: string,
): { index: number; length: number } | null {
  const lowerInput = input.toLowerCase();
  const lowerTag = tagName.toLowerCase();
  const needle = `<${lowerTag}`;
  let index = lowerInput.indexOf(needle);

  while (index !== -1) {
    const next = lowerInput[index + needle.length];
    if (
      next === undefined ||
      next === ">" ||
      next === "/" ||
      /\s/.test(next)
    ) {
      const closeIdx = input.indexOf(">", index + needle.length);
      return {
        index,
        length: closeIdx === -1 ? needle.length : closeIdx - index + 1,
      };
    }
    index = lowerInput.indexOf(needle, index + 1);
  }

  return null;
}

function structuredStartTagSuffixOverlap(
  input: string,
  tagName: string,
): number {
  const token = `<${tagName}`.toLowerCase();
  const lower = input.toLowerCase();
  let overlap = 0;
  for (let size = 1; size < token.length; size++) {
    if (lower.endsWith(token.slice(0, size))) overlap = size;
  }
  return overlap;
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

  // Collapse consecutive messages with the same role so provider history
  // alternates assistant/user turns (system messages stay separate).
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

const WIRE_STRIP_TAG_NAMES = [
  "redacted_thinking",
  "route_to",
  "ask_to",
  "tool_calls",
  "tool_results",
] as const;

const OMITTED_PEER_TOOL_VALUE = {
  _copilotz_omitted: true,
  reason: "public_status",
} as const;

export type WireToolFormat = "request" | "peer";

export type ComposeWireContentInput = {
  reasoning?: string;
  reasoningMaxChars?: number;
  noResponse?: boolean;
  visible?: string;
  routeTo?: string[];
  askTo?: string[];
  toolCalls?: ToolInvocation[];
  toolResults?: ToolInvocation[];
  toolCallFormat?: WireToolFormat;
  toolResultFormat?: WireToolFormat;
  toolResultsFallbackContent?: string;
};

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

function extractRoutingTargetsFromMetadata(
  metadata: ChatMessage["metadata"],
  key: "routeTo" | "askTo",
): string[] {
  if (!metadata || typeof metadata !== "object") return [];

  const routing = (metadata as { routing?: unknown }).routing;
  if (!routing || typeof routing !== "object") return [];

  const values = (routing as Record<string, unknown>)[key];
  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  const targets: string[] = [];

  for (const candidate of values) {
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

function extractInlineRoutingTargets(
  text: string,
  tagName: "route_to" | "ask_to",
): string[] {
  const pattern = new RegExp(
    `<${tagName}>([\\s\\S]*?)<\\/${tagName}>`,
    "gi",
  );
  const seen = new Set<string>();
  const targets: string[] = [];

  for (const match of text.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (!value) continue;
    const lower = value.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    targets.push(value);
  }

  return targets;
}

function mergeRoutingTargets(
  ...groups: string[][]
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const group of groups) {
    for (const target of group) {
      const lower = target.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      merged.push(target);
    }
  }

  return merged;
}

function hasNoResponseMarker(text: string): boolean {
  return /<no_response\s*\/>|<no_response>\s*<\/no_response>/i.test(text);
}

function truncateReasoningForWire(
  reasoning: string,
  maxChars?: number,
): string {
  if (typeof maxChars !== "number" || maxChars === 0 || reasoning.length <= maxChars) {
    return reasoning;
  }
  if (maxChars < 48) return "[reasoning truncated]";
  const prefix = `[reasoning truncated: ${
    reasoning.length - maxChars
  } chars omitted]\n`;
  if (maxChars <= prefix.length) return "[reasoning truncated]";
  return `${prefix}${
    reasoning.slice(-Math.max(0, maxChars - prefix.length))
  }`;
}

export function buildRedactedThinkingBlock(
  reasoning: string,
  maxChars?: number,
): string {
  const trimmed = reasoning.trim();
  if (!trimmed) return "";
  const capped = truncateReasoningForWire(trimmed, maxChars);
  return `<think>\n${capped}\n</think>`;
}

export function buildAskToBlock(askTargets: string[]): string {
  return extractRoutingTargetsFromMetadata({
    routing: { askTo: askTargets },
  }, "askTo")
    .map((target) => `<ask_to>${target}</ask_to>`)
    .join("\n");
}

export function stripWireProtocolFromText(text: string): string {
  let stripped = stripTaggedBlocksFromText(text, [...WIRE_STRIP_TAG_NAMES]);
  stripped = stripped
    .replace(/<no_response\s*\/>/gi, "")
    .replace(/<no_response>\s*<\/no_response>/gi, "");
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

function parseToolCallArgs(args: ToolInvocation["args"]): unknown {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function readPeerToolVisibility(
  call: ToolInvocation,
): "public" | "public_status" | "requester_only" {
  const visibility = (call as ToolInvocation & {
    visibility?: unknown;
  }).visibility;
  return visibility === "requester_only" || visibility === "public"
    ? visibility
    : "public_status";
}

export function composeWireContent(input: ComposeWireContentInput): string {
  const parts: string[] = [];

  if (typeof input.reasoning === "string" && input.reasoning.trim().length > 0) {
    parts.push(
      buildRedactedThinkingBlock(input.reasoning, input.reasoningMaxChars),
    );
  }

  if (input.noResponse) {
    parts.push(NO_RESPONSE_SELF_CLOSING_TAG);
  }

  if (typeof input.visible === "string" && input.visible.trim().length > 0) {
    parts.push(input.visible.trim());
  }

  const routeTo = mergeRoutingTargets(input.routeTo ?? []);
  if (routeTo.length > 0) {
    parts.push(buildRouteToBlock(routeTo));
  }

  const askTo = mergeRoutingTargets(input.askTo ?? []);
  if (askTo.length > 0) {
    parts.push(buildAskToBlock(askTo));
  }

  if (Array.isArray(input.toolCalls) && input.toolCalls.length > 0) {
    const block = buildToolCallsBlock(
      input.toolCalls,
      input.toolCallFormat ?? "request",
    );
    if (block) parts.push(block);
  }

  if (Array.isArray(input.toolResults) && input.toolResults.length > 0) {
    const block = buildToolResultsBlock(
      input.toolResults,
      input.toolResultsFallbackContent,
      input.toolResultFormat ?? "request",
    );
    if (block) parts.push(block);
  }

  return parts.join("\n\n");
}

function readWireToolFormat(
  metadata: ChatMessage["metadata"],
): WireToolFormat {
  return metadata && typeof metadata === "object" &&
      (metadata as { wireToolFormat?: unknown }).wireToolFormat === "peer"
    ? "peer"
    : "request";
}

function toolCallsRepresentResults(toolCalls: ToolInvocation[]): boolean {
  return toolCalls.some((call) => typeof call.output !== "undefined");
}

function collectWireSegmentsFromMessage(
  message: ChatMessage,
): ComposeWireContentInput {
  const rawText = contentToText(message.content);
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  const wireToolFormat = readWireToolFormat(message.metadata);
  const strippedVisible = stripWireProtocolFromText(rawText);

  const routeTo = mergeRoutingTargets(
    extractRoutingTargetsFromMetadata(message.metadata, "routeTo"),
    extractInlineRoutingTargets(rawText, "route_to"),
  );
  const askTo = mergeRoutingTargets(
    extractRoutingTargetsFromMetadata(message.metadata, "askTo"),
    extractInlineRoutingTargets(rawText, "ask_to"),
  );

  const base: ComposeWireContentInput = {
    reasoning: typeof message.reasoning === "string"
      ? message.reasoning
      : undefined,
    reasoningMaxChars: typeof message.reasoningMaxChars === "number"
      ? message.reasoningMaxChars
      : undefined,
    noResponse: hasNoResponseMarker(rawText),
    visible: strippedVisible.length > 0 ? strippedVisible : undefined,
    routeTo,
    askTo,
    toolCallFormat: wireToolFormat,
    toolResultFormat: wireToolFormat,
  };

  const emitToolResults = message.role === "tool" ||
    message.role === "tool_result" ||
    (message.metadata &&
      typeof message.metadata === "object" &&
      (message.metadata as { wireSegment?: unknown }).wireSegment ===
        "toolResults") ||
    toolCallsRepresentResults(toolCalls);

  if (emitToolResults && toolCalls.length > 0) {
    return {
      ...base,
      visible: undefined,
      noResponse: false,
      toolResults: toolCalls,
      toolResultsFallbackContent: toolCalls.length === 1 &&
          typeof toolCalls[0]?.output === "undefined"
        ? strippedVisible
        : undefined,
    };
  }

  if (toolCalls.length > 0) {
    return {
      ...base,
      toolCalls,
    };
  }

  return base;
}

function shouldMaterializeWireContent(message: ChatMessage): boolean {
  if (message.role === "tool" || message.role === "tool_result") {
    return Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
  }

  const speakerLabel = message.metadata &&
    typeof message.metadata === "object" &&
    typeof (message.metadata as { speakerLabel?: unknown }).speakerLabel ===
      "string";
  if (speakerLabel) return true;

  const toolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
  const routing =
    extractRoutingTargetsFromMetadata(message.metadata, "routeTo").length > 0 ||
    extractRoutingTargetsFromMetadata(message.metadata, "askTo").length > 0;
  const reasoning = typeof message.reasoning === "string" &&
    message.reasoning.trim().length > 0;
  const rawText = contentToText(message.content);
  const hasProtocolTags =
    /<(redacted_thinking|route_to|ask_to|tool_calls|tool_results|no_response)\b/i
      .test(rawText);

  if (message.role === "assistant" || message.role === "user") {
    return toolCalls || routing || reasoning || hasProtocolTags;
  }

  return false;
}

function applyComposedWireContent(
  original: ChatMessage["content"],
  composed: string,
): ChatMessage["content"] {
  if (typeof original === "string") return composed;

  const nonTextParts = original.filter((part) => part.type !== "text");
  if (nonTextParts.length === 0) return composed;
  if (!composed) return nonTextParts;

  return [{ type: "text", text: composed }, ...nonTextParts];
}

function prefixSpeakerLabel(label: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return `[${label}]:`;
  if (trimmed.startsWith("<") || trimmed.includes("\n")) {
    return `[${label}]:\n${trimmed}`;
  }
  return `[${label}]: ${trimmed}`;
}

function materializeWireContent(message: ChatMessage): ChatMessage {
  if (!shouldMaterializeWireContent(message)) {
    return message;
  }

  try {
    let composed = composeWireContent(collectWireSegmentsFromMessage(message));
    const speakerLabel = message.metadata &&
        typeof message.metadata === "object" &&
        typeof (message.metadata as { speakerLabel?: unknown }).speakerLabel ===
          "string"
      ? (message.metadata as { speakerLabel: string }).speakerLabel
      : undefined;
    if (speakerLabel) {
      composed = prefixSpeakerLabel(speakerLabel, composed);
    }

    const role = message.role === "tool" || message.role === "tool_result"
      ? "assistant"
      : message.role;

    const nextMetadata = message.metadata &&
        typeof message.metadata === "object"
      ? { ...message.metadata }
      : undefined;
    if (nextMetadata) {
      delete (nextMetadata as { speakerLabel?: unknown }).speakerLabel;
    }

    return {
      ...message,
      role,
      content: applyComposedWireContent(message.content, composed),
      metadata: nextMetadata &&
          Object.keys(nextMetadata).length > 0
        ? nextMetadata
        : undefined,
      toolCalls: undefined,
      reasoning: undefined,
      reasoningMaxChars: undefined,
      tool_call_id: undefined,
    };
  } catch {
    return message;
  }
}

export function buildRouteToBlock(routeTargets: string[]): string {
  const normalizedTargets = extractRoutingTargetsFromMetadata({
    routing: { routeTo: routeTargets },
  }, "routeTo");

  return normalizedTargets
    .map((target) => `<route_to>${target}</route_to>`)
    .join("\n");
}

function materializeHistoryMessage(message: ChatMessage): ChatMessage {
  return materializeWireContent(message);
}

function mergeConsecutiveMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    const canMerge = previous &&
      previous.role !== "system" &&
      message.role !== "system" &&
      previous.role === message.role &&
      (!Array.isArray(previous.toolCalls) || previous.toolCalls.length === 0) &&
      (!Array.isArray(message.toolCalls) || message.toolCalls.length === 0);

    if (canMerge) {
      const sameSender = typeof previous.senderId === "string" &&
        typeof message.senderId === "string" &&
        previous.senderId === message.senderId;

      merged[merged.length - 1] = {
        ...previous,
        content: mergeMessageContent(previous.content, message.content),
        senderId: sameSender ? previous.senderId : undefined,
        metadata: sameSender ? previous.metadata : undefined,
        reasoning: sameSender ? previous.reasoning : undefined,
        reasoningMaxChars: sameSender ? previous.reasoningMaxChars : undefined,
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

function tokenizeRepetitionTail(
  text: string,
  maxTailChars: number,
): RepetitionToken[] {
  const tailStart = Math.max(0, text.length - maxTailChars);
  const tail = text.slice(tailStart);
  const tokens: RepetitionToken[] = [];
  const tokenPattern = /[a-z0-9_]+/gi;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(tail)) !== null) {
    const raw = match[0];
    if (!raw) continue;
    tokens.push({
      value: raw.toLowerCase(),
      start: tailStart + match.index,
      end: tailStart + match.index + raw.length,
    });
  }

  return tokens;
}

function scoreTokenConcentration(tokens: RepetitionToken[]): {
  normalizedEntropy: number;
  uniqueRatio: number;
  topTokenRatio: number;
} {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token.value, (counts.get(token.value) ?? 0) + 1);
  }

  const total = tokens.length;
  const unique = counts.size;
  const topCount = Math.max(0, ...counts.values());
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  return {
    normalizedEntropy: unique <= 1 ? 0 : entropy / Math.log2(unique),
    uniqueRatio: unique / total,
    topTokenRatio: topCount / total,
  };
}

function repetitionPeriodicityScore(
  tokens: RepetitionToken[],
  start: number,
  end: number,
  period: number,
): number {
  const comparable = end - start - period;
  if (period <= 0 || comparable <= 0) return 0;

  let matches = 0;
  for (let i = start + period; i < end; i++) {
    if (tokens[i].value === tokens[i - period].value) matches++;
  }
  return matches / comparable;
}

function findBestRepetitionPeriod(
  tokens: RepetitionToken[],
  start: number,
  end: number,
  options: Required<DegenerateRepetitionOptions>,
): { period: number; score: number } | null {
  let best: { period: number; score: number } | null = null;
  const length = end - start;
  const maxPeriod = Math.min(options.maxPeriod, Math.floor(length / 2));

  for (let period = 1; period <= maxPeriod; period++) {
    const repeats = length / period;
    if (repeats < options.minRepeats) continue;

    const score = repetitionPeriodicityScore(tokens, start, end, period);
    if (score < options.periodicityMin) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && period < best.period)
    ) {
      best = { period, score };
    }
  }

  return best;
}

function refineRepetitionStart(
  tokens: RepetitionToken[],
  windowStart: number,
  period: number,
): number {
  let bestStart = windowStart;

  while (bestStart > 0) {
    const previous = tokens[bestStart - 1];
    const aligned = tokens[bestStart - 1 + period];
    if (!aligned || previous.value !== aligned.value) break;
    bestStart--;
  }

  return bestStart;
}

export function detectDegenerateRepetition(
  text: string,
  customOptions: DegenerateRepetitionOptions = {},
): DegenerateRepetitionDetection | null {
  const options: Required<DegenerateRepetitionOptions> = {
    ...DEFAULT_REPETITION_OPTIONS,
    ...customOptions,
    windowSizes: customOptions.windowSizes ??
      DEFAULT_REPETITION_OPTIONS.windowSizes,
  };
  const tokens = tokenizeRepetitionTail(text, options.maxTailChars);
  if (tokens.length < options.minWindowTokens) return null;

  const sortedWindowSizes = [...options.windowSizes]
    .filter((size) => size >= options.minWindowTokens)
    .sort((a, b) => a - b);

  let bestDetection: DegenerateRepetitionDetection | null = null;

  for (const windowSize of sortedWindowSizes) {
    if (tokens.length < windowSize) continue;

    const start = tokens.length - windowSize;
    const end = tokens.length;
    const windowTokens = tokens.slice(start, end);
    const scores = scoreTokenConcentration(windowTokens);
    const entropySuspicious =
      scores.normalizedEntropy <= options.normalizedEntropyMax ||
      scores.uniqueRatio <= options.uniqueRatioMax ||
      scores.topTokenRatio >= options.topTokenRatioMin;

    if (!entropySuspicious) continue;

    const period = findBestRepetitionPeriod(tokens, start, end, options);
    if (!period) continue;

    const refinedStart = refineRepetitionStart(
      tokens,
      start,
      period.period,
    );
    const candidate: DegenerateRepetitionDetection = {
      startIndex: tokens[refinedStart].start,
      endIndex: tokens[end - 1].end,
      reason: "low_entropy_periodic_tail",
      periodTokens: tokens
        .slice(refinedStart, Math.min(refinedStart + period.period, end))
        .map((token) => token.value),
      scores: {
        ...scores,
        periodicity: period.score,
      },
    };

    if (
      !bestDetection ||
      candidate.scores.periodicity > bestDetection.scores.periodicity ||
      (candidate.scores.periodicity === bestDetection.scores.periodicity &&
        candidate.startIndex < bestDetection.startIndex)
    ) {
      bestDetection = candidate;
    }
  }

  return bestDetection;
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
  const stopDebug = isStopDebugEnabled();
  let postStopVisibleChars = 0;
  let postStopReasoningChars = 0;
  let postStopContentEvents = 0;
  let postStopSample = "";
  if (stopDebug) {
    console.log("[stop-debug] processStream init", {
      provider: config?.provider,
      model: config?.model,
      format,
      continueAfterLocalStop: options?.continueAfterLocalStop === true,
      localStopSequences,
    });
  }
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
          if (stopDebug) {
            console.log("[stop-debug] local stop matched", {
              matchedStop: localStopResult.matchedStop,
              visibleCharsBeforeStop: fullResponse.length,
            });
          }
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
    if (stopDebug) {
      const parts = extractContent(data);
      if (parts) {
        for (const part of parts) {
          if (part.text.length === 0) continue;
          postStopContentEvents += 1;
          if (part.isReasoning) {
            postStopReasoningChars += part.text.length;
          } else {
            postStopVisibleChars += part.text.length;
            if (postStopSample.length < 200) postStopSample += part.text;
          }
        }
      }
    }
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

    if (stopDebug) {
      console.log("[stop-debug] post-stop drain summary", {
        provider: config?.provider,
        model: config?.model,
        postStopContentEvents,
        postStopVisibleChars,
        postStopReasoningChars,
        finishReason,
        postStopVisibleSample: postStopSample,
        interpretation: postStopVisibleChars > 0
          ? "provider KEPT GENERATING visible content after the stop sequence (no server-side stop)"
          : "no further visible content after the stop sequence (provider likely stopped server-side)",
      });
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
    ...STREAMING_HIDDEN_PROTOCOL_TAGS,
    ...extractedBlockTags,
  ]).map((name) => ({
    name,
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
        const match = findStructuredStartTag(s, tag.name);
        const index = match?.index ?? -1;
        if (index === -1) continue;
        if (!nextMatch || index < nextMatch.index) {
          nextMatch = {
            index,
            tagName: tag.name,
            tagLength: match?.length ?? 0,
          };
        }
      }

      if (!nextMatch) {
        let overlap = 0;
        for (const tag of structuredTags) {
          overlap = Math.max(
            overlap,
            structuredStartTagSuffixOverlap(s, tag.name),
          );
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

export type ToolSystemPromptVariant =
  | "baseline"
  | "no-visible-ack"
  | "tool-only-turn"
  | "useful-visible-contract"
  | "tool-call-contract"
  | "lifecycle-explicit"
  | "strict-minimal";

function readToolSystemPromptVariant(): ToolSystemPromptVariant {
  let raw: string | undefined;
  try {
    raw = typeof Deno !== "undefined"
      ? Deno.env.get("COPILOTZ_TOOL_PROMPT_VARIANT")
      : undefined;
  } catch {
    raw = undefined;
  }
  switch (raw) {
    case "no-visible-ack":
    case "tool-only-turn":
    case "useful-visible-contract":
    case "tool-call-contract":
    case "lifecycle-explicit":
    case "strict-minimal":
      return raw;
    default:
      return "useful-visible-contract";
  }
}

export function generateToolSystemPrompt(tools: ToolDefinition[]): string {
  const variant = readToolSystemPromptVariant();
  return generateToolSystemPromptVariant(tools, variant);
}

export function generateToolSystemPromptVariant(
  tools: ToolDefinition[],
  variant: ToolSystemPromptVariant = "baseline",
): string {
  const toolDefinitions = tools.map((tool) => JSON.stringify(tool)).join("\n");

  if (variant === "strict-minimal") {
    return `
=== TOOL USAGE ===

You have access to tools. Copilotz, not the provider, executes tools.

When a tool is needed, emit optional visible text first, then exactly one <tool_calls> block. Inside it, emit one JSON object per line:
{ "name": "tool_name", "arguments": { ... } }

Rules:
- Each object must have exactly "name" and "arguments".
- "arguments" must be a JSON object.
- Use only tool names from the catalog.
- Do not use provider-native tool syntax or any non-Copilotz tool format.
- Do not emit <tool_results>; Copilotz provides tool results.

Example:
Sure — checking that now.

<tool_calls>
{ "name": "tool_name", "arguments": { "key": "value" } }
</tool_calls>

=== TOOL CATALOG (read-only) ===

\`\`\`json
${toolDefinitions}
\`\`\``;
  }

  const extraRules: string[] = [];
  if (variant === "tool-only-turn") {
    extraRules.push(
      "When calling tools, emit only the <tool_calls> block in that assistant message. Do not add acknowledgements, explanations, markdown, or filler text before or after the block.",
    );
  }
  if (variant === "tool-call-contract") {
    extraRules.push(
      "If you call tools, the assistant message must contain only the <tool_calls> block. Do not include acknowledgements, status updates, summaries, markdown, or final answers in that same assistant message.",
    );
    extraRules.push(
      "Only include visible text before a tool call when the user explicitly asks you to explain before acting.",
    );
    extraRules.push(
      "If the user asks you to use a tool, call the tool before answering even when you already know the answer. Never include the final answer in the same assistant message as a tool call.",
    );
  }
  if (variant === "useful-visible-contract") {
    extraRules.push(
      'Visible text before a tool call is allowed only when it is useful to the user, such as a brief requested explanation. Merely saying which tools you will call is not useful. Do not emit generic acknowledgements, status narration, or filler such as "Sure", "I\'ll call the tool", or "running that now".',
    );
    extraRules.push(
      "When a tool result is needed before answering, do not include the final answer in the same assistant message as the tool call. Wait for it will be provided as <tool_results> in next turn, then answer from those results.",
    );
    extraRules.push(
      "When your response includes multiple sections, emit them in this order: optional visible text, then any <route_to> or <ask_to> tags, then <tool_calls>. Never place routing or tool blocks before visible text unless there is no visible text.",
    );
  }
  if (variant === "lifecycle-explicit") {
    extraRules.push(
      "Tool-calling is a loop: you emit <tool_calls>, Copilotz executes those calls, Copilotz later inserts <tool_results>, and you then use those results to continue or answer. Do not invent tool results yourself.",
    );
  }
  const ruleOne = variant === "baseline" || variant === "no-visible-ack"
    ? "You may talk to the human normally and call tools in the same response. Put visible text first, then any routing tags, then <tool_calls>."
    : "You may answer the human normally when no tool is needed. When a tool is needed, put visible text first, then any routing tags, then <tool_calls>.";
  const extraRuleText = extraRules.length > 0
    ? "\n" +
      extraRules.map((rule, index) => `${4 + index}. ${rule}`).join("\n") +
      "\n"
    : "";
  const exampleTail = variant === "baseline"
    ? "\nSure - running those now."
    : "";
  const exampleRuleNumber = 4 + extraRules.length;
  const nextRuleNumber = exampleRuleNumber + 1;

  return `

=== THINKING ===

Your previous thinking traces may appear as <think> ... </think> blocks. Do not include them in your response.

=== RESPONSE STRUCTURE ===

When a response includes multiple sections, emit them in this order:
1. Visible text for the user (if any)
2. <route_to>agent-id</route_to> and/or <ask_to>agent-id</ask_to> (if routing)
3. <tool_calls> ... </tool_calls> (if calling tools)
Copilotz inserts <tool_results> later; never emit tool results yourself.
If no visible reply is needed, respond with <no_response/>.

=== TOOL USAGE ===

In this environment you have access to a set of tools you can use to answer the user's question.

=== RULES ===

1. ${ruleOne}
2. To call a tool, emit one JSON object per line between a single <tool_calls> ... </tool_calls> block.
   - Each object has exactly two keys: "name" (string) and "arguments" (object). No other keys.
   - "arguments" is a JSON object and may contain nested objects/arrays.
3. Use ONLY this <tool_calls> JSON format for tool calls..
${extraRuleText}${exampleRuleNumber}. 

##### Example (note the nested arguments object):

>
> Sure. Let me check the weather in New York and Tokyo for today.
>
> <tool_calls>
> { "name": "get_weather", "arguments": { "city": "New York", "config": { "units": "celsius" } } }
> { "name": "get_weather", "arguments": { "city": "Tokyo", "config": { "units": "celsius" } } }
> </tool_calls>
>

${nextRuleNumber}. Tool outputs may appear later as <tool_results> blocks. Treat them as returned execution results and never generate <tool_results>, <tool_result>, <result>, <target_ids>, or <continue_after_tool_results> yourself.
${nextRuleNumber + 1}

=== TOOL CATALOG (read-only) ===

\`\`\`json
${toolDefinitions}
\`\`\``;
}

/**
 * Rehydrate a <tool_calls> block from recorded tool calls, if present in message metadata
 */
export function buildToolCallsBlock(
  toolCalls: ToolInvocation[],
  format: WireToolFormat = "request",
): string {
  const objects = toolCalls.flatMap((call) => {
    if (format === "peer") {
      const visibility = readPeerToolVisibility(call);
      if (visibility === "requester_only") return [];
      const obj: Record<string, unknown> = {
        name: call.tool.id,
        status: call.status ?? "requested",
        arguments: visibility === "public"
          ? parseToolCallArgs(call.args)
          : OMITTED_PEER_TOOL_VALUE,
      };
      if (call.id) obj.tool_call_id = call.id;
      return [JSON.stringify(obj)];
    }

    let args: unknown;
    try {
      args = typeof call.args === "string" ? JSON.parse(call.args) : call.args;
    } catch {
      args = call.args;
    }
    const obj: Record<string, unknown> = { name: call.tool.id, arguments: args };
    if (call.id) obj.tool_call_id = call.id;
    return [JSON.stringify(obj)];
  });

  if (objects.length === 0) return "";

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
  format: WireToolFormat = "request",
): string {
  const objects = toolResults.flatMap((call) => {
    if (format === "peer") {
      const visibility = readPeerToolVisibility(call);
      if (visibility === "requester_only") return [];
      const obj: Record<string, unknown> = {
        name: call.tool.id,
        status: call.status ?? "completed",
        output: visibility === "public"
          ? ("output" in call ? call.output : null)
          : OMITTED_PEER_TOOL_VALUE,
      };
      if (call.id) obj.tool_call_id = call.id;
      return [JSON.stringify(obj)];
    }

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
    return [JSON.stringify(obj)];
  });

  if (objects.length === 0) return "";

  return [`<tool_results>`, ...objects, `</tool_results>`].join("\n");
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value),
  );
}

function parseCanonicalToolCallLines(blockContent: string): ToolInvocation[] {
  const lines = blockContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return [];

  const calls: ToolInvocation[] = [];
  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return [];
    }

    if (!isPlainJsonObject(obj)) return [];
    const keys = Object.keys(obj).sort();
    const hasOnlyCanonicalKeys =
      (keys.length === 2 && keys[0] === "arguments" && keys[1] === "name") ||
      (keys.length === 3 && keys[0] === "arguments" && keys[1] === "name" &&
        keys[2] === "tool_call_id");
    if (!hasOnlyCanonicalKeys) {
      return [];
    }
    if (typeof obj.name !== "string" || !isPlainJsonObject(obj.arguments)) {
      return [];
    }
    if (
      "tool_call_id" in obj && typeof obj.tool_call_id !== "string"
    ) {
      return [];
    }

    calls.push({
      id: typeof obj.tool_call_id === "string"
        ? obj.tool_call_id
        : crypto.randomUUID(),
      tool: { id: obj.name },
      args: JSON.stringify(obj.arguments),
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
    .replace(/<tool_call\b[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_results\b[\s\S]*?(?:<\/tool_results>|$)/gi, "")
    .replace(/<tool_result\b[\s\S]*?(?:<\/tool_result>|$)/gi, "")
    .replace(/<result\b[\s\S]*?(?:<\/result>|$)/gi, "")
    .replace(
      /<continue_after_tool_results\b[\s\S]*?(?:<\/continue_after_tool_results>|$)/gi,
      "",
    )
    .replace(
      /<(?:mm:)?(?:think|thought|thinking|reasoning)\b[^>]*>[\s\S]*?(?:<\/(?:mm:)?(?:think|thought|thinking|reasoning)>|$)/gi,
      "",
    )
    .replace(
      /<malformed_tool_call_recovery\b[\s\S]*?(?:<\/malformed_tool_call_recovery>|$)/gi,
      "",
    )
    .replace(
      /<visible_reasoning_markup_recovery\b[\s\S]*?(?:<\/visible_reasoning_markup_recovery>|$)/gi,
      "",
    );
  // Remove any residual stray dialect tags (open or close) that survived,
  // e.g. mismatched </tool_calls>, dangling <invoke ...> / <parameter ...>.
  out = out.replace(
    /<\/?(?:[a-z0-9_]+:)?(?:tool_call|tool_calls|function_call|function_calls|invoke|parameter|tool_use|tool|tool_result|tool_results|result|continue_after_tool_results|target_ids|think|thought|thinking|reasoning|malformed_tool_call_recovery|visible_reasoning_markup_recovery|recovery_previous_response_context|recovery_required_action|recovery_tool_call_rules|recovery_problem)(?:\b[^>]*)?>/gi,
    "",
  );
  const firstProtocolMarker = out.search(USER_FACING_PROTOCOL_MARKER_PATTERN);
  if (firstProtocolMarker !== -1) {
    out = out.slice(0, firstProtocolMarker);
  }
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

export function responseHasMalformedToolCallIntent(
  text: string,
  knownToolNames: string[] = [],
): boolean {
  if (!MALFORMED_TOOL_INTENT_MARKER_PATTERN.test(text)) return false;
  return knownToolNames.length > 0;
}

export function responseHasReasoningMarkup(text: string): boolean {
  return REASONING_MARKUP_PATTERN.test(text);
}

/**
 * Parse tool calls from AI response using only the canonical <tool_calls>
 * JSON-lines block. Non-canonical/native tool dialects are intentionally not
 * normalized; callers detect them separately and trigger corrective recovery.
 */
export function parseToolCallsFromResponse(
  response: string,
  _knownToolNames?: string[],
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
      // Never expose partial protocol markup to users. If the model was cut off
      // before a complete canonical block, drop the dangling block and let the
      // malformed-tool recovery path correct the next attempt.
      const rebuilt = response.slice(0, startIdx);
      response = rebuilt;
      cleanResponse = rebuilt;
    }
  }

  // Regex to match <tool_calls> ... </tool_calls> block(s)
  const toolCallsPattern = /<tool_calls>([\s\S]*?)<\/tool_calls>/g;
  const matches = [...response.matchAll(toolCallsPattern)];

  for (const match of matches) {
    const blockContent = match[1].trim();
    let parsedCalls = parseCanonicalToolCallLines(blockContent);
    if (parsedCalls.length === 0 && blockContent.includes(startTag)) {
      const restartedBlock = blockContent.slice(
        blockContent.lastIndexOf(startTag) + startTag.length,
      ).trim();
      parsedCalls = parseCanonicalToolCallLines(restartedBlock);
    }
    toolCalls.push(...parsedCalls);

    cleanResponse = cleanResponse.replace(match[0], "").trimStart();
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
    .replace(/<tool_results\b[\s\S]*?(?:<\/tool_results>|$)/gi, "")
    .replace(/<tool_result\b[\s\S]*?(?:<\/tool_result>|$)/gi, "")
    .replace(/<result\b[\s\S]*?(?:<\/result>|$)/gi, "")
    .replace(/<continue_after_tool_results\s*\/>/gi, "")
    .replace(
      /<continue_after_tool_results\b[\s\S]*?(?:<\/continue_after_tool_results>|$)/gi,
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
