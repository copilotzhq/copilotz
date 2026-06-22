/**
 * Tool execution collection: durable child record of an agent message.
 */
import { defineCollection, relation } from "@/database/collections/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export default defineCollection({
  name: "tool_execution",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      threadId: { type: "string" },
      messageId: { type: ["string", "null"] },
      eventId: { type: ["string", "null"] },
      agentId: { type: ["string", "null"] },
      agentName: { type: ["string", "null"] },
      toolCallId: { type: "string" },
      tool: { type: "object" },
      args: {},
      status: { type: ["string", "null"] },
      output: {},
      projectedOutput: {},
      error: {},
      historyVisibility: { type: ["string", "null"] },
      startedAt: { type: ["string", "null"] },
      finishedAt: { type: ["string", "null"] },
      durationMs: { type: ["number", "null"] },
      metadata: { type: ["object", "null"] },
    },
    required: ["threadId", "toolCallId", "tool"],
  } as const,
  keys: [{ property: "toolCallId" }],
  indexes: ["threadId", "toolCallId", "agentId", "status"],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  relations: {
    message: relation.belongsTo(
      "message",
      "messageId",
      GRAPH_EDGE.HAS_TOOL_EXECUTION,
    ),
    assets: relation.hasMany("asset", "toolCallId", GRAPH_EDGE.HAS_ASSET),
  },
});
