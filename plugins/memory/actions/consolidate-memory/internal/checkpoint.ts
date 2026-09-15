/** Selects and validates the checkpoint owned by a consolidation Action. @module */
import {
  coreToolActionMetadata,
  listThreadMessageRecords,
  loadThreadRecord,
} from "@copilotz/copilotz/core";
import type { CollectionRecord } from "@copilotz/copilotz/collections";

import { estimateTextTokens } from "@copilotz/copilotz/llm/tokens";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import {
  type MemoryRecordProjection,
  type MemoryRecordRelation,
  type MemorySpaceDescriptor,
  renderLongTermMemory,
} from "../../../authoring/consolidation/index.ts";
import type { LongTermMemoryConfig } from "../../../resources/config/index.ts";
import type {
  MemoryActionContext,
  MemoryProcessorContext,
} from "../../../internal/contracts.ts";
import { optionalText, record, requiredText } from "../../../internal/input.ts";
import {
  checkpoints,
  createCheckpoint,
} from "../../../internal/checkpoints.ts";
import {
  checkpointAccessible,
  ensureWritableMemorySpace,
} from "../../../internal/access.ts";
import {
  certifiedHistoryBoundary,
  checkpointSourceMessages,
} from "../../../internal/source.ts";
import { activeMemoryRecords } from "../../../internal/retrieval.ts";
import { recordRelations } from "./proposal.ts";
import { memoryTaskOwnsTurn } from "../../../processors/internal/task.ts";

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
    ? (await checkpoints(
      context,
      provenance.threadId,
      provenance.agentId,
      "ready",
    ))
      .find((item) =>
        checkpointAccessible(item, spaces) &&
        Boolean(certifiedHistoryBoundary(item, {
          agentId: provenance.agentId,
          participantId: provenance.agentParticipantId,
          thread,
        }))
      ) ?? null
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
  const start = after
    ? history.findIndex((message) => message.id === after) + 1
    : 0;
  if (start < 0 || start > triggerIndex) {
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
    agentId: string;
    spaces: readonly MemorySpaceDescriptor[];
    config: LongTermMemoryConfig;
    result: Readonly<Record<string, unknown>>;
    retrievedIds?: readonly string[];
    unresolved?: readonly unknown[];
    records?: readonly MemoryRecordProjection[];
    relations?: readonly MemoryRecordRelation[];
  }>,
) {
  await checkpointSourceMessages(context, input.checkpoint);
  const records = input.records ?? await activeMemoryRecords(
    context,
    input.spaces,
  );
  const ids = new Set(records.map((item) => item.id));
  const relations = input.relations ?? await recordRelations(context, ids);
  const semanticText = renderLongTermMemory({
    records,
    relations,
    maxContentEstimatedTokens: input.config.maxContentEstimatedTokens,
  });
  const continuity = requiredText(
    record(input.result).continuity,
    "Memory continuity",
  );
  const text = `Conversation continuity:\n${continuity}\n\n${semanticText}`;
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
              continuity: requiredText(
                record(input.result).continuity,
                "Memory continuity",
              ),
            },
          }
          : {}),
        processorVersion: "v4",
        memoryOntologyVersion: "1",
        result: input.result,
        continuity: optionalText(record(input.result).continuity),
        retrievedMemoryIds: input.retrievedIds ?? [],
        unresolvedReconciliations: input.unresolved ?? [],
      },
    },
  };
}

export async function settleCheckpoint(
  context: MemoryProcessorContext,
  input: Parameters<typeof prepareCheckpointSettlement>[1],
) {
  const settlement = await prepareCheckpointSettlement(context, input);
  await context.transaction(async (tx) => {
    await tx.collections.longTermMemory.commands.completeConsolidation({
      id: input.checkpoint.id,
      ...settlement.patch,
      content: settlement.content,
    }, { operationKey: `memory-checkpoint:ready:${input.checkpoint.id}` });
  });
}
