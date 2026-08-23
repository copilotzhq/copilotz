import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections";

const usageSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: ["string", "null"] },
    resource: { type: ["string", "null"] },
    provider: { type: ["string", "null"] },
    adapter: { type: ["string", "null"] },
    providerModel: { type: ["string", "null"] },
    operation: { type: ["string", "null"] },
    status: { type: ["string", "null"] },
    statusReason: { type: ["string", "null"] },
    model: { type: ["string", "null"] },
    threadId: { type: ["string", "null"] },
    eventId: { type: ["string", "null"] },
    messageId: { type: ["string", "null"] },
    agentId: { type: ["string", "null"] },
    initiatedById: { type: ["string", "null"] },
    metrics: { type: ["object", "null"] },
    inputTokens: { type: ["number", "null"] },
    outputTokens: { type: ["number", "null"] },
    reasoningTokens: { type: ["number", "null"] },
    cachedInputTokens: { type: ["number", "null"] },
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
    stopSequence: { type: ["string", "null"] },
    dedupeKey: { type: ["string", "null"] },
    occurredAt: { type: ["string", "null"] },
    metricsFinalizedAt: { type: ["string", "null"] },
  },
  required: [],
} as const;

/**
 * Compact, source-agnostic usage ledger.
 *
 * Usage records intentionally contain metering and attribution only. Prompt,
 * response, tool argument, and tool output payloads stay in their canonical
 * domain records/assets and are never copied into this collection.
 */
export const usageCollection: CollectionDefinition<typeof usageSchema> =
  defineCollection({
    name: "usage",
    schema: usageSchema,
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
    indexes: [
      "kind",
      "threadId",
      "provider",
      "adapter",
      "model",
      "providerModel",
      "agentId",
      "dedupeKey",
    ],
  });

export default usageCollection;
