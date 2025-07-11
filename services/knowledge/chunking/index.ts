/**
 * Text Chunking Strategies
 * Different approaches to breaking text into manageable chunks
 */

import type {
  TextChunk,
  ChunkingConfig,
  ChunkingStrategy
} from '../types.ts';

// =============================================================================
// CHUNKING STRATEGIES
// =============================================================================

class SentenceChunker implements ChunkingStrategy {
  chunk(content: string, config: ChunkingConfig): TextChunk[] {
    const chunks: TextChunk[] = [];
    
    // Split into sentences using multiple delimiters
    const sentences = content
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    let currentChunk = '';
    let currentStart = 0;
    let chunkIndex = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const proposedChunk = currentChunk + (currentChunk ? '. ' : '') + sentence;

      // Check if adding this sentence would exceed the chunk size
      if (proposedChunk.length > config.size && currentChunk.length > 0) {
        // Create chunk from current content
        const chunkEnd = currentStart + currentChunk.length;
        
        if (currentChunk.length >= (config.minChunkSize || 50)) {
          chunks.push({
            id: `chunk-${chunkIndex}`,
            content: currentChunk.trim(),
            startIndex: currentStart,
            endIndex: chunkEnd,
            metadata: {
              strategy: 'sentences',
              sentenceCount: currentChunk.split(/[.!?]+/).length - 1
            }
          });
          chunkIndex++;
        }

        // Start new chunk with overlap
        const overlapSentences = this.getOverlapSentences(currentChunk, config.overlap);
        currentChunk = overlapSentences + (overlapSentences ? '. ' : '') + sentence;
        currentStart = Math.max(0, chunkEnd - config.overlap);
      } else {
        currentChunk = proposedChunk;
      }
    }

    // Add the final chunk
    if (currentChunk.length >= (config.minChunkSize || 50)) {
      chunks.push({
        id: `chunk-${chunkIndex}`,
        content: currentChunk.trim(),
        startIndex: currentStart,
        endIndex: currentStart + currentChunk.length,
        metadata: {
          strategy: 'sentences',
          sentenceCount: currentChunk.split(/[.!?]+/).length - 1
        }
      });
    }

    return chunks;
  }

  private getOverlapSentences(text: string, overlapSize: number): string {
    if (overlapSize <= 0 || text.length <= overlapSize) return '';
    
    const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
    let overlap = '';
    
    // Take sentences from the end until we reach the overlap size
    for (let i = sentences.length - 1; i >= 0; i--) {
      const proposedOverlap = sentences[i] + (overlap ? '. ' + overlap : '');
      if (proposedOverlap.length <= overlapSize) {
        overlap = proposedOverlap;
      } else {
        break;
      }
    }
    
    return overlap;
  }
}

class ParagraphChunker implements ChunkingStrategy {
  chunk(content: string, config: ChunkingConfig): TextChunk[] {
    const chunks: TextChunk[] = [];
    const paragraphs = content
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(p => p.length > 0);

    let currentChunk = '';
    let currentStart = 0;
    let chunkIndex = 0;

    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      const proposedChunk = currentChunk + (currentChunk ? '\n\n' : '') + paragraph;

      if (proposedChunk.length > config.size && currentChunk.length > 0) {
        // Create chunk from current content
        const chunkEnd = currentStart + currentChunk.length;
        
        if (currentChunk.length >= (config.minChunkSize || 50)) {
          chunks.push({
            id: `chunk-${chunkIndex}`,
            content: currentChunk.trim(),
            startIndex: currentStart,
            endIndex: chunkEnd,
            metadata: {
              strategy: 'paragraphs',
              paragraphCount: currentChunk.split(/\n\s*\n/).length
            }
          });
          chunkIndex++;
        }

        // Start new chunk with overlap (take last paragraph if within overlap size)
        const lastParagraph = this.getLastParagraph(currentChunk, config.overlap);
        currentChunk = lastParagraph + (lastParagraph ? '\n\n' : '') + paragraph;
        currentStart = Math.max(0, chunkEnd - config.overlap);
      } else {
        currentChunk = proposedChunk;
      }
    }

    // Add the final chunk
    if (currentChunk.length >= (config.minChunkSize || 50)) {
      chunks.push({
        id: `chunk-${chunkIndex}`,
        content: currentChunk.trim(),
        startIndex: currentStart,
        endIndex: currentStart + currentChunk.length,
        metadata: {
          strategy: 'paragraphs',
          paragraphCount: currentChunk.split(/\n\s*\n/).length
        }
      });
    }

