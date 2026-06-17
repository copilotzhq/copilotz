import type {
  Agent,
  NewMessage,
  ReasoningHistoryOptions,
  ToolHistoryVisibility,
} from "@/types/index.ts";
import type {
  ChatContentPart,
  ChatMessage,
  ToolInvocation,
} from "@/runtime/llm/types.ts";
import { extractAssetId, isAssetRef } from "@/runtime/storage/assets.ts";

type StoredAttachment = {
  kind?: string;
  mimeType?: string;
  data?: string;
  dataUrl?: string;
  durationMs?: number;
  format?: string;
  fileName?: string;
  assetRef?: string;
};

type MessageMetadata = Record<string, unknown> & {
  attachments?: StoredAttachment[];
  routing?: {
    routeTo?: string[];
  };
  senderDisplayName?: string;
  senderExternalId?: string;
  senderParticipantId?: string;
  /** TOOL_RESULT queue row id (for read_tool_result after history truncation). */
  toolResultQueueEventId?: string;
};

const toDataUrl = (
  attachment: StoredAttachment,
): { data: string; mimeType: string } | null => {
  const mimeType =
    typeof attachment.mimeType === "string" && attachment.mimeType.length > 0
      ? attachment.mimeType
      : "application/octet-stream";

  if (typeof attachment.data === "string" && attachment.data.length > 0) {
    return { data: attachment.data, mimeType };
  }

  if (
    typeof attachment.dataUrl === "string" &&
    attachment.dataUrl.startsWith("data:")
  ) {
    const [, metaAndData] = attachment.dataUrl.split("data:");
    if (!metaAndData) return null;
    const [metaPart, base64Part] = metaAndData.split(",");
    if (!base64Part) return null;
    const extractedMime = metaPart?.split(";")[0] ?? mimeType;
    return { data: base64Part, mimeType: extractedMime };
  }

  return null;
};

const buildAttachmentParts = (
  metadata?: MessageMetadata,
): ChatContentPart[] | null => {
  const attachments = metadata?.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return null;
  }

  const parts: ChatContentPart[] = [];

  for (const attachment of attachments) {
    const kind = typeof attachment.kind === "string"
      ? attachment.kind
      : undefined;
    const dataInfo = toDataUrl(attachment);

    // Prefer assetRef if provided; resolved later in LLM_CALL
    // Add asset ID as text so the agent can reference it in tool calls or conversation
    if (
      typeof attachment.assetRef === "string" && isAssetRef(attachment.assetRef)
    ) {
      const assetId = extractAssetId(attachment.assetRef);
      // Add text marker with asset ID for agent reference
      parts.push({
        type: "text",
        text: `[Attached ${kind || "file"}: asset_id="${assetId}"]`,
      });

      if (kind === "image") {
        parts.push({
          type: "image_url",
          image_url: { url: attachment.assetRef },
        });
        continue;
      }
      if (kind === "audio") {
        const format = typeof attachment.format === "string"
          ? attachment.format
          : undefined;
        parts.push({
          type: "input_audio",
          input_audio: {
            data: attachment.assetRef,
            ...(format ? { format } : {}),
          },
        });
        continue;
      }
      // file or video -> treat as file
      parts.push({
        type: "file",
        file: {
          file_data: attachment.assetRef,
          mime_type: typeof attachment.mimeType === "string"
            ? attachment.mimeType
            : undefined,
        },
      });
      continue;
    }

    if (
      typeof attachment.dataUrl === "string" &&
      /^https?:\/\//.test(attachment.dataUrl)
    ) {
      if (kind === "image") {
        parts.push({
          type: "image_url",
          image_url: { url: attachment.dataUrl },
        });
        continue;
      }
    }

    if (!dataInfo) {
      continue;
    }

    if (kind === "image") {
      const url = `data:${dataInfo.mimeType};base64,${dataInfo.data}`;
      parts.push({ type: "image_url", image_url: { url } });
      continue;
    }

    if (kind === "audio") {
      const formatFromMime = dataInfo.mimeType.includes("/")
        ? dataInfo.mimeType.split("/")[1]
        : undefined;
      const format =
        typeof attachment.format === "string" && attachment.format.length > 0
          ? attachment.format
          : formatFromMime;
      parts.push({
        type: "input_audio",
        input_audio: {
          data: dataInfo.data,
          ...(format ? { format } : {}),
        },
      });
      continue;
    }

    if (kind === "video" || kind === "file") {
      const file_data = `data:${dataInfo.mimeType};base64,${dataInfo.data}`;
      parts.push({
        type: "file",
        file: {
          file_data,
          mime_type: dataInfo.mimeType,
        },
      });
      continue;
    }

    // Default fallback: treat as file
    const fallback = `data:${dataInfo.mimeType};base64,${dataInfo.data}`;
    parts.push({
      type: "file",
      file: {
        file_data: fallback,
        mime_type: dataInfo.mimeType,
      },
    });
  }

  return parts.length > 0 ? parts : null;
};

