/**
 * Text Document Extractor
 * Handles plain text, markdown, and text files
 */

import type {
  DocumentExtractor,
  ExtractorConfig,
  ExtractionRequest,
  ExtractionResult,
  DocumentType,
  TextChunk,
  ChunkingConfig
} from '../../types.ts';
import { createTextChunker } from '../../chunking/index.ts';

export class TextExtractor implements DocumentExtractor {
  name = 'text' as const;
  supportedTypes: DocumentType[] = ['txt', 'md'];

  constructor(private config: ExtractorConfig) {}

  validate(source: any): boolean {
    switch (source.type) {
      case 'text':
        return typeof source.content === 'string';
      
      case 'file':
        return source.file && (
          source.file.type?.startsWith('text/') ||
          source.fileName?.endsWith('.txt') ||
          source.fileName?.endsWith('.md')
        );
      
      case 'url':
        const url = new URL(source.url);
        const extension = url.pathname.split('.').pop()?.toLowerCase();
        return extension === 'txt' || extension === 'md';
      
      case 'base64':
        return source.mimeType?.startsWith('text/');
      
      default:
        return false;
    }
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const startTime = Date.now();

    try {
      // Extract raw content based on source type
      let content: string;
      let metadata: any = {};

      switch (request.source.type) {
        case 'text':
          content = request.source.content;
          metadata.title = request.source.title || 'Text Content';
          break;

        case 'file':
          content = await this.extractFromFile(request.source.file);
          metadata.title = request.source.fileName || 'Uploaded File';
          metadata.fileName = request.source.fileName;
          metadata.fileSize = request.source.file.size;
          break;

        case 'url':
          const urlResult = await this.extractFromUrl(request.source.url, request.source.headers);
          content = urlResult.content;
          metadata = { ...metadata, ...urlResult.metadata };
          break;

        case 'base64':
          content = await this.extractFromBase64(request.source.data);
          metadata.title = request.source.fileName || 'Base64 Content';
          metadata.fileName = request.source.fileName;
          metadata.mimeType = request.source.mimeType;
          break;

        default:
          throw new Error(`Unsupported source type: ${(request.source as any).type}`);
      }

      // Clean and normalize content
      content = this.normalizeContent(content);

      // Add extraction metadata
      metadata.extractedAt = new Date().toISOString();
      metadata.language = this.detectLanguage(content);
      metadata.wordCount = this.countWords(content);
      metadata.characterCount = content.length;

      // Merge with request metadata
      if (request.metadata) {
        metadata = { ...metadata, ...request.metadata };
      }

      // Create chunks if requested
      let chunks: TextChunk[] | undefined;
      if (this.config.options?.chunkSize) {
        chunks = await this.createChunks(content, this.config.options);
      }

      const processingTime = Date.now() - startTime;

      return {
        success: true,
        content,
        metadata,
        chunks,
        processingTime
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        processingTime
      };
    }
  }

  private async extractFromFile(file: File | Blob): Promise<string> {
    const buffer = await file.arrayBuffer();
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(buffer);
  }

  private async extractFromUrl(url: string, headers?: Record<string, string>): Promise<{
    content: string;
    metadata: Record<string, any>;
  }> {
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
    }

    const content = await response.text();
    
    return {
      content,
      metadata: {
        title: this.extractTitleFromUrl(url) || 'Web Content',
        sourceUrl: url,
        contentType: response.headers.get('content-type') || 'text/plain',
        lastModified: response.headers.get('last-modified'),
        contentLength: response.headers.get('content-length')
      }
    };
  }

  private async extractFromBase64(data: string): Promise<string> {
    const binaryString = atob(data);
    const bytes = new Uint8Array(binaryString.length);
    
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(bytes);
  }

  private normalizeContent(content: string): string {
    return content
      // Normalize line endings
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // Remove excessive whitespace
      .replace(/[ \t]+/g, ' ')
      // Remove excessive line breaks (more than 2 consecutive)
      .replace(/\n{3,}/g, '\n\n')
      // Trim
      .trim();
  }

  private extractTitleFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      
      // Extract filename without extension
      const filename = pathname.split('/').pop();
      if (filename) {
        return filename.replace(/\.[^.]*$/, '').replace(/[-_]/g, ' ');
      }
      
      return null;
    } catch {
      return null;
    }
  }

  private detectLanguage(content: string): string {
    // Simple language detection based on common words
    const sample = content.toLowerCase().slice(0, 1000);
    
    const englishWords = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use'];
    const spanishWords = ['que', 'de', 'no', 'a', 'la', 'el', 'es', 'y', 'en', 'lo', 'un', 'por', 'qué', 'me', 'se', 'si', 'ya', 'te', 'le', 'su'];
    const frenchWords = ['que', 'de', 'je', 'est', 'pas', 'le', 'vous', 'la', 'tu', 'il', 'et', 'à', 'un', 'avoir', 'on', 'avec', 'être', 'tout', 'pour', 'ce'];
    
    let englishCount = 0;
    let spanishCount = 0;
    let frenchCount = 0;
    
    const words = sample.split(/\s+/);
    
    words.forEach(word => {
      if (englishWords.includes(word)) englishCount++;
      if (spanishWords.includes(word)) spanishCount++;
      if (frenchWords.includes(word)) frenchCount++;
    });
    
    if (englishCount > spanishCount && englishCount > frenchCount) return 'en';
    if (spanishCount > englishCount && spanishCount > frenchCount) return 'es';
    if (frenchCount > englishCount && frenchCount > spanishCount) return 'fr';
    
    return 'unknown';
  }

  private countWords(content: string): number {
    return content.split(/\s+/).filter(word => word.length > 0).length;
  }

  private async createChunks(content: string, options: any): Promise<TextChunk[]> {
    const chunkingConfig: ChunkingConfig = {
      strategy: options.chunkStrategy || 'sentences',
      size: options.chunkSize || 1000,
      overlap: options.chunkOverlap || 200,
      preserveStructure: options.preserveStructure ?? true,
      minChunkSize: options.minChunkSize || 100,
      maxChunkSize: options.maxChunkSize || options.chunkSize * 2 || 2000
    };

    const chunker = createTextChunker(chunkingConfig);
    return chunker.chunk(content, chunkingConfig);
  }
}

/**
 * Factory function to create text extractor
 */
export function createTextExtractor(config: ExtractorConfig): TextExtractor {
  return new TextExtractor(config);
} 