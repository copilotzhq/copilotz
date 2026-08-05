/**
 * Message collection: conversation messages stored as graph nodes.
 */
import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@/database/collections/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export default defineCollection({
  name: "message",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      messageId: { type: "string" },
      threadId: { type: "string" },
      content: { type: ["string", "null"] },
      senderId: { type: ["string", "null"] },
      senderType: {
        type: ["string", "null"],
        enum: ["user", "agent", "tool", "system", "job", null],
      },
      targetId: { type: ["string", "null"] },
      senderUserId: { type: ["string", "null"] },
      externalId: { type: ["string", "null"] },
      toolCallId: { type: ["string", "null"] },
      toolCalls: { type: ["array", "null"] },
      reasoning: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["messageId", "threadId", "senderId", "senderType"],
  } as const,
  keys: [{ property: "messageId" }],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: [
    "messageId",
    "threadId",
    "senderId",
    "targetId",
  ],
  relations: {
    sender: relation.belongsTo("participant", "senderId", GRAPH_EDGE.SENT_BY),
    replies: relation.hasMany("message", "messageId", GRAPH_EDGE.DERIVED_FROM),
    usage: relation.hasOne("usage", "eventId", GRAPH_EDGE.HAS_USAGE),
  },
}) as CollectionDefinition;
