/**
 * Embedding Connector
 * 
 * Unified interface for generating vector embeddings across providers.
 * Follows the same pattern as the LLM connector.
 */

import type { 
  EmbeddingConfig, 
  EmbeddingResponse,
  EmbeddingProviderFactory,
  EmbeddingProviderRegistry,
} from "@/runtime/embeddings/types.ts";
import { post, type RequestResponse } from "@/runtime/http.ts";

export type { 
  EmbeddingConfig, 
  EmbeddingRequest, 
  EmbeddingResponse,
  EmbeddingProviderName,
  EmbeddingProviderAPI,
  EmbeddingProviderFactory,
} from "@/runtime/embeddings/types.ts";

export { 
  getEmbeddingProvider, 
  getAvailableEmbeddingProviders,
  isEmbeddingProviderAvailable,
  getEmbeddingProviderDefaults,
} from "@/runtime/embeddings/registry.ts";

let defaultEmbeddingRegistryPromise:
  Promise<typeof import("@/runtime/embeddings/registry.ts")> | undefined;

async function getEmbeddingRegistryModule(
  registry?: EmbeddingProviderRegistry,
): Promise<{
  registry: EmbeddingProviderRegistry;
  defaults: Record<string, { model: string; dimensions: number; apiKeyEnv: string }>;
}> {
  if (registry) {
    const mod = await import("@/runtime/embeddings/registry.ts");
    return { registry, defaults: mod.getEmbeddingProviderDefaults() };
  }
  if (!defaultEmbeddingRegistryPromise) {
    defaultEmbeddingRegistryPromise = import("@/runtime/embeddings/registry.ts");
  }
  const mod = await defaultEmbeddingRegistryPromise;
  return {
    registry: mod.embeddingProviders,
    defaults: mod.getEmbeddingProviderDefaults(),
  };
}

/**
 * Get environment variable (runtime-agnostic)
 */
function getEnvVar(key: string): string | undefined {
  try {
    const anyGlobal = globalThis as unknown as {
      Deno?: { env?: { get?: (k: string) => string | undefined } };
      process?: { env?: Record<string, string | undefined> };
    };
    const fromDeno = anyGlobal?.Deno?.env?.get?.(key);
    if (typeof fromDeno === "string") return fromDeno;
    const fromNode = anyGlobal?.process?.env?.[key];
    if (typeof fromNode === "string") return fromNode;
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Truncate text to fit within token limit.
 * Uses very conservative approximation of 2.5 characters per token to safely
 * handle code, URLs, punctuation, and other short tokens.
 * 
 * Examples:
 * - 7500 tokens × 2.5 = 18,750 chars → ~7,500 tokens (safe)
 * - Worst case (2 chars/token): 18,750 ÷ 2 = 9,375 tokens (still exceeds 8192)
 * - Need even more conservative: 2 chars/token
 */
function truncateToTokenLimit(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 2; // Very conservative: ~2 chars per token
  if (text.length <= maxChars) {
    return text;
  }
  // Truncate and add ellipsis to indicate truncation
  return text.slice(0, maxChars - 3) + "...";
}

/**
 * Generate embeddings for an array of texts
 * 
 * @param texts - Array of text strings to embed
 * @param config - Embedding configuration
 * @param env - Optional environment variables for API keys
 * @returns Embedding response with vectors
 * 
 * @example
 * ```typescript
 * const response = await embed(
 *   ["Hello world", "How are you?"],
 *   { provider: "openai", model: "text-embedding-3-small" }
 * );
 * console.log(response.embeddings); // [[0.1, 0.2, ...], [0.3, 0.4, ...]]
 * ```
 */
export async function embed(
  texts: string[],
  config: EmbeddingConfig,
  env: Record<string, string> = {},
  providerRegistry?: EmbeddingProviderRegistry,
): Promise<EmbeddingResponse> {
  if (!texts.length) {
    return {
      embeddings: [],
      model: config.model,
      dimensions: config.dimensions ?? 0,
    };
  }

  // Truncate texts to fit within token limit (default 7500 tokens, safe buffer for 8192 limit)
  const maxInputTokens = config.maxInputTokens ?? 7500;
  const truncatedTexts = texts.map(text => truncateToTokenLimit(text, maxInputTokens));

  const provider = config.provider;
  const { registry, defaults: defaultConfigMap } = await getEmbeddingRegistryModule(
    providerRegistry,
  );
  const defaults = defaultConfigMap[provider];

  // Merge configuration with defaults and environment
  const mergedConfig: EmbeddingConfig = {
    ...config,
    model: config.model || defaults?.model || "text-embedding-3-small",
    apiKey: config.apiKey || 
      env[defaults?.apiKeyEnv ?? ""] || 
      getEnvVar(defaults?.apiKeyEnv ?? "") ||
      env.OPENAI_API_KEY ||
      getEnvVar("OPENAI_API_KEY"),
    dimensions: config.dimensions || defaults?.dimensions,
  };

  // Get provider API
  const providerFactory = registry[provider] as EmbeddingProviderFactory | undefined;
  if (!providerFactory) {
    throw new Error(
      `Embedding provider '${provider}' is not supported. Available providers: ${
        Object.keys(registry).join(", ")
      }`,
    );
  }
  const providerAPI = providerFactory(mergedConfig);

  // Process in batches if needed
  const batchSize = config.batchSize ?? 100;
  const allEmbeddings: number[][] = [];
  let totalPromptTokens = 0;
  let totalTokens = 0;

  for (let i = 0; i < truncatedTexts.length; i += batchSize) {
    const batch = truncatedTexts.slice(i, i + batchSize);

    // Make API request
    const response = await post(
      providerAPI.endpoint,
      providerAPI.body(batch, mergedConfig),
      {
        headers: providerAPI.headers(mergedConfig),
      }
    ) as RequestResponse;

    // Extract embeddings from response
    const embeddings = providerAPI.extractEmbeddings(response.data);
    allEmbeddings.push(...embeddings);

    // Extract usage if available
    if (providerAPI.extractUsage) {
      const usage = providerAPI.extractUsage(response.data);
      if (usage) {
        totalPromptTokens += usage.promptTokens;
        totalTokens += usage.totalTokens;
      }
    }
  }

  // Determine dimensions from first embedding
  const dimensions = allEmbeddings[0]?.length ?? config.dimensions ?? 0;

  return {
    embeddings: allEmbeddings,
    model: mergedConfig.model,
    dimensions,
    usage: totalPromptTokens > 0 ? {
      promptTokens: totalPromptTokens,
      totalTokens: totalTokens,
    } : undefined,
  };
}

/**
 * Generate a single embedding for a text string
 * 
 * @param text - Text string to embed
 * @param config - Embedding configuration
 * @param env - Optional environment variables
 * @returns Single embedding vector
 */
export async function embedOne(
  text: string,
  config: EmbeddingConfig,
  env: Record<string, string> = {},
  providerRegistry?: EmbeddingProviderRegistry,
): Promise<number[]> {
  const response = await embed([text], config, env, providerRegistry);
  if (!response.embeddings.length) {
    throw new Error("No embedding generated");
  }
  return response.embeddings[0];
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same length");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Calculate euclidean distance between two vectors
 */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same length");
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}
