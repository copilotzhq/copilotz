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
      inputTokens: { type: ["number", "null"] },
      outputTokens: { type: ["number", "null"] },
      reasoningTokens: { type: ["number", "null"] },
      cacheReadInputTokens: { type: ["number", "null"] },
      cacheCreationInputTokens: { type: ["number", "null"] },
      totalTokens: { type: ["number", "null"] },
      inputCostUsd: { type: ["number", "null"] },
      outputCostUsd: { type: ["number", "null"] },
      reasoningCostUsd: { type: ["number", "null"] },
      cacheReadInputCostUsd: { type: ["number", "null"] },
      cacheCreationInputCostUsd: { type: ["number", "null"] },
      totalCostUsd: { type: ["number", "null"] },
      pricingModelId: { type: ["string", "null"] },
      pricingSource: { type: ["string", "null"] },
      pricingCurrency: { type: ["string", "null"] },
      source: { type: ["string", "null"] },
      rawUsage: { type: ["object", "null"] },
      status: { type: ["string", "null"] },
      statusReason: { type: ["string", "null"] },
      stopSequence: { type: ["string", "null"] },
      metricsFinalizedAt: { type: ["string", "null"] },
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
