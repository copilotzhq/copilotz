import type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ToolInvocation,
  WireChatMessage,
} from "./types.ts";
import { LLMTranscriptError } from "./errors.ts";
import { estimateTextTokens } from "../authoring/token-estimation/index.ts";
import { type ChatTokenEstimate, estimateChatMessages } from "./chat-tokens.ts";
import {
  escapeRegex,
  NO_RESPONSE_SELF_CLOSING_TAG,
  normalizeStructuredTagNames,
} from "./protocol-tags.ts";
import { generateToolSystemPrompt } from "./tool-prompt.ts";

/**
 * Formats chat messages with instructions and applies estimated input limits.
 */
export interface FormattedMessagesResult {
  messages: WireChatMessage[];
  estimate: ChatTokenEstimate;
}

export function formatMessagesDetailed(
  { messages, instructions, config, tools }: ChatRequest,
  options: Readonly<{ calibrationFactor?: number }> = {},
): FormattedMessagesResult {
  // Build system content with instructions and tool definitions
  let systemContent: ChatMessage["content"] = instructions ?? "";
  if (instructions === undefined) {
    systemContent = messages
      .filter((message) => message.role === "system")
      .reduce<ChatMessage["content"]>(
        (combined, message) =>
          isEmptyContent(combined)
            ? message.content
            : mergeMessageContent(combined, message.content),
        "",
      );
  }

  // Add tool definitions to system prompt if tools are provided
  if (tools && tools.length > 0) {
    const toolSystemPrompt = generateToolSystemPrompt(
      tools,
      config?.toolSystemPromptVariant,
    );
    systemContent = isEmptyContent(systemContent)
      ? toolSystemPrompt
      : mergeMessageContent(toolSystemPrompt, systemContent);
  }

  // Add system message if content exists
  const hasSystemContent = !isEmptyContent(systemContent);
  const systemMessage: ChatMessage[] = hasSystemContent
    ? [{ role: "system", content: systemContent }]
    : [];

  const formattedMessages: ChatMessage[] = [
    ...systemMessage,
    ...messages.filter((m) => m.role !== "system"),
  ];
  // Materialize first so tool I/O is embedded in `content` (tool_results /
  // tool_calls blocks). The input limiter only inspects `content` (plus
  // multimodal parts); it cannot see structured `toolCalls` on the wire.
  let normalizedMessages = groupAdjacentToolResults(formattedMessages).map(
    materializeWireContent,
  );

  // Ensure system message is first if it exists
  if (hasSystemContent && normalizedMessages[0]?.role !== "system") {
    normalizedMessages = [
      { role: "system", content: systemContent },
      ...normalizedMessages,
    ];
  }

  // Collapse consecutive messages with the same role so provider history
  // alternates assistant/user turns. Explicit private-task boundaries preserve
  // the exact cached prefix; system messages also stay separate.
  const finalMessages = mergeConsecutiveMessages(normalizedMessages);
  assertWireMessageInvariants(finalMessages);
  const estimate = estimateChatMessages(
    finalMessages,
    config,
    options.calibrationFactor,
  );
  return {
    messages: finalMessages,
    estimate,
  };
}

export function formatMessages(request: ChatRequest): WireChatMessage[] {
  return formatMessagesDetailed(request).messages;
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
  "tool_calls",
  "tool_results",
  "tool_result",
  "result",
  "continue_after_tool_results",
] as const;

export type ComposeWireContentInput = {
  reasoning?: string;
  reasoningMaxEstimatedTokens?: number;
  noResponse?: boolean;
  visible?: string;
  toolCalls?: ToolInvocation[];
  toolResults?: ToolInvocation[];
};

