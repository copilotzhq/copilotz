import type { ReasoningHistoryOptions } from "../resources/index.ts";
import { bytesToBase64, formatAssetRef, toDataUrl } from "../content/index.ts";
import type { ContentRef } from "../content/index.ts";
import type { ConversationMessage } from "../domain/index.ts";
import type { ProcessorContext } from "../plugins/index.ts";
import {
  listThreadMessageRecords,
  loadThreadRecord,
} from "../engine/collection-graph.ts";
import type {
  ChatContentPart,
  ChatMessage,
  ToolInvocation,
} from "../llm/types.ts";
import { workflowMetadata } from "../events/workflow-metadata.ts";

const DEFAULT_REASONING_HISTORY_MAX_ESTIMATED_TOKENS = 750;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function audioFormat(mediaType: string): string | undefined {
  const subtype = mediaType.split(";")[0]?.split("/")[1]?.trim();
  return subtype || undefined;
}

function attachmentDescriptor(message: ConversationMessage, ref: ContentRef) {
  const identity = {
    assetId: ref.assetId,
    assetRef: formatAssetRef(message.namespace, ref.assetId),
    kind: ref.kind,
    mediaType: ref.mediaType,
    ...(ref.name ? { name: ref.name } : {}),
  };
  return `[Copilotz attachment: ${
    JSON.stringify(identity)
  }. Use assetId or assetRef with asset tools.]`;
}

async function contentParts(
  context: ProcessorContext,
  message: ConversationMessage,
): Promise<{ content: ChatMessage["content"]; text: string }> {
  const resolved = await context.content.resolveMany(message.content);
  const parts: ChatContentPart[] = [];
  const text: string[] = [];
  for (const item of resolved) {
    if (item.ref.role === "attachment") {
      parts.push({
        type: "text",
        text: attachmentDescriptor(message, item.ref),
      });
    }
    if (item.ref.kind === "text") {
      const value = item.text ?? new TextDecoder().decode(item.bytes);
      text.push(value);
      parts.push({ type: "text", text: value });
      continue;
    }
    if (item.ref.kind === "json") {
      const value = item.value === undefined
        ? item.text ?? new TextDecoder().decode(item.bytes)
        : JSON.stringify(item.value);
      text.push(value);
      parts.push({ type: "text", text: value });
      continue;
    }
    const url = toDataUrl(item.bytes, item.ref.mediaType);
    if (item.ref.kind === "image") {
      parts.push({ type: "image_url", image_url: { url } });
    } else if (item.ref.kind === "audio") {
      parts.push({
        type: "input_audio",
        input_audio: {
          data: bytesToBase64(item.bytes),
          format: audioFormat(item.ref.mediaType),
          ...(item.ref.name ? { filename: item.ref.name } : {}),
        },
      });
    } else if (item.ref.kind === "video") {
      parts.push({
        type: "video",
        video: { url, mime_type: item.ref.mediaType },
      });
    } else {
      parts.push({
        type: "file",
        file: {
          file_data: url,
          mime_type: item.ref.mediaType,
          ...(item.ref.name ? { filename: item.ref.name } : {}),
        },
      });
    }
  }
  const content = parts.length === 1 && parts[0].type === "text"
    ? parts[0].text
    : parts;
  return { content, text: text.join("\n") };
}

async function messageReasoning(
  context: ProcessorContext,
  message: ConversationMessage,
): Promise<string | undefined> {
  const refs = Array.isArray(message.metadata.llmReasoning)
    ? message.metadata.llmReasoning as readonly ContentRef[]
    : [];
  const ref = refs[0];
  if (!ref) return undefined;
  const resolved = await context.content.resolve(ref);
  const value = resolved.text ?? new TextDecoder().decode(resolved.bytes);
  return value || undefined;
}

function reasoningPolicy(
  options: ReasoningHistoryOptions | undefined,
): Required<ReasoningHistoryOptions> {
  return {
    include: options?.include ?? "self",
    maxEstimatedTokens: options?.maxEstimatedTokens ??
      DEFAULT_REASONING_HISTORY_MAX_ESTIMATED_TOKENS,
  };
}

function speakerMetadata(
  message: ConversationMessage,
  enabled: boolean,
): Record<string, unknown> {
  return {
    ...structuredClone(message.metadata),
    ...(enabled
      ? { speakerLabel: message.sender.name ?? message.sender.externalId }
      : {}),
  };
}