/**
 * Options for history generation.
 */
export interface HistoryGeneratorOptions {
  /** Whether to include target info in message context */
  includeTargetContext?: boolean;
  /** Whether this is a simple direct user-agent conversation */
  directConversation?: boolean;
  /**
   * Cap each tool result `output` when building LLM-facing history (characters
   * of JSON-serialized tool output, including truncation envelope).
   * Default **10_000** is applied by the caller when unset; pass `0` via
   * `createCopilotz({ toolResultHistoryMaxChars: 0 })` to disable per-result caps.
   */
  maxToolResultChars?: number;
  /**
   * Controls whether persisted agent reasoning is included in LLM-visible
   * history. Defaults to `{ include: "self", maxChars: 2000 }`.
   */
  reasoningHistory?: ReasoningHistoryOptions;
}

const DEFAULT_MAX_TOOL_RESULT_CHARS = 10_000;
const DEFAULT_REASONING_HISTORY_MAX_CHARS = 2_000;

function normalizeReasoningHistoryOptions(
  options?: ReasoningHistoryOptions,
): Required<ReasoningHistoryOptions> {
  return {
    include: options?.include ?? "self",
    maxChars: typeof options?.maxChars === "number"
      ? options.maxChars
      : DEFAULT_REASONING_HISTORY_MAX_CHARS,
  };
}

function truncateReasoningForHistory(
  reasoning: string,
  maxChars: number,
): string {
  if (maxChars === 0 || reasoning.length <= maxChars) return reasoning;
  if (maxChars < 48) return "[reasoning truncated]";
  const suffix = `\n[reasoning truncated: ${
    reasoning.length - maxChars
  } chars omitted]`;
  return `${
    reasoning.slice(0, Math.max(0, maxChars - suffix.length))
  }${suffix}`;
}

function appendReasoningForHistory(
  content: string,
  reasoning: string,
  maxChars: number,
): string {
  const trimmed = reasoning.trim();
  if (!trimmed) return content;
  const capped = truncateReasoningForHistory(trimmed, maxChars);
  const block = `<think>\n${capped}\n</think>`;
  return content ? `${block}\n\n${content}` : block;
}

function truncateToolOutputForHistory(
  maxChars: number,
  value: unknown,
  toolResultQueueEventId?: string,
): unknown {
  if (maxChars < 48) {
    return "[tool output truncated]";
  }
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= maxChars) return value;

  const envelope = (preview: string) => ({
    _copilotz_history_truncated: true as const,
    preview,
    originalSerializedLength: serialized.length,
    ...(toolResultQueueEventId ? { toolResultQueueEventId } : {}),
  });

  let previewLen = Math.max(0, maxChars - 200);
  while (previewLen > 0) {
    const surrogate = envelope(serialized.slice(0, previewLen));
    if (JSON.stringify(surrogate).length <= maxChars) return surrogate;
    previewLen = Math.floor(previewLen * 0.88);
  }
  return envelope("");
}

function applyToolHistoryCharCap(
  maxToolResultChars: number | undefined,
  invocation: ToolInvocation,
  toolResultQueueEventId?: string,
): ToolInvocation {
  if (
    maxToolResultChars === undefined ||
    maxToolResultChars <= 0 ||
    !("output" in invocation) ||
    invocation.output === undefined
  ) {
    return invocation;
  }
  return {
    ...invocation,
    output: truncateToolOutputForHistory(
      maxToolResultChars,
      invocation.output,
      toolResultQueueEventId,
    ),
  };
}

/**
 * Resolve a target ID to a display name.
 */
function resolveTargetName(
  targetId: string | null | undefined,
  _metadata?: MessageMetadata,
): string {
  if (!targetId) return "unknown";
  return targetId;
}

type ParsedToolCall = ToolInvocation & {
  visibility?: ToolHistoryVisibility;
};