    return chunks;
  }

  private getLastParagraph(text: string, overlapSize: number): string {
    if (overlapSize <= 0) return '';
    
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
    const lastParagraph = paragraphs[paragraphs.length - 1] || '';
    
    return lastParagraph.length <= overlapSize ? lastParagraph : '';
  }
}

class FixedChunker implements ChunkingStrategy {
  chunk(content: string, config: ChunkingConfig): TextChunk[] {
    const chunks: TextChunk[] = [];
    const chunkSize = config.size;
    const overlap = config.overlap;
    
    let currentIndex = 0;
    let chunkIndex = 0;

    while (currentIndex < content.length) {
      const endIndex = Math.min(currentIndex + chunkSize, content.length);
      let chunkContent = content.slice(currentIndex, endIndex);

      // Try to break at word boundaries if we're not at the end
      if (endIndex < content.length) {
        const lastSpaceIndex = chunkContent.lastIndexOf(' ');
        if (lastSpaceIndex > chunkSize * 0.8) { // Only break if we don't lose too much content
          chunkContent = chunkContent.slice(0, lastSpaceIndex);
        }
      }

      if (chunkContent.trim().length >= (config.minChunkSize || 50)) {
        chunks.push({
          id: `chunk-${chunkIndex}`,
          content: chunkContent.trim(),
          startIndex: currentIndex,
          endIndex: currentIndex + chunkContent.length,
          metadata: {
            strategy: 'fixed',
            actualSize: chunkContent.length
          }
        });
        chunkIndex++;
      }

      // Move to next chunk with overlap
      const actualEndIndex = currentIndex + chunkContent.length;
      currentIndex = Math.max(actualEndIndex - overlap, currentIndex + 1);
      
      // Prevent infinite loop
      if (currentIndex >= endIndex) {
        currentIndex = endIndex;
      }
    }

    return chunks;
  }
}

class SemanticChunker implements ChunkingStrategy {
  chunk(content: string, config: ChunkingConfig): TextChunk[] {
    // Semantic chunking combines multiple strategies
    // For now, we'll use a hybrid of sentence and paragraph chunking
    
    const chunks: TextChunk[] = [];
    
    // First, try to split by semantic boundaries (headers, sections)
    const sections = this.splitBySections(content);
    
    let chunkIndex = 0;
    let globalOffset = 0;

    for (const section of sections) {
      if (section.content.length <= config.size) {
        // Section fits in one chunk
        if (section.content.trim().length >= (config.minChunkSize || 50)) {
          chunks.push({
            id: `chunk-${chunkIndex}`,
            content: section.content.trim(),
            startIndex: globalOffset + section.startIndex,
            endIndex: globalOffset + section.endIndex,
            metadata: {
              strategy: 'semantic',
              sectionTitle: section.title,
              hasTitle: !!section.title
            }
          });
          chunkIndex++;
        }
      } else {
        // Section needs to be further chunked
        const sentenceChunker = new SentenceChunker();
        const subChunks = sentenceChunker.chunk(section.content, config);
        
        subChunks.forEach(chunk => {
          chunks.push({
            ...chunk,
            id: `chunk-${chunkIndex}`,
            startIndex: globalOffset + section.startIndex + chunk.startIndex,
            endIndex: globalOffset + section.startIndex + chunk.endIndex,
            metadata: {
              ...chunk.metadata,
              strategy: 'semantic',
              sectionTitle: section.title,
              parentSection: true
            }
          });
          chunkIndex++;
        });
      }
      
      globalOffset += section.content.length;
    }

    return chunks;
  }

