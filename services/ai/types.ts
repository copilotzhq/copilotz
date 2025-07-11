// =============================================================================
// UNIFIED AI TYPES - Single source of truth for all AI services
// =============================================================================

import type { 
  ChatRequest as LLMChatRequest, 
  ChatResponse as LLMChatResponse, 
  ProviderConfig as LLMProviderConfig,
  ProviderName,
  StreamCallback 
} from './llm/types.ts';

// =============================================================================
// COMMON TYPES
// =============================================================================

export type AIServiceType = 'llm' | 'embedding' | 'speech-to-text' | 'text-to-speech' | 'image-generation';

export interface BaseAIConfig {
  provider?: ProviderName;
  apiKey?: string;
  model?: string;
}

export interface BaseAIResponse {
  success: boolean;
  provider?: ProviderName;
  model?: string;
  processingTime?: number;
  error?: string;
}

// =============================================================================
// LLM TYPES (Re-export from existing LLM service)
// =============================================================================

export interface LLMConfig extends LLMProviderConfig {}

export interface LLMRequest extends LLMChatRequest {
  stream?: StreamCallback;
}

export interface LLMResponse extends LLMChatResponse {}

// =============================================================================
// EMBEDDING TYPES
// =============================================================================

export interface EmbeddingConfig extends BaseAIConfig {
  dimensions?: number;
  encodingFormat?: 'float' | 'base64';
  // Provider can be any of the supported providers
  provider?: ProviderName;
}

export interface EmbeddingRequest {
  input: string | string[];
  config?: EmbeddingConfig;
}

export interface EmbeddingResponse extends BaseAIResponse {
  embeddings: number[][] | number[];
  usage?: {
    promptTokens: number;
    totalTokens: number;
  };
}

// =============================================================================
// SPEECH-TO-TEXT TYPES
// =============================================================================

export interface SpeechToTextConfig extends BaseAIConfig {
  language?: string;
  responseFormat?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  temperature?: number;
  prompt?: string; // Context hint
  // Provider can be any of the supported providers
  provider?: ProviderName;
}

export interface SpeechToTextRequest {
  audio: Blob | File | ArrayBuffer;
  config?: SpeechToTextConfig;
}

export interface SpeechToTextResponse extends BaseAIResponse {
  text: string;
  language?: string;
  duration?: number;
  confidence?: number;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
    confidence?: number;
  }>;
}

// =============================================================================
// TEXT-TO-SPEECH TYPES
// =============================================================================

export interface TextToSpeechConfig extends BaseAIConfig {
  voice?: string;
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number; // 0.25 to 4.0
  // Provider can be any of the supported providers
  provider?: ProviderName;
}

export interface TextToSpeechRequest {
  text: string;
  config?: TextToSpeechConfig;
}

export interface TextToSpeechResponse extends BaseAIResponse {
  audio: Blob | ArrayBuffer;
  format: string;
  duration?: number;
}

// =============================================================================
// IMAGE GENERATION TYPES
// =============================================================================

export interface ImageGenerationConfig extends BaseAIConfig {
  size?: '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792';
  quality?: 'standard' | 'hd';
  style?: 'vivid' | 'natural';
  responseFormat?: 'url' | 'b64_json';
  n?: number; // Number of images (1-10)
  // Provider can be any of the supported providers
  provider?: ProviderName;
}

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  config?: ImageGenerationConfig;
}

export interface ImageGenerationResponse extends BaseAIResponse {
  images: Array<{
    url?: string;
    b64_json?: string;
    revisedPrompt?: string;
  }>;
  usage?: {
    promptTokens?: number;
  };
}

// =============================================================================
// UNIFIED AI REQUEST/RESPONSE DISCRIMINATED UNIONS
// =============================================================================

export type AIRequest = 
  | ({ type: 'llm' } & LLMRequest)
  | ({ type: 'embedding' } & EmbeddingRequest)
  | ({ type: 'speech-to-text' } & SpeechToTextRequest)
  | ({ type: 'text-to-speech' } & TextToSpeechRequest)
  | ({ type: 'image-generation' } & ImageGenerationRequest);

