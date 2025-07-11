// Core message types following OpenAI chat format with multimodal support
export interface MediaAttachment {
  type: 'image' | 'audio' | 'video' | 'document' | 'file';
  url?: string; // URL or base64 data URL
  data?: string; // Direct base64 content
  filename?: string;
  mimeType?: string;
  size?: number;
  // Media-specific options
  detail?: 'low' | 'high' | 'auto'; // For images (OpenAI)
  format?: 'transcription' | 'analysis' | 'summary'; // Processing type
  language?: string; // For audio transcription
  extractText?: boolean; // For documents/images (OCR)
  maxFrames?: number; // For video processing
  frameInterval?: number; // Video frame extraction interval (seconds)
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  attachments?: MediaAttachment[]; // Multimodal attachments
  metadata?: {
    timestamp?: string;
    userId?: string;
    mediaProcessed?: boolean;
    originalSize?: number;
  };
}

// Comprehensive configuration for AI providers with multimodal support
export interface ProviderConfig {
  // Provider selection
  provider?: ProviderName;
  apiKey?: string;
  
  // Model configuration
  model?: string;
  temperature?: number;
  
  // Token limits
  maxTokens?: number;
  maxCompletionTokens?: number;
  maxLength?: number; // For message truncation
  
  // Response format
  responseType?: 'text' | 'json';
  stream?: boolean;
  
  // Advanced sampling parameters
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  
  // Stop sequences
  stop?: string | string[];
  stopSequences?: string[];
  
  // Randomization
  seed?: number;
  
  // Provider-specific parameters
  user?: string; // OpenAI user identifier
  candidateCount?: number; // Gemini
  responseMimeType?: string; // Gemini JSON format
  repeatPenalty?: number; // Ollama
  numCtx?: number; // Ollama context window
  metadata?: Record<string, any>; // Anthropic
  baseUrl?: string; // Custom base URL (Ollama, self-hosted)
  reasoningEffort?: 'low' | 'medium' | 'high'; // OpenAI reasoning models (o3, o4)
  
  // Multimodal configuration
  vision?: {
    enabled?: boolean;
    detail?: 'low' | 'high' | 'auto'; // Image detail level
    maxImages?: number; // Max images per request
    autoResize?: boolean; // Auto-resize large images
  };
  
  audio?: {
    enabled?: boolean;
    model?: string; // Whisper model for transcription
    language?: string; // Target language for transcription
    format?: 'mp3' | 'wav' | 'webm' | 'auto';
    enableTTS?: boolean; // Text-to-speech output
    voice?: string; // TTS voice selection
  };
  
  video?: {
    enabled?: boolean;
    maxFrames?: number; // Max frames to extract
    frameInterval?: number; // Seconds between frames
    extractAudio?: boolean; // Extract audio track
    generateThumbnail?: boolean;
  };
  
  document?: {
    enabled?: boolean;
    extractText?: boolean; // OCR for images/PDFs
    preserveFormatting?: boolean;
    chunkSize?: number; // For large documents
    supportedFormats?: string[]; // ['pdf', 'docx', 'txt', etc.]
  };
  
  // Processing options
  preprocessing?: {
    autoTranscribe?: boolean; // Auto-transcribe audio attachments
    autoAnalyze?: boolean; // Auto-analyze images/videos
    autoExtractText?: boolean; // Auto-OCR documents
    compressMedia?: boolean; // Compress large media files
    maxFileSize?: number; // Max file size in bytes
    processInParallel?: boolean; // Process media attachments in parallel
  };
}

// Input for chat requests with multimodal support
export interface ChatRequest {
  messages: ChatMessage[];
  instructions?: string;
  config?: ProviderConfig;
  answer?: string; // For mock responses
  
  // Media processing options
  mediaConfig?: {
    autoProcess?: boolean; // Automatically process all media
    processInParallel?: boolean; // Process media attachments in parallel
    includeMediaSummary?: boolean; // Include media analysis in response
    preserveOriginal?: boolean; // Keep original media data
  };
}

// Response from chat completions with media processing results
export interface ChatResponse {
  prompt: ChatMessage[];
  answer: string;
  tokens: number;
  provider?: ProviderName;
  model?: string;
  
  // Media processing results
  mediaProcessing?: {
    processedAttachments?: {
      id: string;
      type: MediaAttachment['type'];
      originalFilename?: string;
      processingTime?: number;
      result?: {
        transcription?: string; // For audio
        analysis?: string; // For images/videos
        extractedText?: string; // For documents
        summary?: string; // General summary
        metadata?: Record<string, any>;
      };
      error?: string;
    }[];
    totalProcessingTime?: number;
    successCount?: number;
    errorCount?: number;
  };
}

// Stream callback function
export type StreamCallback = (chunk: string) => void;

// Media processing result
export interface MediaProcessingResult {
  success: boolean;
  type: MediaAttachment['type'];
  result?: {
    transcription?: string;
    analysis?: string;
    extractedText?: string;
    summary?: string;
    metadata?: Record<string, any>;
  };
  error?: string;
  processingTime?: number;
}

// Provider API interface with multimodal support
export interface ProviderAPI {
  endpoint: string;
  headers: (config: ProviderConfig) => Record<string, string>;
  body: (messages: ChatMessage[], config: ProviderConfig) => any;
  extractContent: (data: any) => string | null;
  transformMessages?: (messages: ChatMessage[]) => any; // For provider-specific format
  
  // Optional custom stream processor for providers with non-standard streaming formats
  processStream?: (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onChunk: StreamCallback,
    extractContent: (data: any) => string | null
  ) => Promise<string>;
  
  // Multimodal capabilities
  capabilities?: {
    vision?: boolean;
    audio?: boolean;
    video?: boolean;
    documents?: boolean;
    maxImageSize?: number;
    maxAudioDuration?: number;
    maxVideoSize?: number;
    supportedFormats?: {
      image?: string[];
      audio?: string[];
      video?: string[];
      document?: string[];
    };
  };
  
  // Media processing functions
  processMedia?: {
    preprocessImages?: (attachments: MediaAttachment[]) => Promise<MediaAttachment[]>;
    processAudio?: (attachment: MediaAttachment, config: ProviderConfig) => Promise<MediaProcessingResult>;
    processVideo?: (attachment: MediaAttachment, config: ProviderConfig) => Promise<MediaProcessingResult>;
    processDocument?: (attachment: MediaAttachment, config: ProviderConfig) => Promise<MediaProcessingResult>;
  };
}

// Provider factory function signature - now much simpler
export interface ProviderFactory {
  (config: ProviderConfig): ProviderAPI;
}

// Supported providers
export type ProviderName = 'openai' | 'anthropic' | 'gemini' | 'groq' | 'deepseek' | 'ollama' | 'xai';

// Provider registry
export interface ProviderRegistry {
  [key: string]: ProviderFactory;
}

// Base connector interface (now unused, keeping for backwards compatibility)
export interface ChatConnector {
  (request: ChatRequest, stream?: StreamCallback): Promise<ChatResponse>;
} 