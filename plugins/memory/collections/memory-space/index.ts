/** Durable memory-space collection definition. @module */
import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";
import { MEMORY_EDGE } from "../internal/relations.ts";

const schema = {
  type: "object",
  properties: {
    id: { type: "string" },
    scopeType: { type: "string" },
    scopeId: { type: "string" },
    kind: { type: ["string", "null"] },
    ownerNodeId: { type: ["string", "null"] },
    threadId: { type: ["string", "null"] },
    access: { type: ["string", "null"], enum: ["read", "read_write", null] },
    defaultWrite: { type: ["boolean", "null"] },
    description: { type: ["string", "null"] },
    metadata: { type: ["object", "null"] },
  },
  required: ["scopeType", "scopeId"],
} as const;

export const memorySpaceCollection: CollectionDefinition<typeof schema> =
  defineCollection({
    name: "memory_space",
    schema: schema,
    indexes: [["scopeType", "scopeId"], ["kind", "ownerNodeId"], "threadId", [
      "threadId",
      "access",
      "defaultWrite",
    ]],
    relations: {
      thread: relation.belongsTo("thread", "threadId", MEMORY_EDGE.usesSpace),
      records: relation.hasMany(
        "memory_record",
        "memorySpaceId",
        MEMORY_EDGE.hasRecord,
      ),
    },
  });

export default memorySpaceCollection;
