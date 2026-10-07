/** Checkpoint creation, ordering, recovery, and failure settlement. @module */
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { MemorySpaceDescriptor } from "../authoring/consolidation/index.ts";
import type { MemoryProcessorContext } from "./contracts.ts";
import { optionalText, record } from "./input.ts";
import type { ConversationThread } from "@copilotz/copilotz/core";
import { branchCertificate, certifiedHistoryBoundary } from "./source.ts";

/** Capture the allocation head before preparing source; on-demand writes never trim history. */
export async function checkpointHead(
  context: Pick<MemoryProcessorContext, "collections">,
  threadId: string,
  agentId: string,
): Promise<CollectionRecord | null> {
  return (await context.collections.longTermMemory.list({
    where: { threadId, agentId },
    filter: { not: { field: "metadata.onDemand", eq: true } },
    order: { field: "sequence", direction: "desc" },
    limit: 1,
  }))[0] ?? null;
}

/** Select certified, thread-owned continuity without consulting external memory grants. */
export async function readyCheckpoint(
  context: Pick<MemoryProcessorContext, "collections">,
  input: Readonly<{
    thread: ConversationThread;
    agentId: string;
    participantId: string;
    historyScopeId?: string;
    sourceEndMessageId?: string;
  }>,
): Promise<CollectionRecord | null> {
  const values = await context.collections.longTermMemory.list({
    where: {
      threadId: input.thread.id,
      agentId: input.agentId,
      status: "ready",
      ...(input.sourceEndMessageId
        ? { sourceEndMessageId: input.sourceEndMessageId }
        : {}),
    },
    filter: {
      and: [
        {
          field: "metadata.coverage.schema",
          eq: "copilotz.memory.coverage.v1",
        },
        {
          field: "metadata.coverage.agentParticipantId",
          eq: input.participantId,
        },
        {
          field: "metadata.coverage.branch",
          eq: branchCertificate(input.thread),
        },
        input.historyScopeId
          ? {
            field: "metadata.coverage.historyScopeId",
            eq: input.historyScopeId,
          }
          : { field: "metadata.coverage.historyScopeId", exists: false },
        { not: { field: "metadata.onDemand", eq: true } },
      ],
    },
    order: { field: "sequence", direction: "desc" },
    limit: 1,
  });
  return values.find((value) => certifiedHistoryBoundary(value, input)) ?? null;
}

function serializedActionError(
  value: unknown,
): Readonly<{ name: string; message: string }> | undefined {
  const error = record(value);
  if (Object.keys(error).length !== 2) return undefined;
  const name = optionalText(error.name);
  const message = optionalText(error.message);
  return name && message ? ({ name, message } as const) : undefined;
}

function checkpointSequence(value: CollectionRecord | null): number {
  const sequence = Number(value?.sequence);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0;
}

/** Reserve one checkpoint; only the caller may supply certified history coverage. */

export async function createCheckpoint(
  context: MemoryProcessorContext,
  input: Readonly<{
    id?: string;
    sequence?: number;
    threadId: string;
    agentId: string;
    spaces: readonly MemorySpaceDescriptor[];
    sourceStartMessageId: string;
    sourceEndMessageId: string;
    metadata: Readonly<Record<string, unknown>>;
  }>,
): Promise<CollectionRecord> {
  const { threadId, agentId, spaces } = input;
  const writable = spaces.filter((space) => space.access === "read_write");
  const defaultSpace = spaces.find((space) => space.defaultWrite);
  if (!defaultSpace || !writable.length) {
    throw new Error("Thread has no default writable memory space.");
  }
  const sequence = input.sequence ?? (checkpointSequence(
    await checkpointHead(context, threadId, agentId),
  ) + 1);
  const id = input.id ?? `memory:${threadId}:${agentId}:${sequence}`;
  try {
    return await context.collections.longTermMemory.create({
      id,
      name: `Thread ${threadId} / ${agentId} / ${sequence}`,
      threadId,
      schemaVersion: "5",
      strategy: "notes",
      status: "pending",
      memorySpaceId: defaultSpace.id,
      readMemorySpaceIds: spaces.map((space) => space.id),
      writeMemorySpaceIds: writable.map((space) => space.id),
      defaultWriteMemorySpaceId: defaultSpace.id,
      sequence,
      agentId,
      sourceStartMessageId: input.sourceStartMessageId,
      sourceEndMessageId: input.sourceEndMessageId,
      content: [],
      contextSnapshotContent: [],
      contextSnapshot: null,
      embedding: null,
      contentHash: null,
      tokenEstimate: null,
      error: null,
      metadata: input.metadata,
    }, {
      operationKey: input.id
        ? `checkpoint:on-demand:${id}`
        : `checkpoint:reserve:${id}`,
    });
  } catch (error) {
    const concurrent = await context.collections.longTermMemory.get({ id });
    if (concurrent) return concurrent;
    throw error;
  }
}

export async function settleCheckpointError(
  context: MemoryProcessorContext,
  checkpointId: string,
  status: "failed" | "cancelled",
  error: unknown,
) {
  // Action lifecycle errors are already durable plain values, not Error
  // instances. Keep their normalized diagnostic instead of coercing the
  // object to "[object Object]" while projecting it onto the checkpoint.
  const durable = serializedActionError(error);
  const name = error instanceof Error ? error.name : durable?.name ?? "Error";
  const message = error instanceof Error
    ? error.message
    : durable?.message ?? String(error);
  const checkpoint = await context.collections.longTermMemory
    .get({ id: checkpointId });
  if (!checkpoint || checkpoint.status !== "pending") return;
  await context.collections.longTermMemory.update(
    {
      id: checkpointId,
      set: {
        status,
        error: {
          name,
          message,
        },
      },
    },
    { operationKey: `checkpoint:${checkpointId}:${status}` },
  );
}
