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
import { estimateTextTokens } from "@/runtime/tokens/index.ts";

type StoredAttachment = {
  kind?: string;
  mimeType?: string;
  data?: string;
  dataUrl?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  pages?: number;
  format?: string;
  fileName?: string;
  assetRef?: string;
};

type MessageMetadata = Record<string, unknown> & {
  attachments?: StoredAttachment[];
  senderDisplayName?: string;
  senderExternalId?: string;
  senderParticipantId?: string;
  speakerLabel?: string;
  wireToolFormat?: "peer";
  wireSegment?: "toolResults";
  /** Durable tool_execution node id (preferred for read_tool_result). */
  toolExecutionId?: string;
  /** TOOL_RESULT queue row id (for read_tool_result after history truncation). */
  toolResultQueueEventId?: string;
  routing?: {
    action?: unknown;
    targetId?: unknown;
    source?: unknown;
    message?: unknown;
  };
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
    const tokenMetadata = {
      ...(typeof attachment.width === "number"
        ? { width: attachment.width }
        : {}),
      ...(typeof attachment.height === "number"
        ? { height: attachment.height }
        : {}),
      ...(typeof attachment.durationMs === "number"
        ? { durationSeconds: attachment.durationMs / 1_000 }
        : {}),
      ...(typeof attachment.pages === "number"
        ? { pages: attachment.pages }
        : {}),
    };
    const hasTokenMetadata = Object.keys(tokenMetadata).length > 0;

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
          ...(hasTokenMetadata ? { tokenMetadata } : {}),
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
          ...(hasTokenMetadata ? { tokenMetadata } : {}),
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
        ...(hasTokenMetadata ? { tokenMetadata } : {}),
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
          ...(hasTokenMetadata ? { tokenMetadata } : {}),
        });
        continue;
      }
    }

    if (!dataInfo) {
      continue;
    }

    if (kind === "image") {
      const url = `data:${dataInfo.mimeType};base64,${dataInfo.data}`;
      parts.push({
        type: "image_url",
        image_url: { url },
        ...(hasTokenMetadata ? { tokenMetadata } : {}),
      });
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
        ...(hasTokenMetadata ? { tokenMetadata } : {}),
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
        ...(hasTokenMetadata ? { tokenMetadata } : {}),
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
      ...(hasTokenMetadata ? { tokenMetadata } : {}),
    });
  }

  return parts.length > 0 ? parts : null;
};

/**
 * Options for history generation.
 */
export interface HistoryGeneratorOptions {
  /** Whether this is a simple direct user-agent conversation */
  directConversation?: boolean;
  /**
   * Cap each tool result `output` when building LLM-facing history (estimated
   * tokens of JSON-serialized tool output, including truncation envelope).
   * Default **2_500** is applied by the caller when unset; pass `0` via
   * `createCopilotz({ toolResultHistoryMaxEstimatedTokens: 0 })` to disable it.
   */
  maxToolResultEstimatedTokens?: number;
  /**
   * Controls whether persisted agent reasoning is included in LLM-visible
   * history. Defaults to `{ include: "self", maxEstimatedTokens: 750 }`.
   */
  reasoningHistory?: ReasoningHistoryOptions;
}

const DEFAULT_MAX_TOOL_RESULT_ESTIMATED_TOKENS = 2_500;
const DEFAULT_REASONING_HISTORY_MAX_ESTIMATED_TOKENS = 750;

function normalizeReasoningHistoryOptions(
  options?: ReasoningHistoryOptions,
): Required<ReasoningHistoryOptions> {
  return {
    include: options?.include ?? "self",
    maxEstimatedTokens: typeof options?.maxEstimatedTokens === "number"
      ? options.maxEstimatedTokens
      : DEFAULT_REASONING_HISTORY_MAX_ESTIMATED_TOKENS,
  };
}

