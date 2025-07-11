import type { TextToSpeechProviderRegistry, ProviderName } from '../../types.ts';
import { openaiTextToSpeechProvider } from './openai.ts';
import { elevenlabsTextToSpeechProvider } from './elevenlabs.ts';
import { azureTextToSpeechProvider } from './azure.ts';

// Registry of all text-to-speech providers
export const textToSpeechProviders: TextToSpeechProviderRegistry = {
  openai: openaiTextToSpeechProvider,
  elevenlabs: elevenlabsTextToSpeechProvider,
  azure: azureTextToSpeechProvider,
  // Add more providers here as they're implemented
  // google: googleTextToSpeechProvider,
};

// Get a specific text-to-speech provider
export function getTextToSpeechProvider(provider: ProviderName) {
  const providerFactory = textToSpeechProviders[provider];
  if (!providerFactory) {
    throw new Error(`Text-to-speech provider '${provider}' is not supported. Available providers: ${Object.keys(textToSpeechProviders).join(', ')}`);
  }
  return providerFactory;
}

// Check if text-to-speech provider is available
export function isTextToSpeechProviderAvailable(provider: ProviderName): boolean {
  return provider in textToSpeechProviders;
}

// Get all available text-to-speech providers
export function getAvailableTextToSpeechProviders(): ProviderName[] {
  return Object.keys(textToSpeechProviders) as ProviderName[];
} 

// Export individual providers for direct access
export {
  openaiTextToSpeechProvider,
  elevenlabsTextToSpeechProvider,
  azureTextToSpeechProvider,
}; 