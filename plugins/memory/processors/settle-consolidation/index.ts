import { memoryConfig } from "../../resources/memory/config/index.ts";
/** Settles failed or omitted consolidation turns. @module */
import {
  coreLlmCallMetadata,
  loadParticipantRecord,
} from "@copilotz/copilotz/core";
import { parseActionLifecycleEvent } from "@copilotz/copilotz/actions";

import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import { createThreadMessage } from "../../../core/actions/create-thread-message/index.ts";

import type { MemoryProcessorContext } from "../../shared/contracts.ts";
import { record } from "../../shared/input.ts";
import { settleCheckpointError } from "../../shared/checkpoints.ts";
import { memoryTaskMetadata, memoryTaskOwnsTurn } from "../../shared/task.ts";

export const settleMemoryConsolidationProcessor: Processor<
  MemoryProcessorContext
> = defineProcessor({
  id: "copilotz.memory.settle-consolidation",
  on: [
    { eventType: "llm.call.completed" },
    { eventType: "llm.call.failed" },
    { eventType: "llm.call.cancelled" },
  ],
  settlement: "detached",
  async handle(event, context) {
    const config = memoryConfig(context);
    if (!config.enabled) return;
    const lifecycle = parseActionLifecycleEvent(event, {
      actionId: "llm.call",
      statuses: ["completed", "failed", "cancelled"],
      requireRoot: true,
    });
    if (!lifecycle) return;
    const metadata = coreLlmCallMetadata(lifecycle.metadata);
    const turn = metadata?.agentTurn;
    if (
      !metadata || !turn?.completeOn ||
      turn.completeOn.action !== "consolidate_memory" ||
      metadata.agentParticipantId !== turn.ownerParticipantId
    ) return;
    const checkpoint = await context.collections.longTermMemory.get({
      id: turn.id,
    });
    if (!checkpoint || checkpoint.status !== "pending") return;
    if (
      !await memoryTaskOwnsTurn(
        context,
        turn,
        metadata.triggerMessageId,
      )
    ) return;
    if (lifecycle.status === "failed" || lifecycle.status === "cancelled") {
      await settleCheckpointError(
        context,
        checkpoint.id,
        lifecycle.status === "cancelled" ? "cancelled" : "failed",
        lifecycle.error,
      );
      return;
    }
    const output = lifecycle.status === "completed"
      ? record((lifecycle as Readonly<{ output?: unknown }>).output)
      : {};
    if (Array.isArray(output.toolCalls) && output.toolCalls.length) return;
    const attempts = Number(
      record(checkpoint.metadata).omittedToolAttempts ?? 0,
    );
    if (attempts >= 1) {
      await settleCheckpointError(
        context,
        checkpoint.id,
        "failed",
        new Error(
          "The Memory Agent turn ended twice without consolidate_memory.",
        ),
      );
      return;
    }
    await context.collections.longTermMemory.update({
      id: checkpoint.id,
      set: {
        metadata: {
          ...record(checkpoint.metadata),
          omittedToolAttempts: attempts + 1,
        },
      },
    }, { operationKey: `memory:${checkpoint.id}:repair-count` });
    const repairId = await deriveWorkflowId(
      "message",
      "memory-agent-turn",
      checkpoint.id,
      "repair",
    );
    const sender = await loadParticipantRecord(
      context,
      metadata.initiatorParticipantId,
    );
    if (!sender || sender.participantType !== "human") {
      throw new Error("Memory repair initiator is unavailable.");
    }
    await createThreadMessage({
      id: repairId,
      threadId: metadata.threadId,
      sender,
      recipientIds: [turn.ownerParticipantId],
      visibility: { kind: "internal" },
      historyScopeId: turn.id,
      content: {
        type: "text",
        role: "memory.repair",
        text:
          "This internal task is unfinished. Call consolidate_memory now; do not answer the user.",
      },
      metadata: memoryTaskMetadata(checkpoint.id, turn.ownerParticipantId),
    }, context);
  },
});

export default settleMemoryConsolidationProcessor;
