import type { VectorWrite } from "@copilotz/copilotz/actions";
/** Atomically commits memory records, relations, and checkpoint readiness. @module */
import type { PreparedContent } from "@copilotz/copilotz/content";
import type { GraphRelationUpsertInput } from "@copilotz/copilotz/collections";
import type { MemoryActionContext } from "../../shared/contracts.ts";

export type MemoryRecordWrite =
  | Readonly<{
    operation: "create";
    record: Readonly<Record<string, unknown>> & { id: string };
  }>
  | Readonly<{
    operation: "update";
    id: string;
    patch: Readonly<Record<string, unknown>>;
  }>;

export type MemoryRelationWrite = Readonly<{
  id: string;
  type: string;
  source: GraphRelationUpsertInput["source"];
  target: GraphRelationUpsertInput["target"];
  metadata?: Readonly<Record<string, unknown>>;
  weight?: number;
}>;

type CommitMemoryConsolidationInput = Readonly<{
  checkpointId: string;
  records: readonly MemoryRecordWrite[];
  vectors: readonly VectorWrite[];
  relations: readonly MemoryRelationWrite[];
  checkpointPatch: Readonly<Record<string, unknown>>;
  checkpointContent: PreparedContent;
}>;

export async function commitMemoryConsolidation(
  context: MemoryActionContext,
  input: CommitMemoryConsolidationInput,
) {
  return await context.transaction(async (tx) => {
    for (const write of input.records) {
      if (write.operation === "create") {
        if (write.record.consolidationId !== input.checkpointId) {
          throw new TypeError(
            `Memory record '${write.record.id}' must belong to checkpoint '${input.checkpointId}'.`,
          );
        }
        await tx.collections.memoryRecord.create(
          write.record as never,
          { operationKey: `memory-record:create:${write.record.id}` },
        );
        continue;
      }
      await tx.collections.memoryRecord.update({
        id: write.id,
        set: write.patch,
      }, { operationKey: `memory-record:update:${write.id}` });
    }

    for (const vector of input.vectors) await tx.vectors.upsert(vector);

    for (const relation of input.relations) {
      await tx.relations.upsert(relation);
    }

    const checkpointPatch: Record<string, unknown> = {
      ...input.checkpointPatch,
      content: input.checkpointContent,
    };
    await tx.collections.longTermMemory.commands.completeConsolidation({
      id: input.checkpointId,
      ...checkpointPatch,
    }, { operationKey: `memory-checkpoint:ready:${input.checkpointId}` });

    return ({
      checkpointId: input.checkpointId,
      createdRecordIds: input.records.flatMap((write) =>
        write.operation === "create" ? [write.record.id] : []
      ),
      updatedRecordIds: input.records.flatMap((write) =>
        write.operation === "update" ? [write.id] : []
      ),
      relationIds: input.relations.map((relation) => relation.id),
    } as const);
  }, { operationKey: `memory:${input.checkpointId}:commit` });
}
