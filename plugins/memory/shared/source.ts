/** Authorized source ranges and history-boundary certification. @module */
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type {
  ConversationMessage,
  ConversationThread,
} from "@copilotz/copilotz/core";
import {
  loadCoreThreadMessageSnapshot,
  prepareLlmTranscript,
} from "@copilotz/copilotz/core";
import type { AgentResource } from "@copilotz/copilotz/core";
import { formatLlmRequestForWire } from "@copilotz/copilotz/llm";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import type { MemorySourceMessage } from "../authoring/consolidation/index.ts";
import type { MemoryProcessorContext } from "./contracts.ts";
import { optionalText, record } from "./input.ts";
import { checkpointAccessible, threadMemorySpaces } from "./access.ts";

export class MemorySourceInvalidatedError extends Error {
  override name = "MemorySourceInvalidatedError";
}

export function branchCertificate(thread: ConversationThread): string {
  const branch = thread.activeMessageBranch;
  return branch
    ? JSON.stringify({
      rootMessageId: branch.rootMessageId,
      headMessageId: branch.headMessageId,
      previousRevisionMessageId: branch.previousRevisionMessageId,
      revisionIndex: branch.revisionIndex,
    })
    : "public";
}

export function certifiedHistoryBoundary(
  checkpoint: CollectionRecord,
  input: Readonly<{
    agentId: string;
    participantId: string;
    historyScopeId?: string;
    thread: ConversationThread;
  }>,
): string | undefined {
  const coverage = record(record(checkpoint.metadata).coverage);
  if (
    coverage.schema !== "copilotz.memory.coverage.v1" ||
    checkpoint.status !== "ready" || checkpoint.agentId !== input.agentId ||
    coverage.agentParticipantId !== input.participantId ||
    coverage.historyScopeId !== input.historyScopeId ||
    coverage.branch !== branchCertificate(input.thread) ||
    !optionalText(coverage.startMessageId) ||
    !optionalText(coverage.endMessageId) ||
    !optionalText(coverage.continuity)
  ) return undefined;
  return optionalText(coverage.endMessageId);
}

function sourceBytes(content: readonly unknown[]): number {
  return content.reduce<number>((total, entry) => {
    const value = record(entry).value;
    return total +
      (value instanceof Uint8Array
        ? value.byteLength
        : value === undefined
        ? 0
        : new TextEncoder().encode(
          typeof value === "string" ? value : JSON.stringify(value),
        ).byteLength);
  }, 0);
}

export async function projectedSourceMessages(
  context: MemoryProcessorContext,
  input: Readonly<{
    threadId: string;
    participantId: string;
    messages: readonly ConversationMessage[];
    byteLimit?: number;
    model?: NonNullable<AgentResource["models"]["generate"]>[number];
  }>,
): Promise<readonly MemorySourceMessage[]> {
  const prepared = await prepareLlmTranscript(context as never, {
    threadId: input.threadId,
    participantId: input.participantId,
    history: input.messages,
  }, input.byteLimit === undefined ? {} : { byteLimit: input.byteLimit });
  return sourceMessagesFromTranscript(context, input, prepared);
}