function stripTaggedBlocksFromText(text: string, tagNames: string[]): string {
  let stripped = text;
  for (const tagName of normalizeStructuredTagNames(tagNames)) {
    const tag = escapeRegex(tagName);
    const block = new RegExp(
      `<${tag}\\b(?:[^>]*>[\\s\\S]*?(?:<\\/${tag}\\s*>|$)|[^>]*$)`,
      "gi",
    );
    const strayClosingTag = new RegExp(`<\\/${tag}\\s*>`, "gi");
    stripped = stripped.replace(block, "").replace(strayClosingTag, "");
  }
  return stripped;
}

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;

  return content
    .filter((part) => part.type === "text")
    .map((part) => (part as Extract<ChatContentPart, { type: "text" }>).text)
    .join("");
}

function hasNoResponseMarker(text: string): boolean {
  return /<no_response\s*\/>|<no_response>\s*<\/no_response>/i.test(text);
}

function truncateReasoningForWire(
  reasoning: string,
  maxEstimatedTokens?: number,
): string {
  if (
    typeof maxEstimatedTokens !== "number" ||
    maxEstimatedTokens === 0 ||
    estimateTextTokens(reasoning) <= maxEstimatedTokens
  ) {
    return reasoning;
  }
  if (maxEstimatedTokens < 12) return "[reasoning truncated]";
  let suffixLength = Math.max(0, maxEstimatedTokens * 4 - 96);
  while (suffixLength > 0) {
    const omitted = Math.max(0, reasoning.length - suffixLength);
    const candidate = `[reasoning truncated: ${omitted} chars omitted]\n${
      reasoning.slice(-suffixLength)
    }`;
    if (estimateTextTokens(candidate) <= maxEstimatedTokens) return candidate;
    suffixLength = Math.floor(suffixLength * 0.88);
  }
  return "[reasoning truncated]";
}

function escapeWireTextPayload(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildRedactedThinkingBlock(
  reasoning: string,
  maxEstimatedTokens?: number,
): string {
  const trimmed = reasoning.trim();
  if (!trimmed) return "";
  // Reasoning is payload inside an XML-like protocol envelope. Encode it
  // before applying the wire budget so arbitrary model text cannot close the
  // thinking block or impersonate a control segment.
  const escaped = escapeWireTextPayload(trimmed);
  const capped = truncateReasoningForWire(escaped, maxEstimatedTokens);
  return `<think>\n${capped}\n</think>`;
}

export function stripWireProtocolFromText(text: string): string {
  let stripped = stripTaggedBlocksFromText(text, [...WIRE_STRIP_TAG_NAMES]);
  stripped = stripped
    .replace(/<no_response\s*\/>/gi, "")
    .replace(/<no_response>\s*<\/no_response>/gi, "");
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

function stringifyWireJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      throw new TypeError("Wire payload is not JSON serializable");
    }
    // JSON semantics are unchanged, while protocol-looking strings remain
    // data even when tool output contains literal closing/opening tags.
    return serialized
      .replace(/&/g, "\\u0026")
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e");
  } catch (error) {
    throw new LLMTranscriptError(
      "Failed to serialize structured provider transcript payload",
      { cause: error },
    );
  }
}

export function composeWireContent(input: ComposeWireContentInput): string {
  const parts: string[] = [];

  if (
    typeof input.reasoning === "string" && input.reasoning.trim().length > 0
  ) {
    parts.push(
      buildRedactedThinkingBlock(
        input.reasoning,
        input.reasoningMaxEstimatedTokens,
      ),
    );
  }

  if (input.noResponse) {
    parts.push(NO_RESPONSE_SELF_CLOSING_TAG);
  }

  if (typeof input.visible === "string" && input.visible.trim().length > 0) {
    parts.push(input.visible.trim());
  }

  if (Array.isArray(input.toolCalls) && input.toolCalls.length > 0) {
    const block = buildToolCallsBlock(input.toolCalls);
    if (block) parts.push(block);
  }

  if (Array.isArray(input.toolResults) && input.toolResults.length > 0) {
    const block = buildToolResultsBlock(input.toolResults);
    if (block) parts.push(block);
  }

  return parts.join("\n\n");
}

