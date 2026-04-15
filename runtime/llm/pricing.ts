import { get, type RequestResponse } from "@/runtime/http.ts";
import type {
  CostBreakdown,
  ProviderConfig,
  ProviderName,
  TokenUsage,
} from "@/runtime/llm/types.ts";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CACHE_TTL_MS = 60 * 60 * 1000;
const WARN_TTL_MS = 5 * 60 * 1000;

const PROVIDER_ALIASES: Partial<Record<ProviderName, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  deepseek: "deepseek",
  minimax: "minimax",
  xai: "x-ai",
};

interface PricingRates {
  prompt?: number;
  completion?: number;
  internalReasoning?: number;
  inputCacheRead?: number;
  inputCacheWrite?: number;
}

interface CatalogEntry {
  id: string;
  canonicalSlug?: string;
  pricing: PricingRates;
}

interface CatalogIndex {
  fetchedAt: number;
  byId: Map<string, CatalogEntry>;
  byCanonicalSlug: Map<string, CatalogEntry>;
}

type OpenRouterModelsResponse = {
  data?: Array<{
    id?: unknown;
    canonical_slug?: unknown;
    pricing?: {
      prompt?: unknown;
      completion?: unknown;
      internal_reasoning?: unknown;
      input_cache_read?: unknown;
      input_cache_write?: unknown;
    };
  }>;
};

let cachedCatalog: CatalogIndex | null = null;
let catalogPromise: Promise<CatalogIndex | null> | null = null;
const warningTimestamps = new Map<string, number>();

function parseRate(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

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

function normalizeCatalog(
  response: OpenRouterModelsResponse,
): CatalogIndex | null {
  const data = Array.isArray(response?.data) ? response.data : [];
  const byId = new Map<string, CatalogEntry>();
  const byCanonicalSlug = new Map<string, CatalogEntry>();

  for (const item of data) {
    if (typeof item?.id !== "string" || item.id.trim().length === 0) continue;

    const id = item.id.trim();
    const canonicalSlug = typeof item.canonical_slug === "string" &&
        item.canonical_slug.trim().length > 0
      ? item.canonical_slug.trim()
      : undefined;
    const pricing = {
      prompt: parseRate(item?.pricing?.prompt),
      completion: parseRate(item?.pricing?.completion),
      internalReasoning: parseRate(item?.pricing?.internal_reasoning),
      inputCacheRead: parseRate(item?.pricing?.input_cache_read),
      inputCacheWrite: parseRate(item?.pricing?.input_cache_write),
    } satisfies PricingRates;

    const entry: CatalogEntry = {
      id,
      canonicalSlug,
      pricing,
    };

    byId.set(id.toLowerCase(), entry);
    if (canonicalSlug) {
      byCanonicalSlug.set(canonicalSlug.toLowerCase(), entry);
    }
  }

  return {
    fetchedAt: Date.now(),
    byId,
    byCanonicalSlug,
  };
}

async function fetchCatalog(): Promise<CatalogIndex | null> {
  const response = await get<OpenRouterModelsResponse>(OPENROUTER_MODELS_URL, {
    timeout: 15000,
  }) as RequestResponse<OpenRouterModelsResponse>;

  return normalizeCatalog(response.data);
}

async function getCatalog(): Promise<CatalogIndex | null> {
  const now = Date.now();
  if (
    cachedCatalog &&
    now - cachedCatalog.fetchedAt < OPENROUTER_CACHE_TTL_MS
  ) {
    return cachedCatalog;
  }

  if (!catalogPromise) {
    catalogPromise = fetchCatalog()
      .then((catalog) => {
        if (catalog) {
          cachedCatalog = catalog;
        }
        return catalog;
      })
      .catch((error) => {
        warnPricing(
          "openrouter-unavailable",
          "OpenRouter catalog unavailable; cost estimation skipped.",
          error,
        );
        return cachedCatalog;
      })
      .finally(() => {
        catalogPromise = null;
      });
  }

  return await catalogPromise;
}

export function resolvePricingModelCandidates(
  config: Pick<ProviderConfig, "provider" | "model" | "pricingModelId">,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (value: string | undefined): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(trimmed);
  };

  pushCandidate(config.pricingModelId);

  const model = typeof config.model === "string" ? config.model.trim() : "";
  if (model.length === 0) return candidates;

  const alias = config.provider ? PROVIDER_ALIASES[config.provider] : undefined;
  if (alias) {
    pushCandidate(`${alias}/${model}`);
  }

  // Allow vendor-qualified local models to opt into direct catalog matching.
  if (model.includes("/")) {
    pushCandidate(model);
  }

  return candidates;
}

async function resolveCatalogEntry(
  config: Pick<
    ProviderConfig,
    "provider" | "model" | "pricingModelId" | "estimateCost"
  >,
): Promise<CatalogEntry | null> {
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

  const catalog = await getCatalog();
  if (!catalog) return null;

  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    const directMatch = catalog.byId.get(normalized) ??
      catalog.byCanonicalSlug.get(normalized);
    if (directMatch) return directMatch;
  }

  warnPricing(
    `catalog:${config.provider ?? "unknown"}:${config.model ?? "unknown"}`,
    `Model not found in OpenRouter catalog for ${config.provider ?? "unknown"}:${
      config.model ?? "unknown"
    }.`,
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
  entry: CatalogEntry,
): CostBreakdown | null {
  const inputTokens = toNonNegativeInteger(usage.inputTokens);
  const outputTokens = toNonNegativeInteger(usage.outputTokens);
  const reasoningTokens = clamp(
    toNonNegativeInteger(usage.reasoningTokens),
    outputTokens,
  );
  const cacheReadInputTokens = clamp(
    toNonNegativeInteger(usage.cacheReadInputTokens),
    inputTokens,
  );
  const cacheCreationInputTokens = clamp(
    toNonNegativeInteger(usage.cacheCreationInputTokens),
    Math.max(0, inputTokens - cacheReadInputTokens),
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
  if (
    !usage ||
    config.estimateCost === false ||
    usage.source !== "provider"
  ) {
    return null;
  }

  const entry = await resolveCatalogEntry(config);
  if (!entry) return null;

  return computeCost(usage, entry);
}

export function __resetPricingCatalogCacheForTests(): void {
  cachedCatalog = null;
  catalogPromise = null;
  warningTimestamps.clear();
}
