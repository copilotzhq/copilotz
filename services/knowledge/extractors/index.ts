/**
 * Knowledge Base Document Extractors
 * Provider registry and factory system for different document types
 */

import type {
  ExtractorName,
  ExtractorConfig,
  DocumentExtractor,
  ExtractorFactory,
  ExtractionRequest,
  ExtractionResult
} from '../types.ts';

import {
  KnowledgeBaseError,
  ErrorCodes
} from '../types.ts';

// Import extractor implementations
import { createTextExtractor } from './text/index.ts';
import { createWebExtractor } from './web/index.ts';
import { createPdfExtractor } from './pdf/index.ts';
import { createVideoExtractor } from './video/index.ts';
import { createAudioExtractor } from './audio/index.ts';
import { createDocExtractor } from './doc/index.ts';
import { createCsvExtractor } from './csv/index.ts';
import { createJsonExtractor } from './json/index.ts';

// =============================================================================
// PROVIDER REGISTRY
// =============================================================================

const extractorRegistry: Record<ExtractorName, ExtractorFactory> = {
  text: createTextExtractor,
  web: createWebExtractor,
  pdf: createPdfExtractor,
  video: createVideoExtractor,
  audio: createAudioExtractor,
  doc: createDocExtractor,
  csv: createCsvExtractor,
  json: createJsonExtractor
};

// =============================================================================
// PROVIDER UTILITIES
// =============================================================================

/**
 * Get available extractors
 */
export function getAvailableExtractors(): ExtractorName[] {
  return Object.keys(extractorRegistry) as ExtractorName[];
}

/**
 * Check if an extractor is available
 */
export function isExtractorAvailable(name: ExtractorName): boolean {
  return name in extractorRegistry;
}

/**
 * Get extractor factory by name
 */
export function getExtractor(name: ExtractorName): ExtractorFactory {
  const factory = extractorRegistry[name];
  if (!factory) {
    throw new KnowledgeBaseError(
      `Extractor '${name}' not found`,
      ErrorCodes.UNSUPPORTED_FORMAT
    );
  }
  return factory;
}

/**
 * Create extractor instance with configuration
 */
export function createExtractor(config: ExtractorConfig): DocumentExtractor {
  const factory = getExtractor(config.provider);
  return factory(config);
}

// =============================================================================
// AUTO-DETECTION UTILITIES
// =============================================================================

/**
 * Auto-detect document type from source
 */
export function detectDocumentType(source: any): ExtractorName | null {
  // Check by URL extension
  if (source.type === 'url') {
    const url = new URL(source.url);
    const extension = url.pathname.split('.').pop()?.toLowerCase();
    
    switch (extension) {
      case 'pdf': return 'pdf';
      case 'doc':
      case 'docx': return 'doc';
      case 'txt':
      case 'md': return 'text';
      case 'csv': return 'csv';
      case 'json': return 'json';
      case 'mp4':
      case 'mov':
      case 'avi': return 'video';
      case 'mp3':
      case 'wav':
      case 'aac': return 'audio';
      default: 
        return url.protocol === 'http:' || url.protocol === 'https:' ? 'web' : null;
    }
  }

  // Check by MIME type
  if (source.type === 'file' || source.type === 'base64') {
    const mimeType = source.type === 'base64' ? source.mimeType : source.file.type;
    
    if (mimeType.startsWith('text/')) return 'text';
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType.includes('word') || mimeType.includes('document')) return 'doc';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'text/csv') return 'csv';
    if (mimeType === 'application/json') return 'json';
  }

  // Check by file name
  if (source.fileName) {
    const extension = source.fileName.split('.').pop()?.toLowerCase();
    switch (extension) {
      case 'pdf': return 'pdf';
      case 'doc':
      case 'docx': return 'doc';
      case 'txt':
      case 'md': return 'text';
      case 'csv': return 'csv';
      case 'json': return 'json';
      case 'mp4':
      case 'mov':
      case 'avi': return 'video';
      case 'mp3':
      case 'wav':
      case 'aac': return 'audio';
    }
  }

  // Default to text for plain content
  if (source.type === 'text') return 'text';

  return null;
}

/**
 * Get recommended extractor configuration for a source
 */
export function getRecommendedConfig(source: any): ExtractorConfig | null {
  const detectedType = detectDocumentType(source);
  if (!detectedType) return null;

  const baseConfig: ExtractorConfig = {
    provider: detectedType,
    options: {
      chunkSize: 1000,
      chunkOverlap: 200,
      chunkStrategy: 'sentences',
      timeout: 30000,
      retries: 3
    }
  };

  // Provider-specific defaults
  switch (detectedType) {
    case 'web':
      baseConfig.options = {
        ...baseConfig.options,
        waitFor: 2000,
        maxDepth: 1,
        followLinks: false,
        selector: 'body'
      };
      break;

    case 'video':
    case 'audio':
      baseConfig.options = {
        ...baseConfig.options,
        transcriptionProvider: 'openai',
        language: 'en',
        chunkSize: 2000
      };
      break;

    case 'pdf':
      baseConfig.options = {
        ...baseConfig.options,
        ocrLanguage: 'eng',
        chunkSize: 1500
      };
      break;

    case 'csv':
      baseConfig.options = {
        ...baseConfig.options,
        chunkStrategy: 'fixed',
        chunkSize: 500
      };
      break;
  }

  return baseConfig;
}

