import { visibleMemorySources } from "../../shared/evidence.ts";
import { memoryConfig } from "../../resources/memory/config/index.ts";
/** Dispatches a scoped Core Agent turn for a reserved checkpoint. @module */
import {
  type ConversationMessage,
  loadParticipantRecord,
  loadThreadRecord,
} from "@copilotz/copilotz/core";

import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import { createThreadMessage } from "../../../core/actions/create-thread-message/index.ts";
import { buildMemoryConsolidationInstruction } from "../../authoring/consolidation/index.ts";

import type { MemoryProcessorContext } from "../../shared/contracts.ts";
import {
  checkpointSourceMessages,
  MemorySourceInvalidatedError,
} from "../../shared/source.ts";
import { record, requiredText } from "../../shared/input.ts";
import { threadMemorySpaces } from "../../shared/access.ts";
import {
  captureContextSnapshot,
  frozenSnapshot,
} from "../../shared/snapshot.ts";
import { settleCheckpointError } from "../../shared/checkpoints.ts";
import { activeSpacesForCheckpoint } from "../../shared/checkpoint.ts";
import { memoryTaskMetadata } from "../../shared/task.ts";

export const dispatchMemoryConsolidationProcessor: Processor<
  MemoryProcessorContext
> = defineProcessor({
  id: "copilotz.memory.dispatch-consolidation",
  on: [{ eventType: "long_term_memory.created" }],
  settlement: "detached",
  async handle(event, context) {
    const config = memoryConfig(context);
    if (!config.enabled) return;
    if (!event.durable || !event.subject) return;
    let checkpoint = await context.collections.longTermMemory
      .get({ id: event.subject.id });
    if (!checkpoint || checkpoint.status !== "pending") return;
    if (record(checkpoint.metadata).onDemand === true) return;
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
      throw new Error(
        "Memory checkpoint participant or thread is unavailable.",
      );
    }
    await captureContextSnapshot(context, {
      checkpoint,
      agent: context.resources.agents[agentId]!,
      participant,
      thread,
      rangeMessages: messages,
    });
    checkpoint = await context.collections.longTermMemory.get({
      id: checkpoint.id,
    }) ?? checkpoint;
    const spaces = activeSpacesForCheckpoint(
      checkpoint,
      await threadMemorySpaces(context, threadId),
    );
    const instruction = buildMemoryConsolidationInstruction({
      spaces,
      // Bodies remain typed history; the maintenance suffix carries provenance only.
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
    const initiatorParticipantId = requiredText(
      record(checkpoint.metadata).initiatorParticipantId,
      "Memory initiating human participant id",
    );
    const initiator = await loadParticipantRecord(
      context,
      initiatorParticipantId,
    );
    if (!initiator || initiator.participantType !== "human") {
      throw new Error("Memory initiating human participant is unavailable.");
    }
    const id = await deriveWorkflowId(
      "message",
      "memory-agent-turn",
      checkpoint.id,
    );
    await createThreadMessage({
      id,
      threadId,
      sender: initiator,
      recipientIds: [participant.id],
      visibility: { kind: "internal" },
      historyScopeId: checkpoint.id,
      content: [
        { type: "text", role: "memory.task", text: instruction },
      ],
      metadata: memoryTaskMetadata(checkpoint.id, participant.id, {
        messages,
        context: frozenSnapshot(checkpoint),
        branch: JSON.stringify(thread.activeMessageBranch ?? null),
        ...(record(checkpoint.metadata).preparationTrigger
          ? {
            trigger: record(checkpoint.metadata)
              .preparationTrigger as ConversationMessage,
          }
          : {}),
      }),
    }, context);
  },
});

/** Settles only Memory-owned scoped Agent turns; Core remains semantic-neutral. */

export default dispatchMemoryConsolidationProcessor;
