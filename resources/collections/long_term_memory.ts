import { defineCollection, relation } from "@/database/collections/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export default defineCollection({
  name: "long_term_memory",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      threadId: { type: "string" },
      schemaVersion: { type: "string" },
      strategy: { type: "string" },
      status: {
        type: "string",
        enum: ["pending", "ready", "failed"],
      },
      memorySpaceId: { type: "string" },
      sequence: { type: "number" },
      agentId: { type: "string" },
      sourceStartMessageId: { type: "string" },
      sourceEndMessageId: { type: "string" },
      content: { type: ["string", "null"] },
      embedding: { type: ["array", "null"] },
      contentHash: { type: ["string", "null"] },
      tokenEstimate: { type: ["number", "null"] },
      error: { type: ["object", "null"] },
      metadata: { type: ["object", "null"] },
    },
    required: [
      "threadId",
      "schemaVersion",
      "strategy",
      "status",
      "memorySpaceId",
      "sequence",
      "agentId",
      "sourceStartMessageId",
      "sourceEndMessageId",
    ],
  } as const,
  indexes: [
    "threadId",
    "memorySpaceId",
    ["threadId", "agentId", "status", "sequence"],
    ["memorySpaceId", "status", "sequence"],
  ],
  relations: {
    memorySpace: relation.belongsTo(
      "memory_space",
      "memorySpaceId",
      GRAPH_EDGE.HAS_LONG_TERM_MEMORY,
    ),
    items: relation.hasMany(
      "memory_item",
      "checkpointId",
      GRAPH_EDGE.INCLUDES_MEMORY_ITEM,
    ),
  },
});
