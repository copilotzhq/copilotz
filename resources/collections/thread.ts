/**
 * Thread collection: canonical graph aggregate. There is no physical thread table.
 */
import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@/database/collections/index.ts";
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
      name: { type: ["string", "null"] },
      parentThreadId: { type: ["string", "null"] },
      rootThreadId: { type: ["string", "null"] },
      forkedFromThreadId: { type: ["string", "null"] },
      forkedFromMessageId: { type: ["string", "null"] },
      forkedFromEventId: { type: ["string", "null"] },
      forkedFromAttemptId: { type: ["string", "null"] },
      forkMode: { type: ["string", "null"] },
      lastEventId: { type: ["string", "null"] },
      lastEventPosition: { type: ["string", "null"] },
      lastEventAt: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] },
    },
    required: ["threadId"],
  } as const,
  keys: [{ property: "threadId" }],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: ["threadId", "externalId", "rootThreadId"],
  relations: {
    messages: relation.hasMany("message", "threadId", GRAPH_EDGE.HAS_MESSAGE),
    forks: relation.hasMany("thread", "parentThreadId", GRAPH_EDGE.FORKED_FROM),
  },
}) as CollectionDefinition;
