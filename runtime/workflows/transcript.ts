import type { ReasoningHistoryOptions } from "../resources/index.ts";
import { bytesToBase64, toDataUrl } from "../content/index.ts";
import type {
  ConversationMessage,
  LlmAttempt,
  ToolExecution,
} from "../domain/index.ts";
import { llmAttemptContent, toolExecutionContent } from "../domain/index.ts";
import type { CopilotzProcessorCapabilities } from "../engine/index.ts";
import type {
  ChatContentPart,
  ChatMessage,
  ToolInvocation,
} from "../llm/types.ts";
import { truncateToolOutputForHistory } from "../tools/history.ts";
import { workflowMetadata } from "./resources.ts";

const DEFAULT_REASONING_HISTORY_MAX_ESTIMATED_TOKENS = 750;
const DEFAULT_TOOL_RESULT_HISTORY_MAX_ESTIMATED_TOKENS = 2_500;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function audioFormat(mediaType: string): string | undefined {
  const subtype = mediaType.split(";")[0]?.split("/")[1]?.trim();
  return subtype || undefined;
}

async function contentParts(
  context: CopilotzProcessorCapabilities,
  message: ConversationMessage,
): Promise<{ content: ChatMessage["content"]; text: string }> {
  const resolved = await context.content.resolveMany(message.content);
  const parts: ChatContentPart[] = [];
  const text: string[] = [];
  for (const item of resolved) {
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

async function attemptToolCalls(
  context: CopilotzProcessorCapabilities,
  attempt: LlmAttempt,
): Promise<readonly ToolInvocation[]> {
  const ref = llmAttemptContent(attempt).toolCalls;
  if (!ref) return Object.freeze([]);
  const resolved = await context.content.resolve(ref);
  const value = resolved.value ?? (() => {
    try {
      return JSON.parse(
        resolved.text ?? new TextDecoder().decode(resolved.bytes),
      );
    } catch {
      return undefined;
    }
  })();
  return Object.freeze(Array.isArray(value) ? value as ToolInvocation[] : []);
}

async function attemptReasoning(
  context: CopilotzProcessorCapabilities,
  attempt: LlmAttempt,
): Promise<string | undefined> {
  const ref = llmAttemptContent(attempt).reasoning;
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

async function resolvedContentValue(
  context: CopilotzProcessorCapabilities,
  ref: ReturnType<typeof toolExecutionContent>["arguments"],
): Promise<unknown> {
  const resolved = await context.content.resolve(ref);
  if (resolved.value !== undefined) return resolved.value;
  const text = resolved.text ?? new TextDecoder().decode(resolved.bytes);
  if (resolved.ref.kind !== "json") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function toolResultInvocation(
  context: CopilotzProcessorCapabilities,
  execution: ToolExecution,
  maxEstimatedTokens: number | undefined,
): Promise<ToolInvocation> {
  const content = toolExecutionContent(execution);
  const workflow = workflowMetadata(execution.metadata);
  const pipelineRoot = workflow?.pipeline?.stages[0];
  const rootTool = pipelineRoot?.type === "tool" ? pipelineRoot : undefined;
  const args = await resolvedContentValue(context, content.arguments);
  const outputRef = content.projectedOutput ?? content.output;
  const output = outputRef
    ? truncateToolOutputForHistory(
      maxEstimatedTokens,
      await resolvedContentValue(context, outputRef),
      { toolExecutionId: execution.id },
    )
    : undefined;
  const status = workflow?.pipelineFailure
    ? "failed"
    : execution.status === "running"
    ? "processing"
    : execution.status === "cancelled"
    ? "failed"
    : execution.status;
  return {
    id: workflow?.pipeline?.rootToolCallId ?? execution.toolCallId,
    tool: {
      id: rootTool?.tool.id ?? String(execution.tool.id),
      ...((rootTool?.tool.name ?? execution.tool.name)
        ? { name: String(rootTool?.tool.name ?? execution.tool.name) }
        : {}),
    },
    args: rootTool?.args ??
      (typeof args === "string" ? args : JSON.stringify(args ?? {})),
    ...(output !== undefined ? { output } : {}),
    status,
  };
}

async function toChatMessage(
  context: CopilotzProcessorCapabilities,
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
    const attempt = metadata?.llmAttemptId
      ? await context.llmAttempts.get(metadata.llmAttemptId)
      : null;
    const toolCalls = attempt ? await attemptToolCalls(context, attempt) : [];
    const policy = reasoningPolicy(options.reasoningHistory);
    const includeReasoning = policy.include !== "none" && attempt &&
      (policy.include === "all" ||
        attempt.participantId === targetParticipantId);
    const reasoning = includeReasoning
      ? await attemptReasoning(context, attempt)
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
    const execution = metadata?.toolExecutionId
      ? await context.toolExecutions.get(metadata.toolExecutionId)
      : null;
    const invocation = execution
      ? await toolResultInvocation(
        context,
        execution,
        options.maxToolResultEstimatedTokens ??
          DEFAULT_TOOL_RESULT_HISTORY_MAX_ESTIMATED_TOKENS,
      )
      : null;
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
      ...(metadata?.toolCallId ? { tool_call_id: metadata.toolCallId } : {}),
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
  context: CopilotzProcessorCapabilities,
  input: Readonly<{
    threadId: string;
    messageIds?: readonly string[];
    participantId?: string;
    reasoningHistory?: ReasoningHistoryOptions;
    maxToolResultEstimatedTokens?: number;
  }>,
): Promise<ChatMessage[]> {
  const thread = await context.conversation.getThread(input.threadId);
  if (!thread) throw new Error(`Thread '${input.threadId}' was not found.`);
  const agentParticipants = thread.participants.filter((participant) =>
    participant.participantType === "agent"
  );
  const labelPeers = thread.participants.length > 2 ||
    agentParticipants.length > 1;
  const history = await context.conversation.listMessages(input.threadId, {
    limit: 1_000,
  });
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