// =============================================================================
// UNIFIED EXTRACTION INTERFACE
// =============================================================================

/**
 * Extract content from any supported document type
 */
export async function extractDocument(request: ExtractionRequest): Promise<ExtractionResult> {
  const startTime = Date.now();

  try {
    // Auto-detect provider if not specified
    if (!request.config.provider) {
      const detected = detectDocumentType(request.source);
      if (!detected) {
        throw new KnowledgeBaseError(
          'Unable to detect document type. Please specify extractor provider.',
          ErrorCodes.UNSUPPORTED_FORMAT
        );
      }
      request.config.provider = detected;
    }

    // Validate extractor availability
    if (!isExtractorAvailable(request.config.provider)) {
      throw new KnowledgeBaseError(
        `Extractor '${request.config.provider}' is not available`,
        ErrorCodes.UNSUPPORTED_FORMAT
      );
    }

    // Create extractor instance
    const extractor = createExtractor(request.config);

    // Validate source
    if (!extractor.validate(request.source)) {
      throw new KnowledgeBaseError(
        `Source validation failed for ${request.config.provider} extractor`,
        ErrorCodes.UNSUPPORTED_FORMAT
      );
    }

    // Extract content
    console.log(`🔄 Extracting content using ${request.config.provider} extractor...`);
    const result = await extractor.extract(request);

    const processingTime = Date.now() - startTime;
    console.log(`✅ Extraction completed in ${processingTime}ms`);

    return {
      ...result,
      processingTime
    };

  } catch (error) {
    const processingTime = Date.now() - startTime;

    if (error instanceof KnowledgeBaseError) {
      return {
        success: false,
        error: error.message,
        processingTime
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      processingTime
    };
  }
}

/**
 * Batch extract multiple documents
 */
export async function extractDocuments(requests: ExtractionRequest[]): Promise<ExtractionResult[]> {
  console.log(`🔄 Batch extracting ${requests.length} documents...`);
  
  const results = await Promise.allSettled(
    requests.map(request => extractDocument(request))
  );

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      return {
        success: false,
        error: `Batch extraction failed: ${result.reason}`,
        processingTime: 0
      };
    }
  });
}

// =============================================================================
// PROVIDER INFORMATION
// =============================================================================

/**
 * Get information about all available extractors
 */
export function getExtractorInfo(): Record<ExtractorName, {
  name: string;
  description: string;
  supportedTypes: string[];
  requiredOptions?: string[];
  optionalOptions?: string[];
}> {
  return {
    text: {
      name: 'Text Extractor',
      description: 'Extract content from plain text files and strings',
      supportedTypes: ['txt', 'md', 'text'],
      optionalOptions: ['chunkSize', 'chunkOverlap', 'chunkStrategy']
    },
    web: {
      name: 'Web Scraper',
      description: 'Extract content from web pages and URLs',
      supportedTypes: ['html', 'web'],
      optionalOptions: ['selector', 'waitFor', 'maxDepth', 'followLinks']
    },
    pdf: {
      name: 'PDF Extractor',
      description: 'Extract text content from PDF documents',
      supportedTypes: ['pdf'],
      optionalOptions: ['pages', 'ocrLanguage']
    },
    video: {
      name: 'Video Transcriber',
      description: 'Extract transcriptions from video files',
      supportedTypes: ['mp4', 'mov', 'avi', 'mkv'],
      requiredOptions: ['transcriptionProvider'],
      optionalOptions: ['language']
    },
    audio: {
      name: 'Audio Transcriber',
      description: 'Extract transcriptions from audio files',
      supportedTypes: ['mp3', 'wav', 'aac', 'm4a'],
      requiredOptions: ['transcriptionProvider'],
      optionalOptions: ['language']
    },
    doc: {
      name: 'Document Extractor',
      description: 'Extract content from Word documents',
      supportedTypes: ['doc', 'docx'],
      optionalOptions: ['pages']
    },
    csv: {
      name: 'CSV Parser',
      description: 'Parse and extract data from CSV files',
      supportedTypes: ['csv'],
      optionalOptions: ['delimiter', 'headers']
    },
    json: {
      name: 'JSON Parser',
      description: 'Parse and extract data from JSON files',
      supportedTypes: ['json'],
      optionalOptions: ['jsonPath', 'flatten']
    }
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
  extractorRegistry,
  type ExtractorName,
  type ExtractorConfig,
  type DocumentExtractor,
  type ExtractorFactory,
  type ExtractionRequest,
  type ExtractionResult
};

// Re-export specific extractors for direct usage
export { createTextExtractor } from './text/index.ts';
export { createWebExtractor } from './web/index.ts';
export { createPdfExtractor } from './pdf/index.ts'; 