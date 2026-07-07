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
      memorySpaceId: { type: ["string", "null"] },
      readMemorySpaceIds: { type: "array", items: { type: "string" } },
      writeMemorySpaceIds: { type: "array", items: { type: "string" } },
      defaultWriteMemorySpaceId: { type: ["string", "null"] },
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
      "sequence",
      "agentId",
      "sourceStartMessageId",
      "sourceEndMessageId",
    ],
  } as const,
  indexes: [
    "threadId",
    "memorySpaceId",
    "defaultWriteMemorySpaceId",
    ["threadId", "agentId", "status", "sequence"],
    ["memorySpaceId", "status", "sequence"],
  ],
  relations: {
    brainNodes: relation.hasMany(
      "brain_node",
      "checkpointId",
      GRAPH_EDGE.INCLUDES_BRAIN_NODE,
    ),
  },
});
