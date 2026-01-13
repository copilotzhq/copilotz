/**
 * Embedding connector types
 * 
 * Provides a unified interface for generating vector embeddings across providers.
 */

// Supported embedding providers
export type EmbeddingProviderName = "openai" | "ollama" | "cohere";

// Embedding configuration
export interface EmbeddingConfig {
  provider: EmbeddingProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
  batchSize?: number;
}

// Request for embedding generation
export interface EmbeddingRequest {
  texts: string[];
  config?: Partial<EmbeddingConfig>;
}

// Response from embedding generation
export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  dimensions: number;
  usage?: {
    promptTokens: number;
    totalTokens: number;
  };
}

// Provider API interface
export interface EmbeddingProviderAPI {
  endpoint: string;
  headers: (config: EmbeddingConfig) => Record<string, string>;
  body: (texts: string[], config: EmbeddingConfig) => unknown;
  extractEmbeddings: (data: unknown) => number[][];
  extractUsage?: (data: unknown) => { promptTokens: number; totalTokens: number } | undefined;
}

// Provider factory function
export interface EmbeddingProviderFactory {
  (config: EmbeddingConfig): EmbeddingProviderAPI;
}

// Provider registry
export interface EmbeddingProviderRegistry {
  [key: string]: EmbeddingProviderFactory;
}