export function sourceMessagesFromTranscript(
  context: Pick<MemoryProcessorContext, "resources">,
  input: Readonly<{
    messages: readonly ConversationMessage[];
    model?: NonNullable<AgentResource["models"]["generate"]>[number];
  }>,
  prepared: readonly import("@copilotz/copilotz/core").LlmTranscriptEntry[],
): readonly MemorySourceMessage[] {
  const positions = new Map(input.messages.map((message, index) => [
    message.id,
    index,
  ]));
  const projected = prepared.map(({ sourceId, message }) => {
    const connection = record(
      record(context.resources.llmConnections)[input.model?.connection ?? ""],
    );
    const formatted = formatLlmRequestForWire({ messages: [message] }, {
      ...(input.model ? { model: input.model.model } : {}),
      ...record(input.model?.options),
      ...(typeof connection.provider === "string"
        ? {
          provider: connection
            .provider as Parameters<
              typeof formatLlmRequestForWire
            >[1]["provider"],
        }
        : {}),
    });
    return {
      id: sourceId,
      senderType: message.role,
      senderId: message.name ?? message.role,
      text: formatted.messages.map((item) =>
        typeof item.content === "string"
          ? item.content
          : item.content.filter((part) => part.type === "text").map((part) =>
            part.text
          ).join("\n")
      ).join("\n"),
      sourceBytes: sourceBytes(message.content) +
        (message.role === "assistant"
          ? sourceBytes(message.reasoning ?? [])
          : 0),
      estimatedTokens: formatted.estimate.estimatedTokens,
      ...((message.role === "assistant" || message.role === "tool") &&
          message.toolPlanId
        ? { toolPlanId: message.toolPlanId }
        : {}),
      ...(message.role === "tool" ? { toolCallId: message.toolCallId } : {}),
      ...(message.role === "assistant" && message.toolCalls
        ? { toolCalls: structuredClone(message.toolCalls) }
        : {}),
    } as const;
  });
  // Transcript preparation can reposition an Ask receipt next to its answer.
  // Checkpoints always cover a contiguous raw-history prefix instead.
  return (projected.sort((left, right) =>
    (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
    (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  ));
}

export function rangeMessages(
  all: readonly ConversationMessage[],
  checkpoint: Readonly<Record<string, unknown>>,
) {
  const start = all.findIndex((message) =>
    message.id === checkpoint.sourceStartMessageId
  );
  const end = all.findIndex((message) =>
    message.id === checkpoint.sourceEndMessageId
  );
  if (start < 0 || end < start) {
    throw new MemorySourceInvalidatedError(
      "Reserved memory message range is unavailable.",
    );
  }
  return (all.slice(start, end + 1));
}

export async function sourceRangeFingerprint(
  messages: readonly ConversationMessage[],
): Promise<string> {
  return await deriveWorkflowId(
    "memory-source",
    JSON.stringify(messages.map((message) => ({
      id: message.id,
      senderId: message.sender.id,
      recipientIds: message.recipientIds,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      content: message.content,
      metadata: message.metadata,
      revision: message.revision,
      visibility: message.visibility,
    }))),
  );
}

export async function checkpointSourceMessages(
  context: MemoryProcessorContext,
  checkpoint: CollectionRecord,
): Promise<readonly ConversationMessage[]> {
  const candidate = record(record(checkpoint.metadata).coverageCandidate);
  const sourceEnd = await context.collections.message.get({
    id: String(checkpoint.sourceEndMessageId),
  });
  if (!sourceEnd) {
    throw new MemorySourceInvalidatedError(
      "Memory source range is no longer available.",
    );
  }
  return await context.readSnapshot(async ({ collections }) => {
    const scoped = { ...context, collections } as typeof context;
    const snapshot = await loadCoreThreadMessageSnapshot(
      scoped,
      String(checkpoint.threadId),
      sourceEnd,
      {
        range: {
          startMessageId: String(checkpoint.sourceStartMessageId),
          endMessageId: String(checkpoint.sourceEndMessageId),
        },
        viewerIds: [
          String(
            candidate.agentParticipantId ??
              record(checkpoint.metadata).agentParticipantId,
          ),
        ],
        ...(typeof candidate.historyScopeId === "string"
          ? { historyScopeId: candidate.historyScopeId }
          : {}),
      },
    );
    const messages = rangeMessages(snapshot.messages, checkpoint);
    if (
      !snapshot.active ||
      !snapshot.thread.participants.some((participant) =>
        participant.id ===
          String(
            candidate.agentParticipantId ??
              record(checkpoint.metadata).agentParticipantId,
          ) && participant.participantType === "agent"
      ) ||
      !checkpointAccessible(
        checkpoint,
        await threadMemorySpaces(scoped, String(checkpoint.threadId)),
      ) ||
      candidate.schema === "copilotz.memory.coverage.v1" &&
        (candidate.branch !== branchCertificate(snapshot.thread) ||
          candidate.sourceFingerprint !==
            await sourceRangeFingerprint(messages))
    ) {
      throw new MemorySourceInvalidatedError(
        "Memory source range changed before checkpoint settlement.",
      );
    }
    return messages;
  });
}