const OMITTED_TOOL_VALUE = {
  _copilotz_omitted: true,
  reason: "public_status",
} as const;

function sanitizeMetadataForHistory(
  metadata?: MessageMetadata,
): MessageMetadata | undefined {
  if (!metadata) return undefined;
  const { toolCalls: _toolCalls, ...rest } = metadata as MessageMetadata & {
    toolCalls?: unknown;
  };
  return Object.keys(rest).length > 0 ? rest as MessageMetadata : undefined;
}

function normalizeToolVisibility(
  visibility: unknown,
): ToolHistoryVisibility {
  return visibility === "requester_only" || visibility === "public"
    ? visibility
    : "public_status";
}

function normalizeVisibleContent(content: string): string {
  return content
    .replace(/<span\b[^>]*>\s*<\/span>/gi, "")
    .trim();
}

function prefixSpeakerContent(speaker: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return `[${speaker}]:`;
  if (trimmed.startsWith("<tool_") || trimmed.includes("\n")) {
    return `[${speaker}]:\n${trimmed}`;
  }
  return `[${speaker}]: ${trimmed}`;
}

function parseToolArgs(args: ToolInvocation["args"]): unknown {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function buildPeerToolCallsBlock(toolCalls: ParsedToolCall[]): string | null {
  const objects = toolCalls.flatMap((call) => {
    const visibility = normalizeToolVisibility(call.visibility);
    if (visibility === "requester_only") return [];
    const obj: Record<string, unknown> = {
      name: call.tool.id,
      status: call.status ?? "requested",
      arguments: visibility === "public"
        ? parseToolArgs(call.args)
        : OMITTED_TOOL_VALUE,
    };
    if (call.id) obj.tool_call_id = call.id;
    return [JSON.stringify(obj)];
  });

  return objects.length > 0
    ? ["<tool_calls>", ...objects, "</tool_calls>"].join("\n")
    : null;
}

function buildPeerToolResultsBlock(toolCalls: ParsedToolCall[]): string | null {
  const objects = toolCalls.flatMap((call) => {
    const visibility = normalizeToolVisibility(call.visibility);
    if (visibility === "requester_only") return [];
    const obj: Record<string, unknown> = {
      name: call.tool.id,
      status: call.status ?? "completed",
      output: visibility === "public"
        ? ("output" in call ? call.output : null)
        : OMITTED_TOOL_VALUE,
    };
    if (call.id) obj.tool_call_id = call.id;
    return [JSON.stringify(obj)];
  });

  return objects.length > 0
    ? ["<tool_results>", ...objects, "</tool_results>"].join("\n")
    : null;
}

function collectToolVisibilityByCallId(
  chatHistory: NewMessage[],
): Map<string, ToolHistoryVisibility> {
  const visibilityByCallId = new Map<string, ToolHistoryVisibility>();

  for (const msg of chatHistory) {
    if (msg.senderType !== "tool") continue;
    const metadata = (msg.metadata ?? undefined) as MessageMetadata | undefined;
    const toolCalls = Array.isArray(metadata?.toolCalls)
      ? metadata.toolCalls
      : [];
    for (const call of toolCalls) {
      if (!call || typeof call !== "object") continue;
      const maybeCall = call as { id?: unknown; visibility?: unknown };
      if (typeof maybeCall.id !== "string" || maybeCall.id.length === 0) {
        continue;
      }
      visibilityByCallId.set(
        maybeCall.id,
        normalizeToolVisibility(maybeCall.visibility),
      );
    }
  }

  return visibilityByCallId;
}

function matchesAgentIdentity(
  agent: Agent,
  senderId: string | null | undefined,
  metadata?: MessageMetadata,
): boolean {
  const candidates = [
    senderId,
    metadata?.senderExternalId,
    metadata?.senderDisplayName,
  ].filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0
  );

  return candidates.some((candidate) =>
    candidate === agent.id || candidate === agent.name
  );
}

