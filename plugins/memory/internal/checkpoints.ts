/** Checkpoint creation, ordering, recovery, and failure settlement. @module */
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { MemorySpaceDescriptor } from "../authoring/consolidation/index.ts";
import type { MemoryProcessorContext } from "./contracts.ts";
import { optionalText, record } from "./input.ts";

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

export async function checkpoints(
  context: Pick<MemoryProcessorContext, "collections">,
  threadId: string,
  agentId: string,
  status?: "pending" | "ready" | "failed" | "cancelled",
) {
  const values = await context.collections.longTermMemory.list({
    where: { threadId, agentId, ...(status ? { status } : {}) },
    order: { field: "sequence", direction: "desc" },
    limit: 1_000,
  });
  return (values.filter((item) =>
    item.threadId === threadId && item.agentId === agentId &&
    (!status || item.status === status)
  ).sort((left, right) =>
    checkpointSequence(right) - checkpointSequence(left)
  ));
}

/** Reserve one checkpoint; only the caller may supply certified history coverage. */

export async function createCheckpoint(
  context: MemoryProcessorContext,
  input: Readonly<{
    id?: string;
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
  const sequence = checkpointSequence(
    (await checkpoints(context, threadId, agentId))[0] ?? null,
  ) + 1;
  const id = input.id ?? `memory:${threadId}:${agentId}:${sequence}`;
  try {
    return await context.collections.longTermMemory.create({
      id,
      name: `Thread ${threadId} / ${agentId} / ${sequence}`,
      threadId,
      schemaVersion: "4",
      strategy: "semantic_graph",
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
    const concurrent = input.id
      ? await context.collections.longTermMemory.get({ id })
      : (await checkpoints(context, threadId, agentId, "pending"))[0];
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