function truncateToolOutputForHistory(
  maxEstimatedTokens: number,
  value: unknown,
  references?: {
    toolExecutionId?: string;
    toolResultQueueEventId?: string;
  },
): unknown {
  if (maxEstimatedTokens < 12) {
    return "[tool output truncated]";
  }
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (estimateTextTokens(serialized) <= maxEstimatedTokens) return value;

  const envelope = (preview: string) => ({
    _copilotz_history_truncated: true as const,
    preview,
    originalSerializedLength: serialized.length,
    ...(references?.toolExecutionId
      ? { toolExecutionId: references.toolExecutionId }
      : {}),
    ...(references?.toolResultQueueEventId
      ? { toolResultQueueEventId: references.toolResultQueueEventId }
      : {}),
  });

  let previewLen = Math.max(0, maxEstimatedTokens * 4 - 200);
  while (previewLen > 0) {
    const surrogate = envelope(serialized.slice(0, previewLen));
    if (
      estimateTextTokens(JSON.stringify(surrogate)) <= maxEstimatedTokens
    ) {
      return surrogate;
    }
    previewLen = Math.floor(previewLen * 0.88);
  }
  return envelope("");
}

function applyToolHistoryTokenCap(
  maxToolResultEstimatedTokens: number | undefined,
  invocation: ToolInvocation,
  references?: {
    toolExecutionId?: string;
    toolResultQueueEventId?: string;
  },
): ToolInvocation {
  if (
    maxToolResultEstimatedTokens === undefined ||
    maxToolResultEstimatedTokens <= 0 ||
    !("output" in invocation) ||
    invocation.output === undefined
  ) {
    return invocation;
  }
  return {
    ...invocation,
    output: truncateToolOutputForHistory(
      maxToolResultEstimatedTokens,
      invocation.output,
      references,
    ),
  };
}

type ParsedToolCall = ToolInvocation & {
  visibility?: ToolHistoryVisibility;
};

