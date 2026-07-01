import { defineCollection, relation } from "@/database/collections/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export default defineCollection({
  name: "memory_item",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      memorySpaceId: { type: "string" },
      checkpointId: { type: "string" },
      createdByAgentId: { type: "string" },
      originThreadId: { type: "string" },
      kind: {
        type: "string",
        enum: [
          "entity",
          "fact",
          "claim",
          "decision",
          "preference",
          "task",
          "event",
          "constraint",
        ],
      },
      name: { type: "string" },
      content: { type: "string" },
      confidence: { type: ["number", "null"] },
      sourceMessageIds: { type: "array", items: { type: "string" } },
      embedding: { type: ["array", "null"] },
    },
    required: [
      "memorySpaceId",
      "checkpointId",
      "createdByAgentId",
      "originThreadId",
      "kind",
      "name",
      "content",
      "sourceMessageIds",
    ],
  } as const,
  indexes: [
    "memorySpaceId",
    "checkpointId",
    "createdByAgentId",
    "originThreadId",
    ["memorySpaceId", "createdByAgentId"],
    "kind",
  ],
  relations: {
    memorySpace: relation.belongsTo(
      "memory_space",
      "memorySpaceId",
      GRAPH_EDGE.HAS_MEMORY_ITEM,
    ),
    checkpoint: relation.belongsTo(
      "long_term_memory",
      "checkpointId",
      GRAPH_EDGE.INCLUDES_MEMORY_ITEM,
    ),
  },
  search: {
    enabled: true,
    fields: ["name", "content"],
  },
});
