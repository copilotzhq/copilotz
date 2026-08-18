import type { Participant, ParticipantInput } from "../domain/index.ts";
import { toolExecutionContent } from "../domain/index.ts";
import type { CopilotzProcessorCapabilities } from "../engine/index.ts";
import {
  loadMessageRecord,
  loadThreadRecord,
  loadToolExecutionRecord,
} from "../engine/collection-graph.ts";
import {
  createMessageRecord,
  createToolExecutionCollection,
} from "../engine/collection-writes.ts";
import { withWorkflowMetadata } from "../events/workflow-metadata.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";
import type { DurableEvent } from "../events/index.ts";
import type {
  RealtimeAgentAskInput,
  RealtimeAgentAskResult,
  RealtimeContextMessageInput,
  RealtimeContextMessageResult,
  RealtimeProviderContext,
  RealtimeProviderContextBase,
  RealtimeToolCallInput,
  RealtimeToolCallResult,
} from "./types.ts";

export type CreateRealtimeProviderContextOptions = Readonly<{
  capabilities: CopilotzProcessorCapabilities;
  base: RealtimeProviderContextBase;
}>;

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

function timeout(value: number | undefined): number {
  const resolved = value ?? 120_000;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError("Realtime operation timeout must be positive.");
  }
  return resolved;
}

function participantInput(participant: Participant): ParticipantInput {
  return {
    id: participant.id,
    externalId: participant.externalId,
    participantType: participant.participantType,
    ...(participant.name ? { name: participant.name } : {}),
    ...(participant.email ? { email: participant.email } : {}),
    ...(participant.agentId ? { agentId: participant.agentId } : {}),
    metadata: structuredClone(participant.metadata),
  };
}

function participantMatches(participant: Participant, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return participant.id.toLowerCase() === normalized ||
    participant.externalId.toLowerCase() === normalized ||
    participant.agentId?.toLowerCase() === normalized;
}

function resolveParticipant(
  participants: readonly Participant[],
  value: string,
  name: string,
): Participant {
  const matches = participants.filter((participant) =>
    participantMatches(participant, value)
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `${name} '${value}' is ambiguous; use its participant ID.`
        : `${name} '${value}' is not a participant in this thread.`,
    );
  }
  return matches[0];
}

function resolvedValue(value: { value?: unknown; text?: string }): unknown {
  return value.value !== undefined ? value.value : value.text;
}

async function requireDurableEvent(
  capabilities: CopilotzProcessorCapabilities,
  input: Readonly<{
    threadId: string;
    types: readonly string[];
    subject: { type: string; id: string };
    timeoutMs?: number;
  }>,
): Promise<DurableEvent> {
  const event = await capabilities.events.waitFor({
    threadId: input.threadId,
    types: [...input.types],
    subject: input.subject,
    timeoutMs: input.timeoutMs,
  });
  if (!event.durable) {
    throw new Error(`Realtime event '${input.types.join(",")}' was not durable.`);
  }
  return event;
}