function collectWireSegmentsFromMessage(
  message: ChatMessage,
): ComposeWireContentInput {
  const toolCalls = message.toolCalls ?? [];
  if (message.role === "tool") return { toolResults: toolCalls };
  const rawText = contentToText(message.content);
  const visible = stripWireProtocolFromText(rawText);
  return {
    reasoning: message.reasoning,
    reasoningMaxEstimatedTokens: message.reasoningMaxEstimatedTokens,
    noResponse: hasNoResponseMarker(rawText),
    visible: visible || undefined,
    toolCalls,
  };
}

function shouldMaterializeWireContent(message: ChatMessage): boolean {
  if (message.role === "tool") return true;
  if (message.role === "user" && message.speaker) return true;

  const toolCalls = Array.isArray(message.toolCalls) &&
    message.toolCalls.length > 0;
  const reasoning = typeof message.reasoning === "string" &&
    message.reasoning.trim().length > 0;
  const rawText = contentToText(message.content);
  const hasProtocolTags =
    /<\/?(redacted_thinking|tool_calls|tool_results?|result|continue_after_tool_results|no_response)\b/i
      .test(rawText);

  if (message.role === "assistant" || message.role === "user") {
    return toolCalls || reasoning || hasProtocolTags;
  }

  return false;
}

function hasNativeReasoning(message: ChatMessage): boolean {
  return Boolean(
    message.nativeReasoning && message.nativeReasoning.blocks.length > 0,
  );
}

function applyComposedWireContent(
  original: ChatMessage["content"],
  composed: string,
): ChatMessage["content"] {
  if (typeof original === "string") return composed;

  const nonTextParts = original.filter((part) => part.type !== "text");
  if (nonTextParts.length === 0) {
    return composed;
  }
  if (!composed) return nonTextParts;

  return [{ type: "text", text: composed }, ...nonTextParts];
}

function prefixSpeakerLabel(label: string, body: string): string {
  const safeLabel = escapeWireTextPayload(label);
  const trimmed = body.trim();
  if (!trimmed) return `[${safeLabel}]:`;
  if (trimmed.startsWith("<") || trimmed.includes("\n")) {
    return `[${safeLabel}]:\n${trimmed}`;
  }
  return `[${safeLabel}]: ${trimmed}`;
}

function materializeWireContent(message: ChatMessage): WireChatMessage {
  const { toolPlanId: _toolPlanId, ...wireMessage } = message;
  if (message.role === "tool" && !message.toolCalls?.length) {
    throw new LLMTranscriptError(
      "Tool history messages must carry structured results",
    );
  }
  if (message.role !== "tool" && !shouldMaterializeWireContent(message)) {
    return { ...wireMessage, role: message.role };
  }

  try {
    const segments = collectWireSegmentsFromMessage(message);
    const composed = composeWireContent(segments);
    const labelled = message.role === "user" && message.speaker
      ? prefixSpeakerLabel(message.speaker, composed)
      : composed;

    return {
      ...wireMessage,
      role: message.role === "tool" ? "user" : message.role,
      content: applyComposedWireContent(message.content, labelled),
      metadata: message.metadata && Object.keys(message.metadata).length > 0
        ? message.metadata
        : undefined,
      toolCalls: undefined,
      reasoning: undefined,
      reasoningMaxEstimatedTokens: undefined,
    };
  } catch (error) {
    if (error instanceof LLMTranscriptError) throw error;
    throw new LLMTranscriptError(
      "Failed to materialize provider transcript",
      { cause: error },
    );
  }
}

