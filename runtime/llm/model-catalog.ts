import { get, type RequestResponse } from "@/runtime/http.ts";
import type { ProviderConfig, ProviderName } from "@/runtime/llm/types.ts";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
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

function stripDateSuffix(model: string): string | null {
  const stripped = model.replace(/-\d{8}$/, "");
  return stripped === model ? null : stripped;
}

function anthropicModelVariants(model: string): string[] {
  const variants: string[] = [];
  const noDate = stripDateSuffix(model);
  if (noDate) variants.push(noDate);

  for (
    const candidate of [model, noDate].filter((value): value is string =>
      typeof value === "string" && value.length > 0
    )
  ) {
    const familyVersion = candidate.replace(
      /^(claude)-(sonnet|opus|haiku)-(\d+)-(\d+)$/,
      "$1-$2-$3.$4",
    );
    if (familyVersion !== candidate) variants.push(familyVersion);

    const versionFamily = candidate.replace(
      /^(claude)-(\d+)-(\d+)-(sonnet|opus|haiku)$/,
      "$1-$4-$2.$3",
    );
    if (versionFamily !== candidate) variants.push(versionFamily);

    const legacyVersion = candidate.replace(
      /^(claude)-(\d+)-(\d+)-(haiku)$/,
      "$1-$2.$3-$4",
    );
    if (legacyVersion !== candidate) variants.push(legacyVersion);
  }

  return variants;
}

export interface PricingRates {
  prompt?: number;
  completion?: number;
  internalReasoning?: number;
  inputCacheRead?: number;
  inputCacheWrite?: number;
}

export interface ModelArchitecture {
  inputModalities: string[];
  outputModalities: string[];
  tokenizer?: string;
  instructType?: string | null;
  modality?: string;
}

export interface ModelCatalogEntry {
  id: string;
  canonicalSlug?: string;
  pricing: PricingRates;
  architecture?: ModelArchitecture;
  supportedParameters: string[];
  contextLength?: number;
  topProvider?: {
    contextLength?: number;
    maxCompletionTokens?: number;
    isModerated?: boolean;
  };
}

interface CatalogIndex {
  fetchedAt: number;
  byId: Map<string, ModelCatalogEntry>;
  byCanonicalSlug: Map<string, ModelCatalogEntry>;
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
    architecture?: {
      input_modalities?: unknown;
      output_modalities?: unknown;
      tokenizer?: unknown;
      instruct_type?: unknown;
      modality?: unknown;
    };
    supported_parameters?: unknown;
    context_length?: unknown;
    top_provider?: {
      context_length?: unknown;
      max_completion_tokens?: unknown;
      is_moderated?: unknown;
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

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function warnCatalog(key: string, message: string, error?: unknown): void {
  const now = Date.now();
  const lastWarning = warningTimestamps.get(key) ?? 0;
  if (now - lastWarning < WARN_TTL_MS) return;

  warningTimestamps.set(key, now);
  console.warn(
    "[llm/model-catalog]",
    message,
    error instanceof Error ? error.message : error ?? "",
  );
}

function normalizeCatalog(
  response: OpenRouterModelsResponse,
): CatalogIndex | null {
  const data = Array.isArray(response?.data) ? response.data : [];
  const byId = new Map<string, ModelCatalogEntry>();
  const byCanonicalSlug = new Map<string, ModelCatalogEntry>();

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

    const architecture = item.architecture &&
        typeof item.architecture === "object"
      ? {
        inputModalities: stringArray(item.architecture.input_modalities),
        outputModalities: stringArray(item.architecture.output_modalities),
        tokenizer: typeof item.architecture.tokenizer === "string"
          ? item.architecture.tokenizer
          : undefined,
        instructType: typeof item.architecture.instruct_type === "string"
          ? item.architecture.instruct_type
          : item.architecture.instruct_type === null
          ? null
          : undefined,
        modality: typeof item.architecture.modality === "string"
          ? item.architecture.modality
          : undefined,
      }
      : undefined;

    const entry: ModelCatalogEntry = {
      id,
      canonicalSlug,
      pricing,
      architecture,
      supportedParameters: stringArray(item.supported_parameters),
      contextLength: finiteNumber(item.context_length),
      topProvider: item.top_provider && typeof item.top_provider === "object"
        ? {
          contextLength: finiteNumber(item.top_provider.context_length),
          maxCompletionTokens: finiteNumber(
            item.top_provider.max_completion_tokens,
          ),
          isModerated: typeof item.top_provider.is_moderated === "boolean"
            ? item.top_provider.is_moderated
            : undefined,
        }
        : undefined,
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
        warnCatalog(
          "openrouter-unavailable",
          "OpenRouter catalog unavailable.",
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

export function resolveModelCatalogCandidates(
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
    if (config.provider === "anthropic") {
      for (const variant of anthropicModelVariants(model)) {
        pushCandidate(`${alias}/${variant}`);
      }
    }
  }

  // Allow vendor-qualified local models to opt into direct catalog matching.
  if (model.includes("/")) {
    pushCandidate(model);
  }

  return candidates;
}

export async function resolveModelCatalogEntry(
  config: Pick<ProviderConfig, "provider" | "model" | "pricingModelId">,
): Promise<ModelCatalogEntry | null> {
  const candidates = resolveModelCatalogCandidates(config);
  if (candidates.length === 0) return null;

  const catalog = await getCatalog();
  if (!catalog) return null;

  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    const directMatch = catalog.byId.get(normalized) ??
      catalog.byCanonicalSlug.get(normalized);
    if (directMatch) return directMatch;
  }

  return null;
}

export function __resetModelCatalogCacheForTests(): void {
  cachedCatalog = null;
  catalogPromise = null;
  warningTimestamps.clear();
}
