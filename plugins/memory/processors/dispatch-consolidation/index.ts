import { memoryConfig } from "../../resources/memory/config/index.ts";
/** Dispatches a scoped Core Agent turn for a reserved checkpoint. @module */
import {
  type ConversationMessage,
  loadParticipantRecord,
  loadThreadRecord,
} from "@copilotz/copilotz/core";

import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import { createThreadMessage } from "../../../core-collections/actions/create-thread-message/index.ts";
import {
  buildMemoryConsolidationInstruction,
  isEditoriallyVisible,
} from "../../authoring/consolidation/index.ts";

import type { MemoryProcessorContext } from "../../internal/contracts.ts";
import {
  checkpointSourceMessages,
  MemorySourceInvalidatedError,
  projectedSourceMessages,
} from "../../internal/source.ts";
import { record, requiredText } from "../../internal/input.ts";
import { threadMemorySpaces } from "../../internal/access.ts";
import {
  activeMemoryRecords,
  terminalStatus,
} from "../../internal/retrieval.ts";
import {
  captureContextSnapshot,
  frozenSnapshot,
  memoryKinds,
} from "../../internal/snapshot.ts";
import { settleCheckpointError } from "../../internal/checkpoints.ts";
import { activeSpacesForCheckpoint } from "../../actions/consolidate-memory/internal/checkpoint.ts";
import { memoryTaskMetadata } from "../internal/task.ts";

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
    const previous = (await activeMemoryRecords(
      context,
      spaces,
    )).filter((item) =>
      isEditoriallyVisible(item) && !terminalStatus(item.status)
    ).slice(0, 100);
    const instruction = buildMemoryConsolidationInstruction({
      spaces,
      sourceMessages: await projectedSourceMessages(context, {
        threadId,
        participantId: participant.id,
        messages,
      }),
      kinds: memoryKinds(context),
      previousRecords: previous,
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
        ...frozenSnapshot(checkpoint).flatMap((item) => item.content),
      ],
      metadata: memoryTaskMetadata(checkpoint.id, participant.id),
    }, context);
  },
});

/** Settles only Memory-owned scoped Agent turns; Core remains semantic-neutral. */

export default dispatchMemoryConsolidationProcessor;