function sanitizeMetadataForHistory(
  metadata?: MessageMetadata,
): MessageMetadata | undefined {
  if (!metadata) return undefined;
  const {
    toolCalls: _toolCalls,
    routing: _routing,
    speakerLabel: _speakerLabel,
    wireToolFormat: _wireToolFormat,
    wireSegment: _wireSegment,
    ...rest
  } = metadata as MessageMetadata & {
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

function routingContentForAgent(
  agent: Agent,
  visibleContent: string,
  isCurrentAgent: boolean,
  metadata?: MessageMetadata,
): string | null {
  const routing = metadata?.routing;
  if (
    !routing ||
    routing.source !== "model_control" ||
    (routing.action !== "ask" && routing.action !== "handoff") ||
    typeof routing.targetId !== "string" ||
    typeof routing.message !== "string"
  ) {
    return null;
  }

  const targetId = routing.targetId.trim().toLowerCase();
  const matchesTarget = [agent.id, agent.name].some((candidate) =>
    typeof candidate === "string" &&
    candidate.trim().toLowerCase() === targetId
  );
  const message = routing.message.trim();
  if (message.length === 0) return null;
  if (isCurrentAgent) {
    const routingNote =
      `[In-thread ${routing.action} to ${routing.targetId.trim()}]: ${message}`;
    return visibleContent.trim().length > 0
      ? `${visibleContent}\n\n${routingNote}`
      : routingNote;
  }
  return matchesTarget ? message : null;
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

function stripParsedToolCall(
  call: ParsedToolCall,
  options?: { includeVisibility?: boolean },
): ToolInvocation {
  return {
    id: call.id,
    tool: call.tool,
    args: call.args,
    ...("output" in call ? { output: call.output } : {}),
    ...("status" in call && typeof call.status === "string"
      ? { status: call.status }
      : {}),
    ...(call.pipeline ? { pipeline: call.pipeline } : {}),
    ...(options?.includeVisibility && call.visibility
      ? { visibility: call.visibility }
      : {}),
  } as ToolInvocation;
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
  const directConversation = options?.directConversation === true;
  const maxToolResultEstimatedTokens =
    typeof options?.maxToolResultEstimatedTokens === "number"
      ? options.maxToolResultEstimatedTokens
      : DEFAULT_MAX_TOOL_RESULT_ESTIMATED_TOKENS;
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
    const routedContent = !isToolResult
      ? routingContentForAgent(currentAgent, content, isCurrentAgent, metadata)
      : null;
    if (routedContent) {
      content = routedContent;
    }

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
          pipeline?: ToolInvocation["pipeline"];
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
          ...(maybeCall.pipeline ? { pipeline: maybeCall.pipeline } : {}),
          visibility: normalizeToolVisibility(
            maybeCall.visibility ?? toolVisibilityByCallId.get(callId),
          ),
        }];
      })
      : [];

    if (isToolResult && !isRequestingAgent) {
      const visibleToolCalls = parsedToolCalls.flatMap((call) => {
        const visibility = call.visibility ?? "public_status";
        if (visibility === "requester_only") return [];
        return [stripParsedToolCall(call, { includeVisibility: true })];
      });

      if (visibleToolCalls.length === 0) return [];

      const senderName = resolveSpeakerLabel(msg, metadata);
      const safeMetadata = sanitizeMetadataForHistory(metadata);
      return [{
        content,
        role: "user",
        senderId: msg.senderId || undefined,
        toolCalls: visibleToolCalls,
        ...(safeMetadata
          ? {
            metadata: {
              ...safeMetadata,
              wireToolFormat: "peer",
              wireSegment: "toolResults",
              speakerLabel: senderName,
            },
          }
          : {
            metadata: {
              wireToolFormat: "peer",
              wireSegment: "toolResults",
              speakerLabel: senderName,
            },
          }),
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
      if (content.trim().length === 0 && parsedToolCalls.length === 0) {
        if (msg.senderType === "agent") return [];
      }
    }

    const includeReasoning = reasoningHistory.include !== "none" &&
      !isToolResult &&
      typeof msg.reasoning === "string" &&
      (reasoningHistory.include === "all" || isCurrentAgent);
    const reasoning = includeReasoning ? msg.reasoning : undefined;
    const reasoningMaxEstimatedTokens = includeReasoning
      ? reasoningHistory.maxEstimatedTokens
      : undefined;

    const peerSpeakerLabel = !directConversation && !isCurrentAgent &&
        msg.senderType !== "system" && !isToolResult
      ? resolveSpeakerLabel(msg, metadata)
      : undefined;

    if (
      content.trim().length === 0 &&
      !reasoning &&
      parsedToolCalls.length === 0 &&
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
    const toolExecutionId = typeof metadata?.toolExecutionId === "string"
      ? metadata.toolExecutionId
      : undefined;

    let toolCalls: ToolInvocation[] | undefined;
    let hideToolResultContent = false;
    if (isToolResult) {
      const visibleToolCalls = parsedToolCalls.flatMap((call) => {
        const visibility = call.visibility ?? "public_status";

        if (isRequestingAgent || visibility === "public") {
          return [
            applyToolHistoryTokenCap(
              maxToolResultEstimatedTokens,
              stripParsedToolCall(call),
              { toolExecutionId, toolResultQueueEventId },
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
      toolCalls = parsedToolCalls.map((call) => stripParsedToolCall(call));
    } else if (
      peerSpeakerLabel &&
      parsedToolCalls.length > 0 &&
      !isToolResult
    ) {
      toolCalls = parsedToolCalls.flatMap((call) => {
        const visibility = call.visibility ?? "public_status";
        if (visibility === "requester_only") return [];
        return [stripParsedToolCall(call, { includeVisibility: true })];
      });
      if (toolCalls.length === 0) return [];
    }

    const safeMetadata = sanitizeMetadataForHistory(metadata);
    const wireMetadata = {
      ...(safeMetadata ?? {}),
      ...(msg.id ? { sourceMessageId: msg.id } : {}),
      ...(peerSpeakerLabel ? { speakerLabel: peerSpeakerLabel } : {}),
      ...(peerSpeakerLabel && toolCalls
        ? { wireToolFormat: "peer" as const }
        : {}),
      ...(isToolResult && !isRequestingAgent
        ? {
          wireToolFormat: "peer" as const,
          wireSegment: "toolResults" as const,
        }
        : {}),
    };

    return [{
      content: hideToolResultContent ? "" : finalContent,
      role: role,
      senderId: msg.senderId || undefined,
      ...(Object.keys(wireMetadata).length > 0
        ? { metadata: wireMetadata }
        : {}),
      tool_call_id: (msg as unknown as { toolCallId?: string }).toolCallId ||
        undefined,
      ...(reasoning ? { reasoning, reasoningMaxEstimatedTokens } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    }];
  });
}
