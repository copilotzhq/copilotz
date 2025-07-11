/**
 * Web Content Extractor
 * Scrapes content from web pages and URLs
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

export class WebExtractor implements DocumentExtractor {
  name = 'web' as const;
  supportedTypes: DocumentType[] = ['web'];

  constructor(private config: ExtractorConfig) {}

  validate(source: any): boolean {
    if (source.type !== 'url') return false;
    
    try {
      const url = new URL(source.url);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const startTime = Date.now();

    try {
      if (request.source.type !== 'url') {
        throw new Error('Web extractor only supports URL sources');
      }

      const options = this.config.options || {};
      const url = request.source.url;
      
      console.log(`🌐 Fetching content from: ${url}`);

      // Fetch the HTML content
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; KnowledgeBase/1.0)',
          ...request.source.headers
        },
        signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      const contentType = response.headers.get('content-type') || '';

      // Parse and extract content
      const extractedContent = await this.parseHtmlContent(html, options);

      // Clean and normalize content
      const content = this.normalizeContent(extractedContent.text);

      // Build metadata
      const metadata = {
        title: extractedContent.title || this.extractTitleFromUrl(url) || 'Web Page',
        sourceUrl: url,
        contentType,
        extractedAt: new Date().toISOString(),
        wordCount: this.countWords(content),
        characterCount: content.length,
        language: this.detectLanguage(content),
        links: extractedContent.links,
        images: extractedContent.images,
        lastModified: response.headers.get('last-modified'),
        contentLength: response.headers.get('content-length'),
        ...(request.metadata || {})
      };

      // Handle following links if requested
      let additionalContent = '';
      if (options.followLinks && options.maxDepth && options.maxDepth > 1) {
        additionalContent = await this.followLinks(
          extractedContent.links,
          url,
          options,
          options.maxDepth - 1
        );
        
        if (additionalContent) {
          metadata.hasLinkedContent = true;
          metadata.linkedPages = extractedContent.links.length;
        }
      }

      const finalContent = content + (additionalContent ? '\n\n' + additionalContent : '');

      // Create chunks if requested
      let chunks: TextChunk[] | undefined;
      if (options.chunkSize) {
        chunks = await this.createChunks(finalContent, options);
      }

      const processingTime = Date.now() - startTime;

      return {
        success: true,
        content: finalContent,
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

  private async parseHtmlContent(html: string, options: any): Promise<{
    text: string;
    title: string | null;
    links: string[];
    images: string[];
  }> {
    // Simple HTML parsing using Deno's built-in DOMParser (when available)
    // For production, consider using a proper HTML parser like linkedom
    
    try {
      // Remove script and style elements
      let cleanHtml = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

      // Extract title
      const titleMatch = cleanHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : null;

      // Extract links
      const linkMatches = cleanHtml.match(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi) || [];
      const links = linkMatches
        .map(link => {
          const hrefMatch = link.match(/href=["']([^"']+)["']/i);
          return hrefMatch ? hrefMatch[1] : null;
        })
        .filter((link): link is string => link !== null)
        .filter(link => link.startsWith('http'))
        .slice(0, 10); // Limit to first 10 links

      // Extract images
      const imgMatches = cleanHtml.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi) || [];
      const images = imgMatches
        .map(img => {
          const srcMatch = img.match(/src=["']([^"']+)["']/i);
          return srcMatch ? srcMatch[1] : null;
        })
        .filter((img): img is string => img !== null);

      // Extract text content based on selector
      let textContent: string;
      
      if (options.selector && options.selector !== 'body') {
        // Try to extract content from specific selector
        textContent = this.extractBySelector(cleanHtml, options.selector);
      } else {
        // Extract main content areas
        textContent = this.extractMainContent(cleanHtml);
      }

      return {
        text: textContent,
        title,
        links,
        images
      };

    } catch (error) {
      // Fallback: simple text extraction
      const text = html
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      return {
        text,
        title: null,
        links: [],
        images: []
      };
    }
  }

  private extractBySelector(html: string, selector: string): string {
    // Simple selector matching for common cases
    const patterns = {
      'main': /<main[^>]*>([\s\S]*?)<\/main>/i,
      'article': /<article[^>]*>([\s\S]*?)<\/article>/i,
      '.content': /class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
      '#content': /id=["']content["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
      'p': /<p[^>]*>([\s\S]*?)<\/p>/gi
    };

    const pattern = patterns[selector as keyof typeof patterns];
    if (pattern) {
      const matches = html.match(pattern);
      if (matches) {
        return matches[1]
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }

    // Fallback to extracting main content
    return this.extractMainContent(html);
  }

  private extractMainContent(html: string): string {
    // Remove navigation, sidebar, footer, header
    let content = html
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
      .replace(/class=["'][^"']*sidebar[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, '')
      .replace(/class=["'][^"']*nav[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, '');

    // Extract text from remaining content
    return content
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async followLinks(links: string[], baseUrl: string, options: any, maxDepth: number): Promise<string> {
    if (maxDepth <= 0 || links.length === 0) return '';

    const results: string[] = [];
    const maxLinks = Math.min(links.length, 3); // Limit to 3 links to avoid excessive requests

    for (let i = 0; i < maxLinks; i++) {
      try {
        const link = links[i];
        
        // Avoid recursive loops
        if (link === baseUrl) continue;

        console.log(`🔗 Following link: ${link}`);

        const response = await fetch(link, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; KnowledgeBase/1.0)'
          },
          signal: AbortSignal.timeout(options.timeout || 10000)
        });

        if (response.ok) {
          const html = await response.text();
          const parsed = await this.parseHtmlContent(html, { ...options, followLinks: false });
          
          if (parsed.text.length > 100) { // Only include substantial content
            results.push(`\n--- Linked Content from ${link} ---\n${parsed.text}`);
          }
        }

      } catch (error) {
        console.warn(`Failed to fetch linked content: ${error.message}`);
      }
    }

    return results.join('\n\n');
  }

  private normalizeContent(content: string): string {
    return content
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      // Remove excessive line breaks
      .replace(/\n{3,}/g, '\n\n')
      // Clean up common HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Trim
      .trim();
  }

  private extractTitleFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      
      if (pathname === '/' || pathname === '') {
        return urlObj.hostname.replace(/^www\./, '');
      }
      
      const segments = pathname.split('/').filter(s => s.length > 0);
      const lastSegment = segments[segments.length - 1];
      
      return lastSegment
        .replace(/\.[^.]*$/, '') // Remove extension
        .replace(/[-_]/g, ' ') // Replace hyphens and underscores with spaces
        .replace(/\b\w/g, l => l.toUpperCase()); // Title case
    } catch {
      return null;
    }
  }

  private detectLanguage(content: string): string {
    // Simple language detection based on common words
    const sample = content.toLowerCase().slice(0, 1000);
    
    const englishWords = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our'];
    const spanishWords = ['que', 'de', 'no', 'a', 'la', 'el', 'es', 'y', 'en', 'lo', 'un', 'por'];
    
    let englishCount = 0;
    let spanishCount = 0;
    
    const words = sample.split(/\s+/);
    
    words.forEach(word => {
      if (englishWords.includes(word)) englishCount++;
      if (spanishWords.includes(word)) spanishCount++;
    });
    
    if (englishCount > spanishCount) return 'en';
    if (spanishCount > englishCount) return 'es';
    
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
 * Factory function to create web extractor
 */
export function createWebExtractor(config: ExtractorConfig): WebExtractor {
  return new WebExtractor(config);
} 