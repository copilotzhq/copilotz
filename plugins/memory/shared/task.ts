/** Identifies consolidation turns and their owning checkpoints. @module */
import {
  coreAgentTurnMetadata,
  withCoreAgentTurnMetadata,
} from "@copilotz/copilotz/core";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import type {
  MemoryActionContext,
  MemoryProcessorContext,
} from "./contracts.ts";
import { optionalText, record } from "./input.ts";

const MEMORY_TASK_METADATA_KEY = "copilotzMemory";

function memoryTaskCheckpointId(value: unknown): string | undefined {
  return optionalText(
    record(record(value)[MEMORY_TASK_METADATA_KEY]).checkpointId,
  );
}

export function memoryTaskMetadata(
  checkpointId: string,
  ownerParticipantId: string,
) {
  return withCoreAgentTurnMetadata({
    [MEMORY_TASK_METADATA_KEY]: { checkpointId },
  }, {
    schema: "copilotz.core.agent-turn.v1",
    id: checkpointId,
    ownerParticipantId,
    completeOn: { action: "consolidate_memory" },
    history: "scope",
  });
}

/**
 * Verifies both the Memory-owned root task and the current Core continuation.
 *
 * A repaired turn may be triggered by a projected Tool result rather than the
 * original task Message. The opaque turn id remains the stable ownership
 * cursor; the current Message must still be internal and in that exact scope.
 */

export async function memoryTaskOwnsTurn(
  context: MemoryActionContext | MemoryProcessorContext,
  turn: NonNullable<ReturnType<typeof coreAgentTurnMetadata>>,
  currentTriggerMessageId: string,
): Promise<boolean> {
  const rootTaskId = await deriveWorkflowId(
    "message",
    "memory-agent-turn",
    turn.id,
  );
  const [rootTask, currentTrigger] = await Promise.all([
    context.collections.message.get({ id: rootTaskId }),
    context.collections.message.get({ id: currentTriggerMessageId }),
  ]);
  const rootTurn = rootTask ? coreAgentTurnMetadata(rootTask.metadata) : null;
  const currentTurn = currentTrigger
    ? coreAgentTurnMetadata(currentTrigger.metadata)
    : null;
  return Boolean(
    rootTask && currentTrigger &&
      record(rootTask.visibility).kind === "internal" &&
      rootTask.historyScopeId === turn.id &&
      memoryTaskCheckpointId(rootTask.metadata) === turn.id &&
      rootTurn?.id === turn.id &&
      rootTurn.ownerParticipantId === turn.ownerParticipantId &&
      record(currentTrigger.visibility).kind === "internal" &&
      currentTrigger.historyScopeId === turn.id &&
      currentTurn?.id === turn.id &&
      currentTurn.ownerParticipantId === turn.ownerParticipantId,
  );
}

/** Emits the Memory-owned task Message that Core routes as an ordinary Agent turn. */
