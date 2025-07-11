import type { 
  MediaAttachment, 
  ProviderConfig, 
  MediaProcessingResult,
  ProviderName 
} from './types.ts';

/**
 * Media processing utilities for multimodal AI chat
 * Provides unified media handling across all providers
 * Note: Server-side implementation for Deno environment
 */

// Supported media formats by type
export const SUPPORTED_FORMATS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'],
  audio: ['mp3', 'wav', 'webm', 'm4a', 'aac', 'ogg'],
  video: ['mp4', 'webm', 'mov', 'avi', 'mkv'],
  document: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf']
} as const;

// Size limits (in bytes)
export const SIZE_LIMITS = {
  image: 20 * 1024 * 1024, // 20MB
  audio: 25 * 1024 * 1024, // 25MB  
  video: 512 * 1024 * 1024, // 512MB
  document: 50 * 1024 * 1024, // 50MB
} as const;

/**
 * Detect media type from file extension or MIME type
 */
export function detectMediaType(filename: string, mimeType?: string): MediaAttachment['type'] {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  
  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.includes('pdf') || mimeType.includes('document')) return 'document';
  }
  
  for (const [type, extensions] of Object.entries(SUPPORTED_FORMATS)) {
    if ((extensions as readonly string[]).includes(ext)) {
      return type as MediaAttachment['type'];
    }
  }
  
  return 'file';
}

/**
 * Validate media file size and format
 */
export function validateMedia(attachment: MediaAttachment): { valid: boolean; error?: string } {
  const { type, filename, size, mimeType } = attachment;
  
  // Check if type is supported
  if (!['image', 'audio', 'video', 'document'].includes(type)) {
    return { valid: false, error: `Unsupported media type: ${type}` };
  }
  
  // Check file size (only for supported types with size limits)
  if (size && type !== 'file' && type in SIZE_LIMITS) {
    const sizeLimit = SIZE_LIMITS[type as keyof typeof SIZE_LIMITS];
    if (size > sizeLimit) {
      return { 
        valid: false, 
        error: `File too large. Max size for ${type}: ${sizeLimit / (1024*1024)}MB` 
      };
    }
  }
  
  // Check format
  if (filename) {
    const detectedType = detectMediaType(filename, mimeType);
    if (detectedType === 'file' && type !== 'file') {
      return { valid: false, error: `Unsupported file format for ${type}` };
    }
  }
  
  return { valid: true };
}

/**
 * Extract file info from base64 data URL
 */
export function parseDataURL(dataUrl: string): {
  mimeType: string;
  data: string;
  size: number;
} | null {
  if (!dataUrl.startsWith('data:')) return null;
  
  try {
    const [header, data] = dataUrl.split(',');
    const mimeType = header.match(/:(.*?);/)?.[1] || 'application/octet-stream';
    
    // Calculate size from base64 data
    const size = Math.round((data.length * 3) / 4);
    
    return { mimeType, data, size };
  } catch {
    return null;
  }
}

/**
 * Convert base64 to Blob (useful for API calls)
 */
export function base64ToBlob(base64: string, mimeType: string = 'application/octet-stream'): Blob {
  let data = base64;
  
  // Remove data URL prefix if present
  if (base64.includes(',')) {
    data = base64.split(',')[1];
  }
  
  const byteCharacters = atob(data);
  const byteNumbers = new Array(byteCharacters.length);
  
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

/**
 * Process media attachments based on provider capabilities
 * Server-side preprocessing for Deno environment
 */
export async function preprocessMediaAttachments(
  attachments: MediaAttachment[],
  config: ProviderConfig,
  provider: ProviderName
): Promise<MediaAttachment[]> {
  const processedAttachments: MediaAttachment[] = [];
  
  for (const attachment of attachments) {
    const validation = validateMedia(attachment);
    if (!validation.valid) {
      console.warn(`Skipping invalid media: ${validation.error}`);
      continue;
    }
    
    let processed = { ...attachment };
    
    // Provider-specific preprocessing
    if (attachment.type === 'image' && config.vision?.enabled) {
      // Set detail level based on provider
      if (!processed.detail) {
        processed.detail = config.vision.detail || 'auto';
      }
      
      // Note: For server-side image resizing, consider using:
      // - Sharp library for Node.js/Deno
      // - ImageMagick bindings
      // - WebAssembly image processing libraries
      if (config.vision.autoResize && attachment.size && attachment.size > 5 * 1024 * 1024) {
        console.warn(`Large image detected (${attachment.filename}). Consider using server-side image processing.`);
      }
    }
    
    // Compress large files if needed
    if (config.preprocessing?.compressMedia && attachment.size) {
      const maxSize = config.preprocessing.maxFileSize || 
        (attachment.type in SIZE_LIMITS ? SIZE_LIMITS[attachment.type as keyof typeof SIZE_LIMITS] : 50 * 1024 * 1024);
      if (attachment.size > maxSize) {
        console.warn(`File ${attachment.filename} exceeds size limit, may need compression`);
      }
    }
    
    processedAttachments.push(processed);
  }
  
  return processedAttachments;
}

/**
 * Convert media attachment to provider-specific format
 */
export function formatMediaForProvider(
  attachment: MediaAttachment,
  provider: ProviderName
): any {
  switch (provider) {
    case 'openai':
      if (attachment.type === 'image') {
        return {
          type: 'image_url',
          image_url: {
            url: attachment.url || attachment.data,
            detail: attachment.detail || 'auto'
          }
        };
      }
      break;
      
    case 'anthropic':
      if (attachment.type === 'image') {
        const imageData = attachment.data || attachment.url;
        if (imageData?.startsWith('data:')) {
          const [, base64] = imageData.split(',');
          const mimeType = imageData.match(/data:(.*?);/)?.[1] || 'image/jpeg';
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: base64
            }
          };
        }
      }
      break;
      
    case 'gemini':
      if (attachment.type === 'image') {
        return {
          inlineData: {
            mimeType: attachment.mimeType || 'image/jpeg',
            data: attachment.data?.split(',')[1] || attachment.data
          }
        };
      }
      break;
      
    default:
      // Generic format for other providers
      return {
        type: attachment.type,
        data: attachment.data || attachment.url,
        filename: attachment.filename,
        mimeType: attachment.mimeType
      };
  }
  
  return null;
}

