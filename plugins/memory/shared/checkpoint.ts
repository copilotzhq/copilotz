/** Selects and validates the checkpoint owned by a consolidation Action. @module */
import {
  coreToolActionMetadata,
  listThreadMessageRecords,
  loadThreadRecord,
} from "@copilotz/copilotz/core";
import type { CollectionRecord } from "@copilotz/copilotz/collections";

import { estimateTextTokens } from "@copilotz/copilotz/llm/tokens";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import type { MemorySpaceDescriptor } from "../authoring/consolidation/index.ts";
import type {
  MemoryActionContext,
  MemoryProcessorContext,
} from "./contracts.ts";
import { optionalText, record, requiredText } from "./input.ts";
import { createCheckpoint, readyCheckpoint } from "./checkpoints.ts";
import { ensureWritableMemorySpace } from "./access.ts";
import { certifiedHistoryBoundary } from "./source.ts";
import { memoryContinuityText } from "../authoring/notes/index.ts";
import { memoryTaskOwnsTurn } from "./task.ts";

async function reserveOnDemandCheckpoint(
  context: MemoryActionContext,
  provenance: NonNullable<ReturnType<typeof coreToolActionMetadata>>,
): Promise<CollectionRecord> {
  const id = `memory:on-demand:${await deriveWorkflowId(
    "memory-on-demand",
    provenance.planId,
    String(provenance.planIndex),
    String(provenance.stageIndex),
  )}`;
  const existing = await context.collections.longTermMemory.get({ id });
  if (existing) return existing;
  const spaces = await ensureWritableMemorySpace(context, provenance.threadId);
  const thread = await loadThreadRecord(context, provenance.threadId);
  const previous = thread
    ? await readyCheckpoint(context, {
      agentId: provenance.agentId,
      participantId: provenance.agentParticipantId,
      thread,
    })
    : null;
  const history = await listThreadMessageRecords(context, provenance.threadId);
  const triggerIndex = history.findIndex((message) =>
    message.id === provenance.triggerMessageId
  );
  if (triggerIndex < 0) {
    throw new Error("Memory Tool trigger Message is unavailable.");
  }
  const after = previous && thread
    ? certifiedHistoryBoundary(previous, {
      agentId: provenance.agentId,
      participantId: provenance.agentParticipantId,
      thread,
    })
    : undefined;
  const boundaryIndex = after
    ? history.findIndex((message) => message.id === after)
    : -1;
  const start = boundaryIndex + 1;
  if ((after && boundaryIndex < 0) || start > triggerIndex) {
    throw new Error("Memory Tool has no unconsolidated source range.");
  }
  const range = history.slice(start, triggerIndex + 1);
  if (!range.length) throw new Error("Memory Tool has no source Messages.");
  return await createCheckpoint(context, {
    id,
    threadId: provenance.threadId,
    agentId: provenance.agentId,
    spaces,
    sourceStartMessageId: range[0].id,
    sourceEndMessageId: range.at(-1)!.id,
    metadata: {
      agentParticipantId: provenance.agentParticipantId,
      initiatorParticipantId: provenance.initiatorParticipantId,
      onDemand: true,
    },
  });
}

export async function checkpointForConsolidation(
  context: MemoryActionContext,
): Promise<CollectionRecord> {
  const provenance = coreToolActionMetadata(context.action.metadata);
  if (!provenance) {
    throw new Error(
      "consolidate_memory requires trusted Core Tool provenance.",
    );
  }
  const turn = provenance.agentTurn;
  if (!turn) return await reserveOnDemandCheckpoint(context, provenance);
  if (turn.ownerParticipantId !== provenance.agentParticipantId) {
    throw new Error("Memory Agent turn owner does not match Tool provenance.");
  }
  if (
    !await memoryTaskOwnsTurn(
      context,
      turn,
      provenance.triggerMessageId,
    )
  ) {
    throw new Error(
      "Memory Agent turn provenance does not own this checkpoint.",
    );
  }
  const checkpoint = await context.collections.longTermMemory.get({
    id: turn.id,
  });
  if (
    !checkpoint || checkpoint.threadId !== provenance.threadId ||
    checkpoint.agentId !== provenance.agentId ||
    record(checkpoint.metadata).agentParticipantId !==
      provenance.agentParticipantId
  ) {
    throw new Error(
      "Memory checkpoint does not match trusted Tool provenance.",
    );
  }
  return checkpoint;
}

export function activeSpacesForCheckpoint(
  checkpoint: CollectionRecord,
  spaces: readonly MemorySpaceDescriptor[],
) {
  const readable = new Set(
    Array.isArray(checkpoint.readMemorySpaceIds)
      ? checkpoint.readMemorySpaceIds
      : [],
  );
  const writable = new Set(
    Array.isArray(checkpoint.writeMemorySpaceIds)
      ? checkpoint.writeMemorySpaceIds
      : [],
  );
  const defaultId = optionalText(checkpoint.defaultWriteMemorySpaceId);
  const active = spaces.filter((space) => readable.has(space.id)).map((
    space,
  ) => ({
    ...space,
    access: writable.has(space.id) && space.access === "read_write"
      ? "read_write" as const
      : "read" as const,
    defaultWrite: space.id === defaultId && writable.has(space.id),
  }));
  if (
    !active.some((space) => space.defaultWrite && space.access === "read_write")
  ) {
    throw new Error(
      "Memory checkpoint has no accessible default writable space.",
    );
  }
  return active;
}

export async function prepareCheckpointSettlement(
  context: MemoryProcessorContext,
  input: Readonly<{
    checkpoint: CollectionRecord;
    result: Readonly<Record<string, unknown>>;
    continuity: string;
  }>,
) {
  const continuity = requiredText(
    input.continuity,
    "Memory continuity",
  );
  // Continuity belongs to the conversation. Durable notes are retrieved
  // separately under current access, rather than copied into this artifact.
  const text = memoryContinuityText(continuity);
  const prepared = await context.content.prepare({
    type: "text",
    text,
    role: "memory.snapshot",
  }, {
    operationKey: `checkpoint:${input.checkpoint.id}:content`,
  });
  return {
    content: prepared,
    patch: {
      status: "ready",
      contentHash: prepared.assets[0]?.digest ?? null,
      tokenEstimate: estimateTextTokens(text),
      error: null,
      metadata: {
        ...record(input.checkpoint.metadata),
        ...(record(record(input.checkpoint.metadata).coverageCandidate)
            .schema ===
            "copilotz.memory.coverage.v1"
          ? {
            coverage: {
              ...record(record(input.checkpoint.metadata).coverageCandidate),
              continuity,
            },
          }
          : {}),
        processorVersion: "v5",
        result: input.result,
      },
    },
  };
}
