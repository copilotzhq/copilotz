import type {
  CostBreakdown,
  ProviderConfig,
  TokenUsage,
} from "@/runtime/llm/types.ts";
import {
  __resetModelCatalogCacheForTests,
  type ModelCatalogEntry,
  resolveModelCatalogCandidates,
  resolveModelCatalogEntry,
} from "@/runtime/llm/model-catalog.ts";

const WARN_TTL_MS = 5 * 60 * 1000;
const warningTimestamps = new Map<string, number>();

function roundUsd(value: number): number {
  return Number(value.toFixed(12));
}

function warnPricing(key: string, message: string, error?: unknown): void {
  const now = Date.now();
  const lastWarning = warningTimestamps.get(key) ?? 0;
  if (now - lastWarning < WARN_TTL_MS) return;

  warningTimestamps.set(key, now);
  console.warn(
    "[llm/pricing]",
    message,
    error instanceof Error ? error.message : error ?? "",
  );
}

export function resolvePricingModelCandidates(
  config: Pick<ProviderConfig, "provider" | "model" | "pricingModelId">,
): string[] {
  return resolveModelCatalogCandidates(config);
}

async function resolveCatalogEntry(
  config: Pick<
    ProviderConfig,
    "provider" | "model" | "pricingModelId" | "estimateCost"
  >,
): Promise<ModelCatalogEntry | null> {
  if (config.estimateCost === false) return null;

  const candidates = resolvePricingModelCandidates(config);
  if (candidates.length === 0) {
    warnPricing(
      `mapping:${config.provider ?? "unknown"}:${config.model ?? "unknown"}`,
      `No pricing mapping for ${config.provider ?? "unknown"}:${
        config.model ?? "unknown"
      }.`,
    );
    return null;
  }

  const entry = await resolveModelCatalogEntry(config);
  if (entry) return entry;

  warnPricing(
    `catalog:${config.provider ?? "unknown"}:${config.model ?? "unknown"}`,
    `Model not found in OpenRouter catalog for ${
      config.provider ?? "unknown"
    }:${config.model ?? "unknown"}.`,
  );
  return null;
}

function toNonNegativeInteger(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

function computeCost(
  usage: TokenUsage,
  entry: ModelCatalogEntry,
): CostBreakdown | null {
  const inputTokens = toNonNegativeInteger(usage.inputTokens);
  const outputTokens = toNonNegativeInteger(usage.outputTokens);
  const reasoningTokens = clamp(
    toNonNegativeInteger(usage.reasoningTokens),
    outputTokens,
  );
  const cacheReadInputTokens = toNonNegativeInteger(
    usage.cacheReadInputTokens,
  );
  const cacheCreationInputTokens = toNonNegativeInteger(
    usage.cacheCreationInputTokens,
  );

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    reasoningTokens === 0 &&
    cacheReadInputTokens === 0 &&
    cacheCreationInputTokens === 0
  ) {
    return null;
  }

  const hasReasoningRate = typeof entry.pricing.internalReasoning === "number";
  const hasCacheReadRate = typeof entry.pricing.inputCacheRead === "number";
  const hasCacheWriteRate = typeof entry.pricing.inputCacheWrite === "number";

  const billableInputTokens = Math.max(
    0,
    inputTokens -
      (hasCacheReadRate ? cacheReadInputTokens : 0) -
      (hasCacheWriteRate ? cacheCreationInputTokens : 0),
  );
  const billableOutputTokens = Math.max(
    0,
    outputTokens - (hasReasoningRate ? reasoningTokens : 0),
  );

  const inputCostUsd = typeof entry.pricing.prompt === "number"
    ? roundUsd(billableInputTokens * entry.pricing.prompt)
    : undefined;
  const outputCostUsd = typeof entry.pricing.completion === "number"
    ? roundUsd(billableOutputTokens * entry.pricing.completion)
    : undefined;
  const reasoningCostUsd = hasReasoningRate
    ? roundUsd(reasoningTokens * entry.pricing.internalReasoning!)
    : undefined;
  const cacheReadInputCostUsd = hasCacheReadRate
    ? roundUsd(cacheReadInputTokens * entry.pricing.inputCacheRead!)
    : undefined;
  const cacheCreationInputCostUsd = hasCacheWriteRate
    ? roundUsd(cacheCreationInputTokens * entry.pricing.inputCacheWrite!)
    : undefined;

  const totalCostUsd = roundUsd(
    (inputCostUsd ?? 0) +
      (outputCostUsd ?? 0) +
      (reasoningCostUsd ?? 0) +
      (cacheReadInputCostUsd ?? 0) +
      (cacheCreationInputCostUsd ?? 0),
  );

  return {
    source: "openrouter",
    currency: "USD",
    pricingModelId: entry.id,
    ...(inputCostUsd !== undefined ? { inputCostUsd } : {}),
    ...(outputCostUsd !== undefined ? { outputCostUsd } : {}),
    ...(reasoningCostUsd !== undefined ? { reasoningCostUsd } : {}),
    ...(cacheReadInputCostUsd !== undefined ? { cacheReadInputCostUsd } : {}),
    ...(cacheCreationInputCostUsd !== undefined
      ? { cacheCreationInputCostUsd }
      : {}),
    totalCostUsd,
  };
}

export async function estimateUsageCost(
  config: Pick<
    ProviderConfig,
    "provider" | "model" | "pricingModelId" | "estimateCost"
  >,
  usage: TokenUsage | undefined,
): Promise<CostBreakdown | null> {
  if (!usage || config.estimateCost === false) {
    return null;
  }

  const entry = await resolveCatalogEntry(config);
  if (!entry) return null;

  return computeCost(usage, entry);
}

export function __resetPricingCatalogCacheForTests(): void {
  __resetModelCatalogCacheForTests();
  warningTimestamps.clear();
}