  private splitBySections(content: string): Array<{
    content: string;
    title?: string;
    startIndex: number;
    endIndex: number;
  }> {
    const sections = [];
    
    // Look for markdown-style headers or clear section breaks
    const headerRegex = /^(#{1,6}\s+.+|.+\n[=-]{3,})/gm;
    const matches = Array.from(content.matchAll(headerRegex));
    
    if (matches.length === 0) {
      // No clear sections, treat as one section
      return [{
        content,
        startIndex: 0,
        endIndex: content.length
      }];
    }

    let lastIndex = 0;
    
    matches.forEach((match, i) => {
      const matchStart = match.index!;
      
      // Add content before this header as a section
      if (matchStart > lastIndex) {
        const sectionContent = content.slice(lastIndex, matchStart).trim();
        if (sectionContent.length > 0) {
          sections.push({
            content: sectionContent,
            startIndex: lastIndex,
            endIndex: matchStart
          });
        }
      }
      
      // Determine section end (next header or end of content)
      const nextMatch = matches[i + 1];
      const sectionEnd = nextMatch ? nextMatch.index! : content.length;
      
      const sectionContent = content.slice(matchStart, sectionEnd).trim();
      const title = this.extractTitle(match[0]);
      
      if (sectionContent.length > 0) {
        sections.push({
          content: sectionContent,
          title,
          startIndex: matchStart,
          endIndex: sectionEnd
        });
      }
      
      lastIndex = sectionEnd;
    });

    return sections;
  }

  private extractTitle(headerText: string): string {
    // Extract title from markdown header
    return headerText
      .replace(/^#+\s*/, '') // Remove markdown hashes
      .replace(/\n[=-]+$/, '') // Remove underline-style headers
      .trim();
  }
}

// =============================================================================
// CHUNKER FACTORY
// =============================================================================

const chunkers: Record<ChunkingConfig['strategy'], ChunkingStrategy> = {
  sentences: new SentenceChunker(),
  paragraphs: new ParagraphChunker(),
  fixed: new FixedChunker(),
  semantic: new SemanticChunker()
};

/**
 * Create a text chunker for the specified strategy
 */
export function createTextChunker(config: ChunkingConfig): ChunkingStrategy {
  const chunker = chunkers[config.strategy];
  if (!chunker) {
    throw new Error(`Unknown chunking strategy: ${config.strategy}`);
  }
  return chunker;
}

/**
 * Chunk text using the specified configuration
 */
export function chunkText(content: string, config: ChunkingConfig): TextChunk[] {
  const chunker = createTextChunker(config);
  return chunker.chunk(content, config);
}

/**
 * Get information about available chunking strategies
 */
export function getChunkingStrategies(): Record<string, {
  name: string;
  description: string;
  bestFor: string[];
}> {
  return {
    sentences: {
      name: 'Sentence-based',
      description: 'Split text at sentence boundaries',
      bestFor: ['Articles', 'Documents', 'General text']
    },
    paragraphs: {
      name: 'Paragraph-based',
      description: 'Split text at paragraph boundaries',
      bestFor: ['Essays', 'Reports', 'Structured documents']
    },
    fixed: {
      name: 'Fixed size',
      description: 'Split text into fixed-size chunks',
      bestFor: ['Code', 'Data', 'Uniform content']
    },
    semantic: {
      name: 'Semantic',
      description: 'Split text based on semantic boundaries and sections',
      bestFor: ['Technical docs', 'Books', 'Structured content']
    }
  };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Estimate optimal chunk size based on content characteristics
 */
export function estimateOptimalChunkSize(content: string): {
  recommended: number;
  strategy: ChunkingConfig['strategy'];
  reasoning: string;
} {
  const length = content.length;
  const sentences = content.split(/[.!?]+/).length;
  const paragraphs = content.split(/\n\s*\n/).length;
  const avgSentenceLength = length / sentences;
  const avgParagraphLength = length / paragraphs;

  // Detect content type and recommend accordingly
  if (content.includes('```') || content.includes('function ') || content.includes('class ')) {
    return {
      recommended: 800,
      strategy: 'fixed',
      reasoning: 'Code content detected - fixed chunking preserves structure'
    };
  }

  if (content.match(/^#{1,6}\s/gm) || content.includes('# ')) {
    return {
      recommended: 1200,
      strategy: 'semantic',
      reasoning: 'Structured content with headers detected'
    };
  }

  if (avgParagraphLength > 500) {
    return {
      recommended: 1000,
      strategy: 'sentences',
      reasoning: 'Long paragraphs - sentence chunking provides better granularity'
    };
  }

  if (paragraphs > 10 && avgParagraphLength < 300) {
    return {
      recommended: 800,
      strategy: 'paragraphs',
      reasoning: 'Well-structured paragraphs - paragraph chunking preserves context'
    };
  }

  return {
    recommended: 1000,
    strategy: 'sentences',
    reasoning: 'General text - sentence chunking provides good balance'
  };
}

/**
 * Validate chunk configuration
 */
export function validateChunkingConfig(config: ChunkingConfig): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (config.size <= 0) {
    errors.push('Chunk size must be positive');
  }

  if (config.overlap < 0) {
    errors.push('Overlap cannot be negative');
  }

  if (config.overlap >= config.size) {
    errors.push('Overlap must be less than chunk size');
  }

  if (config.minChunkSize && config.minChunkSize <= 0) {
    errors.push('Minimum chunk size must be positive');
  }

  if (config.maxChunkSize && config.maxChunkSize < config.size) {
    warnings.push('Maximum chunk size is less than target size');
  }

  if (config.overlap > config.size * 0.5) {
    warnings.push('Large overlap (>50% of chunk size) may cause excessive duplication');
  }

  if (config.size < 100) {
    warnings.push('Very small chunk size may result in fragmented context');
  }

  if (config.size > 4000) {
    warnings.push('Very large chunk size may exceed embedding model limits');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
} 