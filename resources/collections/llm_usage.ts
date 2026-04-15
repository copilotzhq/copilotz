/**
 * LLM Usage collection: token and cost tracking per LLM call.
 */
import { defineCollection } from "@/database/collections/index.ts";

export default defineCollection({
  name: "llm_usage",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      threadId: { type: ["string", "null"] },
      eventId: { type: ["string", "null"] },
      agentId: { type: ["string", "null"] },
      provider: { type: ["string", "null"] },
      model: { type: ["string", "null"] },
      promptTokens: { type: ["number", "null"] },
      completionTokens: { type: ["number", "null"] },
      totalTokens: { type: ["number", "null"] },
      promptCost: { type: ["number", "null"] },
      completionCost: { type: ["number", "null"] },
      totalCost: { type: ["number", "null"] },
      status: { type: ["string", "null"] },
    },
    required: [],
  } as const,
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: [
    "threadId",
    "provider",
    "model",
  ],
});
