/**
 * LLM attempt collection: canonical accounting and recovery record for each
 * provider attempt.
 */
import { defineCollection, relation } from "@/database/collections/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export default defineCollection({
  name: "llm_attempt",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      threadId: { type: "string" },
      messageId: { type: ["string", "null"] },
      eventId: { type: ["string", "null"] },
      agentId: { type: ["string", "null"] },
      agentName: { type: ["string", "null"] },
      provider: { type: ["string", "null"] },
      model: { type: ["string", "null"] },
      config: { type: ["object", "null"] },
      messages: { type: ["array", "null"] },
      tools: { type: ["array", "null"] },
      status: { type: ["string", "null"] },
      finishReason: { type: ["string", "null"] },
      answer: { type: ["string", "null"] },
      reasoning: { type: ["string", "null"] },
      partialAnswer: { type: ["string", "null"] },
      partialReasoning: { type: ["string", "null"] },
      toolCalls: { type: ["array", "null"] },
      usage: { type: ["object", "null"] },
      cost: { type: ["object", "null"] },
      error: { type: ["object", "null"] },
      attemptIndex: { type: ["number", "null"] },
      parentAttemptId: { type: ["string", "null"] },
      runSender: { type: ["object", "null"] },
      startedAt: { type: ["string", "null"] },
      finishedAt: { type: ["string", "null"] },
      metricsFinalizedAt: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] },
    },
    required: ["threadId"],
  } as const,
  indexes: ["threadId", "eventId", "agentId", "provider", "model", "status"],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  relations: {
    message: relation.belongsTo(
      "message",
      "messageId",
      GRAPH_EDGE.HAS_LLM_ATTEMPT,
    ),
  },
});
