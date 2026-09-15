/** Inspects one accessible semantic-memory record. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import { MEMORY_RELATION_TYPES } from "../../authoring/ontology/index.ts";
import { memoryRecordCollection } from "../../collections/memory-record/index.ts";
import type { MemoryActionContext } from "../../internal/contracts.ts";
import {
  memoryActionProvenance,
  threadMemorySpaces,
} from "../../internal/access.ts";
import { memoryRecord } from "../../internal/retrieval.ts";
import { record, requiredText } from "../../internal/input.ts";
import {
  inspectMemoryOutputSchema,
  PUBLIC_MEMORY_RELATION_LIMIT,
  PUBLIC_MEMORY_SCAN_LIMIT,
  publicMemoryDetail,
} from "../internal/public-projection.ts";

export function createInspectMemoryAction(): ActionDefinition<
  unknown,
  unknown,
  MemoryActionContext,
  ActionSchema,
  typeof inspectMemoryOutputSchema
> {
  return defineAction({
    id: "copilotz.memory.inspect",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: inspectMemoryOutputSchema,
    async execute(raw, context) {
      const id = requiredText(record(raw).id, "Memory id");
      const item = await context.collections.memoryRecord.get({ id });
      if (!item) throw new Error(`Memory '${id}' was not found.`);
      const mapped = memoryRecord(item);
      if (!mapped) throw new Error(`Memory '${id}' is not inspectable.`);
      const spaces = new Set(
        (await threadMemorySpaces(
          context,
          memoryActionProvenance(context).threadId,
        )).map((space) => space.id),
      );
      if (!spaces.has(mapped.memorySpaceId)) {
        throw new Error(`Memory '${id}' is not accessible from this thread.`);
      }
      const relations = await context.collections.memoryRecord.relations.list({
        id,
        direction: "both",
        limit: PUBLIC_MEMORY_SCAN_LIMIT,
      });
      const candidateRecords = await context.collections.memoryRecord.list({
        filter: { field: "memorySpaceId", in: [...spaces] },
        limit: PUBLIC_MEMORY_SCAN_LIMIT,
      });
      const accessibleMemoryIds = new Set(
        candidateRecords.filter((candidate) =>
          spaces.has(String(candidate.memorySpaceId))
        ).map((candidate) => candidate.id),
      );
      const visibleRelations = relations.filter((relation) =>
        MEMORY_RELATION_TYPES.includes(
          relation.type as typeof MEMORY_RELATION_TYPES[number],
        ) &&
        (relation.source.type !== memoryRecordCollection.name ||
          accessibleMemoryIds.has(relation.source.id)) &&
        (relation.target.type !== memoryRecordCollection.name ||
          accessibleMemoryIds.has(relation.target.id))
      );
      const projectedRelations = visibleRelations.map((relation) => {
        const outgoing = relation.source.type === memoryRecordCollection.name &&
          relation.source.id === id;
        const other = outgoing ? relation.target : relation.source;
        return {
          type: relation.type,
          direction: outgoing ? "outgoing" as const : "incoming" as const,
          other: {
            type: other.type === memoryRecordCollection.name
              ? "memory"
              : other.type,
            id: other.id,
          },
        };
      });
      const items = projectedRelations.slice(0, PUBLIC_MEMORY_RELATION_LIMIT);
      return {
        memory: publicMemoryDetail(item, mapped),
        relations: {
          items: items,
          scanned: relations.length,
          matched: visibleRelations.length,
          returned: items.length,
          truncated: relations.length >= PUBLIC_MEMORY_SCAN_LIMIT ||
            candidateRecords.length >= PUBLIC_MEMORY_SCAN_LIMIT ||
            items.length < projectedRelations.length,
        },
      };
    },
  });
}
