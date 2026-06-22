/**
 * Thread collection: semantic graph aggregate for an operational thread row.
 */
import { defineCollection, relation } from "@/database/collections/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export default defineCollection({
  name: "thread",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      threadId: { type: "string" },
      externalId: { type: ["string", "null"] },
      status: { type: ["string", "null"] },
      participants: { type: ["array", "null"] },
      parentThreadId: { type: ["string", "null"] },
      rootThreadId: { type: ["string", "null"] },
      forkedFromThreadId: { type: ["string", "null"] },
      forkedFromMessageId: { type: ["string", "null"] },
      forkedFromEventId: { type: ["string", "null"] },
      forkedFromAttemptId: { type: ["string", "null"] },
      forkMode: { type: ["string", "null"] },
      originTraceId: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] },
    },
    required: ["threadId"],
  } as const,
  keys: [{ property: "threadId" }],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: ["threadId", "externalId", "rootThreadId"],
  relations: {
    messages: relation.hasMany("message", "messageId", GRAPH_EDGE.HAS_MESSAGE),
    forks: relation.hasMany("thread", "threadId", GRAPH_EDGE.FORKED_FROM),
  },
});
