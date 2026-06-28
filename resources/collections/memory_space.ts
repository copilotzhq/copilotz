import { defineCollection, relation } from "@/database/collections/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export default defineCollection({
  name: "memory_space",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      kind: { type: "string" },
      ownerNodeId: { type: "string" },
      threadId: { type: "string" },
    },
    required: ["kind", "ownerNodeId", "threadId"],
  } as const,
  indexes: [["kind", "ownerNodeId"], "threadId"],
  relations: {
    items: relation.hasMany(
      "memory_item",
      "memorySpaceId",
      GRAPH_EDGE.HAS_MEMORY_ITEM,
    ),
    checkpoints: relation.hasMany(
      "long_term_memory",
      "memorySpaceId",
      GRAPH_EDGE.HAS_LONG_TERM_MEMORY,
    ),
  },
});