/**
 * Process audio using Whisper (OpenAI/Groq)
 * Server-side audio transcription
 */
export async function processAudioWithWhisper(
  attachment: MediaAttachment,
  config: ProviderConfig,
  apiKey: string,
  baseUrl: string = 'https://api.openai.com/v1'
): Promise<MediaProcessingResult> {
  const startTime = Date.now();
  
  try {
    if (!attachment.data) {
      throw new Error('No audio data provided');
    }
    
    const audioBlob = base64ToBlob(attachment.data, attachment.mimeType);
    
    const formData = new FormData();
    formData.append('file', audioBlob, attachment.filename || 'audio.mp3');
    formData.append('model', config.audio?.model || 'whisper-1');
    formData.append('response_format', 'verbose_json');
    
    if (config.audio?.language) {
      formData.append('language', config.audio.language);
    }
    
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });
    
    if (!response.ok) {
      throw new Error(`Transcription failed: ${response.statusText}`);
    }
    
    const result = await response.json();
    
    return {
      success: true,
      type: 'audio',
      result: {
        transcription: result.text,
        metadata: {
          duration: result.duration,
          language: result.language,
          segments: result.segments
        }
      },
      processingTime: Date.now() - startTime
    };
  } catch (error) {
    return {
      success: false,
      type: 'audio',
      error: error instanceof Error ? error.message : 'Unknown error',
      processingTime: Date.now() - startTime
    };
  }
}

/**
 * Check provider capabilities for media types
 */
export function getProviderMediaCapabilities(provider: ProviderName): {
  vision: boolean;
  audio: boolean;
  video: boolean;
  documents: boolean;
} {
  switch (provider) {
    case 'openai':
      return { vision: true, audio: true, video: true, documents: true };
    case 'anthropic':
      return { vision: true, audio: false, video: false, documents: true };
    case 'gemini':
      return { vision: true, audio: true, video: true, documents: true };
    case 'groq':
      return { vision: true, audio: true, video: false, documents: true };
    case 'deepseek':
      return { vision: true, audio: false, video: false, documents: true };
    case 'ollama':
      return { vision: true, audio: true, video: false, documents: true };
    default:
      return { vision: false, audio: false, video: false, documents: false };
  }
}

/**
 * Generate media summary for inclusion in chat
 */
export function generateMediaSummary(attachments: MediaAttachment[]): string {
  if (!attachments.length) return '';
  
  const counts = attachments.reduce((acc, att) => {
    acc[att.type] = (acc[att.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  const summary = Object.entries(counts)
    .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
    .join(', ');
    
  return `[Media attachments: ${summary}]`;
}

/**
 * Server-side media processing notes:
 * 
 * For production Deno deployments, consider these alternatives:
 * 
 * IMAGE PROCESSING:
 * - Use Sharp library via npm: specifier
 * - Use ImageMagick with Deno FFI
 * - Use WebAssembly image libraries
 * - Use external services (Cloudinary, ImageKit)
 * 
 * VIDEO PROCESSING:  
 * - Use FFmpeg with Deno FFI
 * - Use external services (Mux, AWS MediaConvert)
 * - Use WebAssembly video libraries
 * 
 * DOCUMENT PROCESSING:
 * - Use PDF.js for PDF parsing
 * - Use external OCR services (Google Vision, AWS Textract)
 * - Use LibreOffice headless for document conversion
 * 
 * AUDIO PROCESSING:
 * - OpenAI Whisper API (implemented)
 * - Use FFmpeg for audio format conversion
 * - Use external speech services
 */ 