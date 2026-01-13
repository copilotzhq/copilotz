import type { 
  EmbeddingProviderRegistry, 
  EmbeddingProviderName, 
  EmbeddingProviderFactory 
} from "../types.ts";
import { openaiEmbeddingProvider, OPENAI_EMBEDDING_DIMENSIONS } from "./openai.ts";

// Provider registry with all available embedding providers
export const embeddingProviders: EmbeddingProviderRegistry = {
  openai: openaiEmbeddingProvider,
  // Future: ollama, cohere
};

/**
 * Get an embedding provider by name
 */
export function getEmbeddingProvider(name: EmbeddingProviderName): EmbeddingProviderFactory {
  const provider = embeddingProviders[name];
  if (!provider) {
    throw new Error(
      `Embedding provider '${name}' is not supported. Available providers: ${Object.keys(embeddingProviders).join(", ")}`
    );
  }
  return provider;
}

/**
 * Get list of available embedding provider names
 */
export function getAvailableEmbeddingProviders(): EmbeddingProviderName[] {
  return Object.keys(embeddingProviders) as EmbeddingProviderName[];
}

/**
 * Check if an embedding provider is available
 */
export function isEmbeddingProviderAvailable(name: string): name is EmbeddingProviderName {
  return name in embeddingProviders;
}

/**
 * Get provider default configurations
 */
export function getEmbeddingProviderDefaults(): Record<
  EmbeddingProviderName,
  { model: string; dimensions: number; apiKeyEnv: string }
> {
  return {
    openai: {
      model: "text-embedding-3-small",
      dimensions: 1536,
      apiKeyEnv: "OPENAI_API_KEY",
    },
    ollama: {
      model: "nomic-embed-text",
      dimensions: 768,
      apiKeyEnv: "OLLAMA_BASE_URL",
    },
    cohere: {
      model: "embed-english-v3.0",
      dimensions: 1024,
      apiKeyEnv: "COHERE_API_KEY",
    },
  };
}

// Export individual providers for direct access
export { openaiEmbeddingProvider, OPENAI_EMBEDDING_DIMENSIONS };

