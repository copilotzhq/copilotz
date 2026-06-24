/**
 * Message collection: conversation messages stored as graph nodes.
 */
import { defineCollection, relation } from "@/database/collections/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export default defineCollection({
  name: "message",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      messageId: { type: "string" },
      content: { type: ["string", "null"] },
      senderId: { type: ["string", "null"] },
      senderType: {
        type: ["string", "null"],
        enum: ["user", "agent", "tool", "system", "job", null],
      },
      senderUserId: { type: ["string", "null"] },
      externalId: { type: ["string", "null"] },
      toolCallId: { type: ["string", "null"] },
      toolCalls: { type: ["array", "null"] },
      reasoning: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] },
    },
    required: ["messageId"],
  } as const,
  keys: [{ property: "messageId" }],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: [
    "messageId",
    "senderId",
  ],
  relations: {
    sender: relation.belongsTo("participant", "senderId", GRAPH_EDGE.SENT_BY),
    replies: relation.hasMany("message", "messageId", GRAPH_EDGE.DERIVED_FROM),
    llmUsage: relation.hasOne("usage", "eventId", GRAPH_EDGE.HAS_LLM_USAGE),
  },
});
