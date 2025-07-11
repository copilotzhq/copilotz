import type { EmbeddingProviderRegistry, ProviderName } from '../../types.ts';
import { openaiEmbeddingProvider } from './openai.ts';
import { cohereEmbeddingProvider } from './cohere.ts';
import { huggingfaceEmbeddingProvider } from './huggingface.ts';

// Registry of all embedding providers
export const embeddingProviders: EmbeddingProviderRegistry = {
  openai: openaiEmbeddingProvider,
  cohere: cohereEmbeddingProvider,
  huggingface: huggingfaceEmbeddingProvider,
  // Add more providers here as they're implemented
  // anthropic: anthropicEmbeddingProvider,
};

// Get a specific embedding provider
export function getEmbeddingProvider(provider: ProviderName) {
  const providerFactory = embeddingProviders[provider];
  if (!providerFactory) {
    throw new Error(`Embedding provider '${provider}' is not supported. Available providers: ${Object.keys(embeddingProviders).join(', ')}`);
  }
  return providerFactory;
}

// Check if embedding provider is available
export function isEmbeddingProviderAvailable(provider: ProviderName): boolean {
  return provider in embeddingProviders;
}

// Get all available embedding providers
export function getAvailableEmbeddingProviders(): ProviderName[] {
  return Object.keys(embeddingProviders) as ProviderName[];
} 

// Export individual providers for direct access
export {
  openaiEmbeddingProvider,
  cohereEmbeddingProvider,
  huggingfaceEmbeddingProvider,
}; 