function resolveSpeakerLabel(
  msg: NewMessage,
  metadata?: MessageMetadata,
): string {
  const candidates = [
    metadata?.senderDisplayName,
    metadata?.senderExternalId,
    msg.senderId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return "unknown";
}

function stripParsedToolCall(call: ParsedToolCall): ToolInvocation {
  return {
    id: call.id,
    tool: call.tool,
    args: call.args,
    ...("output" in call ? { output: call.output } : {}),
    ...("status" in call && typeof call.status === "string"
      ? { status: call.status }
      : {}),
  };
}

function toPublicStatusToolCall(call: ParsedToolCall): ToolInvocation {
  return {
    id: call.id,
    tool: call.tool,
    args: "{}",
    ...("status" in call && typeof call.status === "string"
      ? { status: call.status }
      : {}),
  };
}

export function historyGenerator(
  chatHistory: NewMessage[],
  currentAgent: Agent,
  options?: HistoryGeneratorOptions,
): ChatMessage[] {
  const includeTargetContext = options?.includeTargetContext ?? true;
  const directConversation = options?.directConversation === true;
  const maxToolResultChars = typeof options?.maxToolResultChars === "number"
    ? options.maxToolResultChars
    : DEFAULT_MAX_TOOL_RESULT_CHARS;
  const reasoningHistory = normalizeReasoningHistoryOptions(
    options?.reasoningHistory,
  );
  const toolVisibilityByCallId = collectToolVisibilityByCallId(chatHistory);

  return chatHistory.flatMap((msg, _i): ChatMessage[] => {
    // Current agent's messages = "assistant"
    // Tool results = "tool" (even if senderId matches agent, because senderType is "tool")
    // Everyone else (users + other agents) = "user" with [Name]: prefix

    // IMPORTANT: Check senderType FIRST to correctly identify tool results
    // Tool results have senderId set to the requesting agent's ID, but senderType is "tool"
    const isToolResult = msg.senderType === "tool";
    const metadata = (msg.metadata ?? undefined) as MessageMetadata | undefined;
    const isRequestingAgent = matchesAgentIdentity(
      currentAgent,
      msg.senderId,
      metadata,
    );
    const isCurrentAgent = !isToolResult && isRequestingAgent;

    // Determine role: tool results stay as "tool", agent messages as "assistant", others based on type
    const role = isToolResult
      ? "tool"
      : isCurrentAgent
      ? "assistant"
      : (msg.senderType === "agent" || msg.senderType === "job"
        ? "user"
        : msg.senderType);

    const rawToolCalls = (msg as unknown as { toolCalls?: unknown }).toolCalls;
    const rawToolCallsArray = Array.isArray(rawToolCalls) ? rawToolCalls : [];
    const metadataToolCalls = Array.isArray(metadata?.toolCalls)
      ? metadata.toolCalls
      : [];
    const hasStructuredToolResult = rawToolCallsArray.length > 0 ||
      metadataToolCalls.length > 0;

    let content = normalizeVisibleContent(msg.content || "");

    // Prefer persisted tool-result metadata for tool result messages. For
    // agent messages, top-level toolCalls are the model-requested calls.
    const toolCallsSource = isToolResult
      ? metadataToolCalls
      : rawToolCallsArray.length > 0
      ? rawToolCallsArray
      : metadataToolCalls;
    const parsedToolCalls: ParsedToolCall[] = toolCallsSource.length > 0
      ? toolCallsSource.flatMap((call, i): ParsedToolCall[] => {
        const maybeCall = call as {
          id?: string | null;
          tool?: { id?: string; name?: string };
          name?: string;
          args?: Record<string, unknown> | string;
          output?: unknown;
          status?: ToolInvocation["status"];
          visibility?: ToolHistoryVisibility;
        };

        const toolId = maybeCall.tool?.id ?? maybeCall.name ?? "";
        if (!toolId) return [];

        const callId =
          typeof maybeCall.id === "string" && maybeCall.id.length > 0
            ? maybeCall.id
            : (() => {
              return `${toolId}_${i}`;
            })();

        let toolArgs = "{}";
        try {
          const rawArgs = maybeCall.args;
          toolArgs = typeof rawArgs === "string"
            ? rawArgs
            : JSON.stringify(rawArgs ?? {});
        } catch (_err) {
          toolArgs = "{}";
        }

        return [{
          id: callId,
          tool: {
            id: toolId,
          },
          args: toolArgs,
          ...("output" in maybeCall && typeof maybeCall.output !== "undefined"
            ? { output: maybeCall.output }
            : {}),
          ...("status" in maybeCall && typeof maybeCall.status === "string"
            ? { status: maybeCall.status }
            : {}),
          visibility: normalizeToolVisibility(
            maybeCall.visibility ?? toolVisibilityByCallId.get(callId),
          ),
        }];
      })
      : [];

    if (isToolResult && !isRequestingAgent) {
      const toolResultsBlock = buildPeerToolResultsBlock(parsedToolCalls);
      const parts = [content, toolResultsBlock].filter((
        part,
      ): part is string => typeof part === "string" && part.trim().length > 0);
      if (parts.length === 0) return [];

      const senderName = resolveSpeakerLabel(msg, metadata);
      const safeMetadata = sanitizeMetadataForHistory(metadata);
      return [{
        content: prefixSpeakerContent(senderName, parts.join("\n")),
        role: "user",
        senderId: msg.senderId || undefined,
        ...(safeMetadata ? { metadata: safeMetadata } : {}),
      }];
    }

    // Prefix with sender name for non-current-agent messages.
    // Structured tool results are rendered later in the formatter, so keep
    // their raw content untouched here unless we have no structured metadata.
    if (
      isToolResult && !hasStructuredToolResult && msg.senderType !== "system"
    ) {
      content = `[Tool Result]: ${content}`;
    } else if (
      !directConversation && !isCurrentAgent && msg.senderType !== "system" &&
      !isToolResult
    ) {
      const senderName = resolveSpeakerLabel(msg, metadata);
      const peerToolCallsBlock = parsedToolCalls.length > 0
        ? buildPeerToolCallsBlock(parsedToolCalls)
        : null;
      const parts = [content, peerToolCallsBlock].filter((
        part,
      ): part is string => typeof part === "string" && part.trim().length > 0);
      if (parts.length === 0 && msg.senderType === "agent") return [];
      content = prefixSpeakerContent(senderName, parts.join("\n"));
    }

    // Include target info for context (who they were addressing)
    // This helps agents understand the conversation flow in multi-agent scenarios
    if (includeTargetContext && !isCurrentAgent && !isToolResult) {
      const msgWithTarget = msg as NewMessage & { targetId?: string | null };
      if (msgWithTarget.targetId) {
        const targetName = resolveTargetName(msgWithTarget.targetId, metadata);
        // Only add if it's meaningful context
        if (
          targetName !== currentAgent.name && targetName !== currentAgent.id
        ) {
          content = `${content}\n(addressed to: ${targetName})`;
        }
      }
    }

    if (
      reasoningHistory.include !== "none" &&
      !isToolResult &&
      typeof msg.reasoning === "string" &&
      (reasoningHistory.include === "all" || isCurrentAgent)
    ) {
      content = appendReasoningForHistory(
        content,
        msg.reasoning,
        reasoningHistory.maxChars,
      );
    }

    if (
      content.trim().length === 0 &&
      msg.senderType === "agent" &&
      !isCurrentAgent
    ) {
      return [];
    }

    const attachmentParts = buildAttachmentParts(metadata);
    const finalContent: string | ChatContentPart[] = attachmentParts
      ? [{ type: "text", text: content }, ...attachmentParts]
      : content;

    const toolResultQueueEventId =
      typeof metadata?.toolResultQueueEventId === "string"
        ? metadata.toolResultQueueEventId
        : undefined;

    let toolCalls: ToolInvocation[] | undefined;
    let hideToolResultContent = false;
    if (isToolResult) {
      const visibleToolCalls = parsedToolCalls.flatMap((call) => {
        const visibility = call.visibility ?? "public_status";

        if (isRequestingAgent || visibility === "public") {
          return [
            applyToolHistoryCharCap(
              maxToolResultChars,
              stripParsedToolCall(call),
              toolResultQueueEventId,
            ),
          ];
        }

        if (visibility === "public_status") {
          hideToolResultContent = true;
          return [toPublicStatusToolCall(call)];
        }

        return [];
      });

      if (visibleToolCalls.length === 0) {
        return [];
      }

      toolCalls = visibleToolCalls;
    } else if (role === "assistant" && parsedToolCalls.length > 0) {
      toolCalls = parsedToolCalls.map(stripParsedToolCall);
    }

    const safeMetadata = sanitizeMetadataForHistory(metadata);

    return [{
      content: hideToolResultContent ? "" : finalContent,
      role: role,
      senderId: msg.senderId || undefined,
      ...(safeMetadata ? { metadata: safeMetadata } : {}),
      tool_call_id: (msg as unknown as { toolCallId?: string }).toolCallId ||
        undefined,
      ...(toolCalls ? { toolCalls } : {}),
    }];
  });
}
