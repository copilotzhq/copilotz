/**
 * Asset collection: first-class metadata for persisted media and files.
 */
import { defineCollection, relation } from "@/database/collections/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export default defineCollection({
  name: "asset",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      threadId: { type: ["string", "null"] },
      ref: { type: ["string", "null"] },
      mime: { type: ["string", "null"] },
      by: { type: ["string", "null"] },
      toolCallId: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] },
    },
    required: [],
  } as const,
  indexes: ["threadId", "ref", "toolCallId"],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  relations: {
    toolExecution: relation.belongsTo(
      "tool_execution",
      "toolCallId",
      GRAPH_EDGE.HAS_ASSET,
    ),
  },
});