async function toChatMessage(
  context: ProcessorContext,
  message: ConversationMessage,
  targetParticipantId?: string,
  options: Readonly<{
    labelPeers: boolean;
    reasoningHistory?: ReasoningHistoryOptions;
    maxToolResultEstimatedTokens?: number;
  }> = { labelPeers: false },
): Promise<ChatMessage | null> {
  const body = await contentParts(context, message);
  const metadata = workflowMetadata(message.metadata);
  if (message.sender.participantType === "agent") {
    const isCurrentParticipant = !targetParticipantId ||
      message.sender.id === targetParticipantId;
    if (!isCurrentParticipant) {
      return {
        role: "user",
        content: body.content,
        senderId: message.sender.id,
        metadata: speakerMetadata(message, options.labelPeers),
      };
    }
    const embeddedToolCalls = Array.isArray(message.metadata.llmToolCalls)
      ? message.metadata.llmToolCalls as readonly ToolInvocation[]
      : [];
    const toolCalls = embeddedToolCalls;
    const policy = reasoningPolicy(options.reasoningHistory);
    const includeReasoning = policy.include !== "none" &&
      (policy.include === "all" ||
        message.sender.id === targetParticipantId);
    const reasoning = includeReasoning
      ? await messageReasoning(context, message)
      : undefined;
    return {
      role: "assistant",
      content: body.content,
      senderId: message.sender.id,
      metadata: structuredClone(message.metadata),
      ...(toolCalls.length ? { toolCalls: [...toolCalls] } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(reasoning
        ? { reasoningMaxEstimatedTokens: policy.maxEstimatedTokens }
        : {}),
    };
  }
  if (message.sender.participantType === "tool") {
    const fields = record(message.metadata);
    const requesterId = typeof fields.requesterId === "string"
      ? fields.requesterId
      : metadata?.agentParticipantId;
    const visibility = fields.historyVisibility;
    if (
      visibility === "requester_only" && requesterId !== targetParticipantId
    ) {
      return null;
    }
    if (visibility === "public_status" && requesterId !== targetParticipantId) {
      const toolId = typeof fields.toolId === "string" ? fields.toolId : "tool";
      const status = typeof fields.toolStatus === "string"
        ? fields.toolStatus
        : "settled";
      return {
        role: "user",
        content: `[${toolId} ${status}]`,
        senderId: message.sender.id,
        metadata: speakerMetadata(message, options.labelPeers),
      };
    }
    const embedded = record(fields.toolInvocation);
    const embeddedTool = record(embedded.tool);
    const embeddedInvocation: ToolInvocation | null =
      typeof embedded.id === "string" && typeof embeddedTool.id === "string"
        ? {
          id: embedded.id,
          tool: {
            id: embeddedTool.id,
            ...(typeof embeddedTool.name === "string"
              ? { name: embeddedTool.name }
              : {}),
          },
          args: typeof embedded.args === "string"
            ? embedded.args
            : JSON.stringify(embedded.args ?? {}),
          output: body.text,
          status: typeof fields.toolStatus === "string"
            ? fields.toolStatus as ToolInvocation["status"]
            : "completed",
        }
        : null;
    const invocation = embeddedInvocation;
    const isRequester = requesterId === targetParticipantId;
    return {
      role: isRequester ? "tool" : "user",
      content: body.content,
      senderId: message.sender.id,
      metadata: {
        ...speakerMetadata(message, !isRequester && options.labelPeers),
        ...(!isRequester && invocation
          ? { wireToolFormat: "peer", wireSegment: "toolResults" }
          : {}),
      },
      ...(invocation ? { toolCalls: [invocation] } : {}),
      ...(metadata?.toolCallId ?? embeddedInvocation?.id
        ? { tool_call_id: metadata?.toolCallId ?? embeddedInvocation!.id }
        : {}),
    };
  }
  return {
    role: "user",
    content: body.content,
    senderId: message.sender.id,
    metadata: speakerMetadata(message, options.labelPeers),
  };
}

/** Compiles immutable graph messages and their canonical assets for one call. */
export async function buildTextTranscript(
  context: ProcessorContext,
  input: Readonly<{
    threadId: string;
    messageIds?: readonly string[];
    participantId?: string;
    reasoningHistory?: ReasoningHistoryOptions;
    maxToolResultEstimatedTokens?: number;
  }>,
): Promise<ChatMessage[]> {
  const thread = await loadThreadRecord(context, input.threadId);
  if (!thread) throw new Error(`Thread '${input.threadId}' was not found.`);
  const agentParticipants = thread.participants.filter((participant) =>
    participant.participantType === "agent"
  );
  const labelPeers = thread.participants.length > 2 ||
    agentParticipants.length > 1;
  const history = await listThreadMessageRecords(context, input.threadId);
  const selected = input.messageIds?.length
    ? (() => {
      const byId = new Map(history.map((message) => [message.id, message]));
      return input.messageIds.map((id) => {
        const message = byId.get(id);
        if (!message) {
          throw new Error(
            `LLM input message '${id}' was not found in thread '${input.threadId}'.`,
          );
        }
        return message;
      });
    })()
    : history;
  const compiled = await Promise.all(
    selected.map((message) =>
      toChatMessage(context, message, input.participantId, {
        labelPeers,
        reasoningHistory: input.reasoningHistory,
        maxToolResultEstimatedTokens: input.maxToolResultEstimatedTokens,
      })
    ),
  );
  return compiled.filter((message): message is ChatMessage => message !== null);
}
