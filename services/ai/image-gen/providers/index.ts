import type { ImageGenerationProviderRegistry, ProviderName } from '../../types.ts';
import { openaiImageGenerationProvider } from './openai.ts';
import { stabilityImageGenerationProvider } from './stability.ts';
import { replicateImageGenerationProvider } from './replicate.ts';

// Registry of all image generation providers
export const imageGenerationProviders: ImageGenerationProviderRegistry = {
  openai: openaiImageGenerationProvider,
  stability: stabilityImageGenerationProvider,
  replicate: replicateImageGenerationProvider,
  // Add more providers here as they're implemented
  // midjourney: midjourneyImageGenerationProvider,
  // leonardo: leonardoImageGenerationProvider,
};

// Get a specific image generation provider
export function getImageGenerationProvider(provider: ProviderName) {
  const providerFactory = imageGenerationProviders[provider];
  if (!providerFactory) {
    throw new Error(`Image generation provider '${provider}' is not supported. Available providers: ${Object.keys(imageGenerationProviders).join(', ')}`);
  }
  return providerFactory;
}

// Check if image generation provider is available
export function isImageGenerationProviderAvailable(provider: ProviderName): boolean {
  return provider in imageGenerationProviders;
}

// Get all available image generation providers
export function getAvailableImageGenerationProviders(): ProviderName[] {
  return Object.keys(imageGenerationProviders) as ProviderName[];
} 

// Export individual providers for direct access
export {
  openaiImageGenerationProvider,
  stabilityImageGenerationProvider,
  replicateImageGenerationProvider,
}; 