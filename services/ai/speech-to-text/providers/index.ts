import type { SpeechToTextProviderRegistry, ProviderName } from '../../types.ts';
import { openaiSpeechToTextProvider } from './openai.ts';
import { assemblyaiSpeechToTextProvider } from './assemblyai.ts';
import { deepgramSpeechToTextProvider } from './deepgram.ts';

// Registry of all speech-to-text providers
export const speechToTextProviders: SpeechToTextProviderRegistry = {
  openai: openaiSpeechToTextProvider,
  assemblyai: assemblyaiSpeechToTextProvider,
  deepgram: deepgramSpeechToTextProvider,
  // Add more providers here as they're implemented
  // rev: revSpeechToTextProvider,
};

// Get a specific speech-to-text provider
export function getSpeechToTextProvider(provider: ProviderName) {
  const providerFactory = speechToTextProviders[provider];
  if (!providerFactory) {
    throw new Error(`Speech-to-text provider '${provider}' is not supported. Available providers: ${Object.keys(speechToTextProviders).join(', ')}`);
  }
  return providerFactory;
}

// Check if speech-to-text provider is available
export function isSpeechToTextProviderAvailable(provider: ProviderName): boolean {
  return provider in speechToTextProviders;
}

// Get all available speech-to-text providers
export function getAvailableSpeechToTextProviders(): ProviderName[] {
  return Object.keys(speechToTextProviders) as ProviderName[];
} 

// Export individual providers for direct access
export {
  openaiSpeechToTextProvider,
  assemblyaiSpeechToTextProvider,
  deepgramSpeechToTextProvider,
}; 