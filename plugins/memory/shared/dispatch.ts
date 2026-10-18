/** Idempotently dispatches or repairs one pending checkpoint's maintenance turn. @module */
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  type ConversationMessage,
  coreAgentTurnMetadata,
  loadParticipantRecord,
  loadThreadRecord,
} from "@copilotz/copilotz/core";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import { createThreadMessage } from "../../core/actions/create-thread-message/index.ts";
import { buildMemoryConsolidationInstruction } from "../authoring/consolidation/index.ts";
import type { MemoryProcessorContext } from "./contracts.ts";
import {
  checkpointSourceMessages,
  MemorySourceInvalidatedError,
} from "./source.ts";
import { record, requiredText } from "./input.ts";
import { threadMemorySpaces } from "./access.ts";
import { captureContextSnapshot, frozenSnapshot } from "./snapshot.ts";
import { settleCheckpointError } from "./checkpoints.ts";
import { activeSpacesForCheckpoint } from "./checkpoint.ts";
import { memoryTaskMetadata, memoryTaskOwnsTurn } from "./task.ts";
import { visibleMemorySources } from "./evidence.ts";

async function existingProducerOwnsCheckpoint(
  context: MemoryProcessorContext,
  input: Readonly<{
    id: string;
    checkpointId: string;
    threadId: string;
    participantId: string;
  }>,
): Promise<boolean> {
  const producer = await context.collections.message.get({ id: input.id });
  if (!producer) return false;
  const turn = coreAgentTurnMetadata(producer.metadata);
  if (
    String(producer.threadId) !== input.threadId ||
    String(producer.senderId) !== input.participantId ||
    String(producer.historyScopeId) !== input.checkpointId ||
    record(producer.visibility).kind !== "internal" ||
    !turn || turn.id !== input.checkpointId ||
    turn.ownerParticipantId !== input.participantId
  ) return false;
  return await memoryTaskOwnsTurn(context, turn, input.id);
}

async function waitForConcurrentProducer(
  context: MemoryProcessorContext,
  input: Parameters<typeof existingProducerOwnsCheckpoint>[1],
): Promise<boolean> {
  const deadline = Date.now() + 1_000;
  do {
    context.signal.throwIfAborted();
    if (await existingProducerOwnsCheckpoint(context, input)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (true);
}

export async function dispatchMemoryCheckpoint(
  context: MemoryProcessorContext,
  checkpoint: CollectionRecord,
): Promise<void> {
  let messages: readonly ConversationMessage[];
  try {
    messages = await checkpointSourceMessages(context, checkpoint);
  } catch (error) {
    if (!(error instanceof MemorySourceInvalidatedError)) throw error;
    await settleCheckpointError(context, checkpoint.id, "failed", error);
    return;
  }
  const threadId = requiredText(checkpoint.threadId, "Memory thread id");
  const agentId = requiredText(checkpoint.agentId, "Memory agent id");
  const participantId = requiredText(
    record(checkpoint.metadata).agentParticipantId,
    "Memory participant id",
  );
  const participant = await loadParticipantRecord(context, participantId);
  const thread = await loadThreadRecord(context, threadId);
  if (!participant || participant.participantType !== "agent" || !thread) {
    throw new Error("Memory checkpoint participant or thread is unavailable.");
  }
  await captureContextSnapshot(context, {
    checkpoint,
    agent: context.resources.agents[agentId]!,
    participant,
    thread,
    rangeMessages: messages,
  });
  const refreshed = await context.collections.longTermMemory.get({
    id: checkpoint.id,
  });
  if (!refreshed || refreshed.status !== "pending") return;
  checkpoint = refreshed;
  const spaces = activeSpacesForCheckpoint(
    checkpoint,
    await threadMemorySpaces(context, threadId),
  );
  const instruction = buildMemoryConsolidationInstruction({
    spaces,
    sourceMessages: visibleMemorySources(messages, participant.id).map((
      message,
    ) => ({
      id: message.id,
      senderType: message.sender.participantType,
      senderId: message.sender.id,
      text: "",
    })),
    context: frozenSnapshot(checkpoint),
  });
  const id = await deriveWorkflowId(
    "message",
    "memory-agent-turn",
    checkpoint.id,
  );
  try {
    await createThreadMessage({
      id,
      threadId,
      sender: participant,
      recipientIds: [participant.id],
      visibility: { kind: "internal" },
      historyScopeId: checkpoint.id,
      content: [
        { type: "text", role: "memory.task", text: instruction },
      ],
      metadata: memoryTaskMetadata(
        checkpoint.id,
        participant.id,
        {
          messages,
          context: frozenSnapshot(checkpoint),
          branch: JSON.stringify(thread.activeMessageBranch ?? null),
          ...(record(checkpoint.metadata).preparationTrigger
            ? {
              trigger: record(checkpoint.metadata)
                .preparationTrigger as ConversationMessage,
            }
            : {}),
        },
        undefined,
        {
          initiatorParticipantId: String(
            record(checkpoint.metadata).initiatorParticipantId ??
              participant.id,
          ),
          ...(record(checkpoint.metadata).originMessageId
            ? {
              originMessageId: String(
                record(checkpoint.metadata).originMessageId,
              ),
            }
            : {}),
        },
      ),
    }, context);
  } catch (error) {
    // Concurrent original dispatch and orphan repair both use this stable id.
    // The collection's deterministic identity can reject the losing create;
    // adopt only a fully validated task for this exact checkpoint.
    if (
      !await waitForConcurrentProducer(context, {
        id,
        checkpointId: checkpoint.id,
        threadId,
        participantId,
      })
    ) throw error;
  }
}
