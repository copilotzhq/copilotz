import type { EmbeddingProviderFactory, EmbeddingConfig } from "../types.ts";

/**
 * OpenAI Embeddings Provider
 * 
 * Supports:
 * - text-embedding-3-small (1536 dimensions, default)
 * - text-embedding-3-large (3072 dimensions)
 * - text-embedding-ada-002 (1536 dimensions, legacy)
 */
export const openaiEmbeddingProvider: EmbeddingProviderFactory = (config: EmbeddingConfig) => {
  const baseUrl = config.baseUrl || "https://api.openai.com";
  
  return {
    endpoint: `${baseUrl}/v1/embeddings`,

    headers: (config: EmbeddingConfig) => ({
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    }),

    body: (texts: string[], config: EmbeddingConfig) => {
      const body: Record<string, unknown> = {
        model: config.model || "text-embedding-3-small",
        input: texts,
      };

      // Optional: specify dimensions for text-embedding-3-* models
      if (config.dimensions && config.model?.includes("text-embedding-3")) {
        body.dimensions = config.dimensions;
      }

      return body;
    },

    extractEmbeddings: (data: unknown): number[][] => {
      const response = data as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };

      if (!response.data || !Array.isArray(response.data)) {
        throw new Error("Invalid OpenAI embeddings response: missing data array");
      }

      // Sort by index to ensure correct order
      const sorted = [...response.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      
      return sorted.map((item) => {
        if (!item.embedding || !Array.isArray(item.embedding)) {
          throw new Error("Invalid OpenAI embeddings response: missing embedding");
        }
        return item.embedding;
      });
    },

    extractUsage: (data: unknown) => {
      const response = data as {
        usage?: { prompt_tokens?: number; total_tokens?: number };
      };

      if (response.usage) {
        return {
          promptTokens: response.usage.prompt_tokens ?? 0,
          totalTokens: response.usage.total_tokens ?? 0,
        };
      }
      return undefined;
    },
  };
};

// Default model dimensions for reference
export const OPENAI_EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