export type AIResponse = 
  | ({ type: 'llm' } & LLMResponse)
  | ({ type: 'embedding' } & EmbeddingResponse)
  | ({ type: 'speech-to-text' } & SpeechToTextResponse)
  | ({ type: 'text-to-speech' } & TextToSpeechResponse)
  | ({ type: 'image-generation' } & ImageGenerationResponse);

// =============================================================================
// FUNCTION OVERLOADS FOR TYPE SAFETY
// =============================================================================

export interface AIServiceOverloads {
  (request: { type: 'llm' } & LLMRequest): Promise<LLMResponse>;
  (request: { type: 'embedding' } & EmbeddingRequest): Promise<EmbeddingResponse>;
  (request: { type: 'speech-to-text' } & SpeechToTextRequest): Promise<SpeechToTextResponse>;
  (request: { type: 'text-to-speech' } & TextToSpeechRequest): Promise<TextToSpeechResponse>;
  (request: { type: 'image-generation' } & ImageGenerationRequest): Promise<ImageGenerationResponse>;
}

// =============================================================================
// UTILITY TYPES
// =============================================================================

export type AIConfigForType<T extends AIServiceType> = 
  T extends 'llm' ? LLMConfig :
  T extends 'embedding' ? EmbeddingConfig :
  T extends 'speech-to-text' ? SpeechToTextConfig :
  T extends 'text-to-speech' ? TextToSpeechConfig :
  T extends 'image-generation' ? ImageGenerationConfig :
  never;

export type AIRequestForType<T extends AIServiceType> = 
  T extends 'llm' ? LLMRequest :
  T extends 'embedding' ? EmbeddingRequest :
  T extends 'speech-to-text' ? SpeechToTextRequest :
  T extends 'text-to-speech' ? TextToSpeechRequest :
  T extends 'image-generation' ? ImageGenerationRequest :
  never;

export type AIResponseForType<T extends AIServiceType> = 
  T extends 'llm' ? LLMResponse :
  T extends 'embedding' ? EmbeddingResponse :
  T extends 'speech-to-text' ? SpeechToTextResponse :
  T extends 'text-to-speech' ? TextToSpeechResponse :
  T extends 'image-generation' ? ImageGenerationResponse :
  never;

// =============================================================================
// PROVIDER INTERFACES (for each AI service type)
// =============================================================================

export interface EmbeddingProvider {
  name: ProviderName;
  generateEmbedding: (request: EmbeddingRequest) => Promise<EmbeddingResponse>;
}

export interface SpeechToTextProvider {
  name: ProviderName;
  transcribe: (request: SpeechToTextRequest) => Promise<SpeechToTextResponse>;
}

export interface TextToSpeechProvider {
  name: ProviderName;
  speak: (request: TextToSpeechRequest) => Promise<TextToSpeechResponse>;
}

export interface ImageGenerationProvider {
  name: ProviderName;
  generateImage: (request: ImageGenerationRequest) => Promise<ImageGenerationResponse>;
}

// Provider factory types
export type EmbeddingProviderFactory = (config: EmbeddingConfig) => EmbeddingProvider;
export type SpeechToTextProviderFactory = (config: SpeechToTextConfig) => SpeechToTextProvider;
export type TextToSpeechProviderFactory = (config: TextToSpeechConfig) => TextToSpeechProvider;
export type ImageGenerationProviderFactory = (config: ImageGenerationConfig) => ImageGenerationProvider;

// Registry types for each service
export interface EmbeddingProviderRegistry {
  [key: string]: EmbeddingProviderFactory;
}

export interface SpeechToTextProviderRegistry {
  [key: string]: SpeechToTextProviderFactory;
}

export interface TextToSpeechProviderRegistry {
  [key: string]: TextToSpeechProviderFactory;
}

export interface ImageGenerationProviderRegistry {
  [key: string]: ImageGenerationProviderFactory;
}

// Re-export commonly used types
export type { ProviderName, StreamCallback }; 