/** Adds semantic messages, tools, and public asks to one realtime worker scope. */
export function createRealtimeProviderContext(
  options: CreateRealtimeProviderContextOptions,
): RealtimeProviderContext {
  const { capabilities, base } = options;
  const metadata = base.metadata;
  let sequence = 0;
  const nextKey = (kind: string): string => `${kind}:${++sequence}`;

  const participants = async () => {
    const thread = await loadThreadRecord(capabilities, metadata.threadId);
    if (!thread) {
      throw new Error(`Thread '${metadata.threadId}' was not found.`);
    }
    return thread.participants;
  };

  const send = async (
    input: RealtimeContextMessageInput,
  ): Promise<RealtimeContextMessageResult> => {
    const members = await participants();
    const inputParticipant = resolveParticipant(
      members,
      metadata.participantId,
      "Realtime input participant",
    );
    const agentParticipant = resolveParticipant(
      members,
      metadata.recipientId,
      "Realtime agent participant",
    );
    let sender: ParticipantInput;
    if (input.sender === undefined || input.sender === "agent") {
      sender = participantInput(agentParticipant);
    } else if (input.sender === "participant") {
      sender = participantInput(inputParticipant);
    } else {
      const matched = input.sender.id ?? input.sender.externalId;
      sender = participantInput(resolveParticipant(members, matched, "Sender"));
    }
    const senderId = sender.id ?? sender.externalId;
    const defaultRecipient = senderId === agentParticipant.id
      ? inputParticipant.id
      : agentParticipant.id;
    const recipientIds = (input.recipientIds ?? [defaultRecipient]).map(
      (value) => resolveParticipant(members, value, "Recipient").id,
    );
    const operationKey = input.operationKey?.trim() || nextKey("message");
    const content = await capabilities.content.prepare(input.content, {
      operationKey: `${operationKey}:content`,
    });
    const messageMetadata = withWorkflowMetadata({
      ...structuredClone(input.metadata ?? {}),
      modality: "realtime",
      realtimeStreamId: metadata.streamId,
    }, {
      kind: "realtime_message",
      continuation: "realtime",
      realtimeStreamId: metadata.streamId,
      agentParticipantId: agentParticipant.id,
    });
    const messageId = input.id
      ? requiredText(input.id, "Message ID")
      : `realtime:${metadata.streamId}:${operationKey}`;
    const record = await createMessageRecord(capabilities, {
      id: messageId,
      threadId: metadata.threadId,
      senderId,
      recipientIds,
      content,
      visibility: input.visibility ?? { kind: "public" },
      metadata: messageMetadata,
    }, { operationKey });
    const event = await requireDurableEvent(capabilities, {
      threadId: metadata.threadId,
      types: ["message.created"],
      subject: { type: "message", id: record.id },
    });
    const message = await loadMessageRecord(capabilities, record.id);
    if (!message) {
      throw new Error("Realtime message mutation returned no record.");
    }
    return Object.freeze({ message, event });
  };

  const tool = async (
    input: RealtimeToolCallInput,
  ): Promise<RealtimeToolCallResult> => {
    const toolId = requiredText(input.tool, "Realtime tool ID");
    const ordinal = nextKey("tool");
    const toolCallId = input.toolCallId?.trim() ||
      `${metadata.streamId}:${ordinal}`;
    const executionId = input.id?.trim() ||
      await deriveWorkflowId("tool", metadata.streamId, toolCallId);
    const resource = capabilities.resources.get<Record<string, unknown>>(
      "tools",
      toolId,
    );
    const preparedArguments = await capabilities.content.prepare({
      type: "json",
      value: input.arguments ?? null,
      role: "tool.arguments",
    }, { operationKey: `${ordinal}:arguments` });
    const workflow = withWorkflowMetadata({
      ...structuredClone(input.metadata ?? {}),
      modality: "realtime",
      realtimeStreamId: metadata.streamId,
    }, {
      kind: "tool_execution",
      continuation: "realtime",
      realtimeStreamId: metadata.streamId,
      toolCallId,
      batchId: executionId,
      batchSize: 1,
      batchIndex: 0,
      agentParticipantId: metadata.recipientId,
    });
    const created = await createToolExecutionCollection(capabilities, {
      id: executionId,
      threadId: metadata.threadId,
      participantId: metadata.recipientId,
      agentId: metadata.agentId,
      toolCallId,
      tool: {
        id: toolId,
        name: typeof resource?.name === "string" ? resource.name : toolId,
      },
      status: "running",
      historyVisibility: input.historyVisibility ?? "public_status",
      metadata: workflow,
    }, {
      operationKey: `${ordinal}:create`,
      metadata: workflow,
      content: preparedArguments,
    });
    const current = await loadToolExecutionRecord(capabilities, created.id) ??
      await loadToolExecutionRecord(capabilities, executionId);
    if (!current) {
      throw new Error(`Realtime tool execution '${executionId}' vanished.`);
    }
    const terminalEvent = current.status === "running" ||
        current.status === "pending"
      ? await capabilities.events.waitFor({
        threadId: metadata.threadId,
        types: [
          "tool_execution.updated",
        ],
        subject: { type: "tool_execution", id: executionId },
        timeoutMs: timeout(input.timeoutMs),
      })
      : await requireDurableEvent(capabilities, {
        threadId: metadata.threadId,
        types: ["tool_execution.created"],
        subject: { type: "tool_execution", id: executionId },
      });
    if (!terminalEvent.durable) {
      throw new Error("Realtime tool terminal event was not durable.");
    }
    const execution = await loadToolExecutionRecord(capabilities, executionId);
    if (!execution) {
      throw new Error(`Realtime tool execution '${executionId}' vanished.`);
    }
    const content = toolExecutionContent(execution);
    const selected = content.projectedOutput ?? content.output;
    const projectionEvent = await capabilities.events.waitFor({
      threadId: metadata.threadId,
      types: ["message.created"],
      metadata: {
        copilotzWorkflow: {
          kind: "tool_result",
          toolExecutionId: executionId,
        },
      },
      timeoutMs: timeout(input.timeoutMs),
    });
    if (!projectionEvent.durable || !projectionEvent.subject) {
      throw new Error("Realtime tool result projection was not durable.");
    }
    const message = await loadMessageRecord(
      capabilities,
      projectionEvent.subject.id,
    );
    if (!message) {
      throw new Error(`Realtime tool result message vanished.`);
    }
    return Object.freeze({
      execution,
      event: terminalEvent,
      message,
      ...(selected
        ? { output: await capabilities.content.resolve(selected) }
        : {}),
    });
  };

  const ask = async (
    input: RealtimeAgentAskInput,
  ): Promise<RealtimeAgentAskResult> => {
    const result = await tool({
      tool: "ask",
      arguments: {
        target: requiredText(input.target, "Ask target"),
        message: requiredText(input.message, "Ask message"),
      },
      id: input.id,
      toolCallId: input.toolCallId,
      timeoutMs: input.timeoutMs,
      metadata: input.metadata,
      historyVisibility: "public_status",
    });
    const value = result.output ? resolvedValue(result.output) : undefined;
    const answerMessageId = value && typeof value === "object" &&
        typeof (value as Record<string, unknown>).answerMessageId === "string"
      ? (value as Record<string, string>).answerMessageId
      : undefined;
    const answer = answerMessageId
      ? await loadMessageRecord(capabilities, answerMessageId)
      : null;
    return Object.freeze({
      ...result,
      ...(answer
        ? {
          answer,
          answerContent: await capabilities.content.resolveMany(
            answer.content,
          ),
        }
        : {}),
    });
  };

  return Object.freeze({
    ...capabilities,
    streamId: metadata.streamId,
    threadId: metadata.threadId,
    correlationId: metadata.correlationId,
    participantId: metadata.participantId,
    agentParticipantId: metadata.recipientId,
    agentId: metadata.agentId,
    signal: base.signal,
    send,
    tool,
    ask,
  });
}