/** Adjacent tool messages become one results turn with a single block. */
function groupAdjacentToolResults(messages: ChatMessage[]): ChatMessage[] {
  const grouped: ChatMessage[] = [];
  for (const message of messages) {
    const previous = grouped[grouped.length - 1];
    if (
      message.role === "tool" && previous?.role === "tool" &&
      message.toolCalls?.length && previous.toolCalls?.length
    ) {
      grouped[grouped.length - 1] = {
        ...previous,
        toolCalls: [...previous.toolCalls, ...message.toolCalls],
      };
      continue;
    }
    grouped.push(message);
  }
  return grouped;
}

function mergeConsecutiveMessages(
  messages: WireChatMessage[],
): WireChatMessage[] {
  const merged: WireChatMessage[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    const canMerge = previous &&
      previous.role !== "system" &&
      message.role !== "system" &&
      previous.role === message.role &&
      message.metadata?.preserveWireBoundary !== true &&
      (!Array.isArray(previous.toolCalls) || previous.toolCalls.length === 0) &&
      (!Array.isArray(message.toolCalls) || message.toolCalls.length === 0) &&
      !hasNativeReasoning(previous) &&
      !hasNativeReasoning(message);

    if (canMerge) {
      const sameSender = typeof previous.speaker === "string" &&
        previous.speaker === message.speaker;

      merged[merged.length - 1] = {
        ...previous,
        content: mergeMessageContent(previous.content, message.content),
        speaker: sameSender ? previous.speaker : undefined,
        metadata: sameSender ? previous.metadata : undefined,
        reasoning: sameSender ? previous.reasoning : undefined,
        reasoningMaxEstimatedTokens: sameSender
          ? previous.reasoningMaxEstimatedTokens
          : undefined,
        toolCalls: undefined,
      };
      continue;
    }

    merged.push(message);
  }

  return merged;
}

function assertWireMessageInvariants(
  messages: WireChatMessage[],
): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (
      index > 0 &&
      message.role !== "system" &&
      messages[index - 1]?.role === message.role &&
      // Opaque state is bound to one complete assistant turn. It cannot be
      // merged into a neighbor merely to restore role alternation.
      !hasNativeReasoning(messages[index - 1]!) &&
      !hasNativeReasoning(message) &&
      message.metadata?.preserveWireBoundary !== true
    ) {
      throw new LLMTranscriptError(
        `Invalid provider transcript: consecutive ${message.role} turns were not coalesced`,
      );
    }
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
 * Rehydrate a <tool_calls> block from recorded tool calls, if present in message metadata
 */
export function buildToolCallsBlock(toolCalls: ToolInvocation[]): string {
  const objects = toolCalls.flatMap((call) => {
    const stages = call.pipeline?.stages ?? [{
      type: "tool" as const,
      id: call.id,
      tool: call.tool,
      args: call.args,
    }];
    return [
      stages.map((stage) => {
        if (stage.type === "jq") return stringifyWireJson({ jq: stage.filter });
        let args: unknown;
        try {
          args = JSON.parse(stage.args);
        } catch {
          args = stage.args;
        }
        const obj: Record<string, unknown> = {
          name: stage.tool.id,
          arguments: args,
        };
        if (stage.id) obj.tool_call_id = stage.id;
        if (call.planId) obj.tool_plan_id = call.planId;
        return stringifyWireJson(obj);
      }).join(" | "),
    ];
  });

  if (objects.length === 0) return "";
  return ["<tool_calls>", ...objects, `</tool_calls>`].join("\n");
}

export function buildToolResultsBlock(toolResults: ToolInvocation[]): string {
  const objects = toolResults.flatMap((call) => {
    const obj: Record<string, unknown> = {
      name: call.tool.id,
    };
    if (typeof call.output !== "undefined") obj.output = call.output;
    if (call.id) obj.tool_call_id = call.id;
    if (call.planId) obj.tool_plan_id = call.planId;
    if (call.status) obj.status = call.status;
    return [stringifyWireJson(obj)];
  });

  if (objects.length === 0) return "";
  return ["<tool_results>", ...objects, `</tool_results>`].join("\n");
}
