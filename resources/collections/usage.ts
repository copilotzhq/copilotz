/**
 * Usage collection: the unified, source-agnostic cost/metering ledger.
 *
 * One record per cost-incurring operation (LLM call, tool execution, and future
 * resource families). Token/cost fields are stored flat (mirroring the legacy
 * `llm_usage` shape) so admin aggregations remain direct, indexable JSONB path
 * reads, while `kind`/`resource`/`metrics` generalize the record across
 * resource families. Rows are intentionally small — they never carry
 * conversation payloads — so aggregation avoids TOAST detoasting.
 */
import { defineCollection } from "@/database/collections/index.ts";

export default defineCollection({
  name: "usage",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      // Classification
      kind: { type: ["string", "null"] },
      resource: { type: ["string", "null"] },
      provider: { type: ["string", "null"] },
      operation: { type: ["string", "null"] },
      status: { type: ["string", "null"] },
      statusReason: { type: ["string", "null"] },
      model: { type: ["string", "null"] },
      // Scope / attribution (flat for cheap grouping + filtering)
      threadId: { type: ["string", "null"] },
      eventId: { type: ["string", "null"] },
      messageId: { type: ["string", "null"] },
      agentId: { type: ["string", "null"] },
      initiatedById: { type: ["string", "null"] },
      // Generic metering
      metrics: { type: ["object", "null"] },
      // Flat token metering (LLM; null for other kinds)
      inputTokens: { type: ["number", "null"] },
      outputTokens: { type: ["number", "null"] },
      reasoningTokens: { type: ["number", "null"] },
      cacheReadInputTokens: { type: ["number", "null"] },
      cacheCreationInputTokens: { type: ["number", "null"] },
      totalTokens: { type: ["number", "null"] },
      // Flat cost breakdown
      inputCostUsd: { type: ["number", "null"] },
      outputCostUsd: { type: ["number", "null"] },
      reasoningCostUsd: { type: ["number", "null"] },
      cacheReadInputCostUsd: { type: ["number", "null"] },
      cacheCreationInputCostUsd: { type: ["number", "null"] },
      totalCostUsd: { type: ["number", "null"] },
      pricingModelId: { type: ["string", "null"] },
      pricingSource: { type: ["string", "null"] },
      pricingCurrency: { type: ["string", "null"] },
      // Provenance / dedupe
      source: { type: ["string", "null"] },
      rawUsage: { type: ["object", "null"] },
      stopSequence: { type: ["string", "null"] },
      dedupeKey: { type: ["string", "null"] },
      occurredAt: { type: ["string", "null"] },
      metricsFinalizedAt: { type: ["string", "null"] },
    },
    required: [],
  } as const,
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: [
    "kind",
    "threadId",
    "provider",
    "model",
    "agentId",
    "dedupeKey",
  ],
});
