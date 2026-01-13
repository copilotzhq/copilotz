/**
 * Text Chunker Utility
 * 
 * Splits text into chunks for embedding and retrieval.
 * Uses tiktoken for accurate token counting.
 */

import { Tiktoken } from "js-tiktoken";

// cl100k_base is used by text-embedding-3-* models
const encoder = new Tiktoken({
  bpe_ranks: "cl100k_base",
  special_tokens: {},
  pat_str: "",
});

export interface ChunkMetadata {
  chunkIndex: number;
  startPosition: number;
  endPosition: number;
  tokenCount: number;
}

export interface TextChunk {
  content: string;
  metadata: ChunkMetadata;
}

export interface ChunkerOptions {
  /** Target chunk size in tokens (default: 512) */
  chunkSize?: number;
  /** Overlap between chunks in tokens (default: 50) */
  chunkOverlap?: number;
  /** Strategy for chunking (default: "fixed") */
  strategy?: "fixed" | "paragraph" | "sentence";
  /** Separator for splitting (default: varies by strategy) */
  separator?: string;
}

/**
 * Count tokens in a text string using tiktoken
 */
export function countTokens(text: string): number {
  try {
    const tokens = encoder.encode(text);
    return tokens.length;
  } catch {
    // Fallback to rough estimation if encoding fails
    return Math.ceil(text.length / 4);
  }
}

/**
 * Split text into chunks based on token count
 */
export function chunkText(text: string, options: ChunkerOptions = {}): TextChunk[] {
  const {
    chunkSize = 512,
    chunkOverlap = 50,
    strategy = "fixed",
  } = options;

  if (!text || text.trim().length === 0) {
    return [];
  }

  switch (strategy) {
    case "paragraph":
      return chunkByParagraph(text, chunkSize, chunkOverlap);
    case "sentence":
      return chunkBySentence(text, chunkSize, chunkOverlap);
    case "fixed":
    default:
      return chunkByTokens(text, chunkSize, chunkOverlap);
  }
}

/**
 * Fixed-size chunking based on token count
 */
function chunkByTokens(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  
  // Split by whitespace while preserving position
  const words = text.split(/(\s+)/);
  
  let currentChunk = "";
  let currentTokenCount = 0;
  let chunkStartPos = 0;
  let currentPos = 0;
  let chunkIndex = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const wordTokens = countTokens(word);
    
    if (currentTokenCount + wordTokens > chunkSize && currentChunk.trim().length > 0) {
      // Save current chunk
      chunks.push({
        content: currentChunk.trim(),
        metadata: {
          chunkIndex,
          startPosition: chunkStartPos,
          endPosition: currentPos,
          tokenCount: currentTokenCount,
        },
      });
      chunkIndex++;

      // Handle overlap - go back and include some previous content
      if (chunkOverlap > 0) {
        const overlapResult = findOverlapStart(chunks, chunkOverlap, text);
        currentChunk = overlapResult.text;
        currentTokenCount = overlapResult.tokens;
        chunkStartPos = overlapResult.position;
      } else {
        currentChunk = "";
        currentTokenCount = 0;
        chunkStartPos = currentPos;
      }
    }

    currentChunk += word;
    currentTokenCount += wordTokens;
    currentPos += word.length;
  }

  // Add final chunk
  if (currentChunk.trim().length > 0) {
    chunks.push({
      content: currentChunk.trim(),
      metadata: {
        chunkIndex,
        startPosition: chunkStartPos,
        endPosition: currentPos,
        tokenCount: countTokens(currentChunk.trim()),
      },
    });
  }

  return chunks;
}

/**
 * Find overlap text from previous chunks
 */
function findOverlapStart(
  chunks: TextChunk[],
  overlapTokens: number,
  _fullText: string,
): { text: string; tokens: number; position: number } {
  if (chunks.length === 0) {
    return { text: "", tokens: 0, position: 0 };
  }

  const lastChunk = chunks[chunks.length - 1];
  const words = lastChunk.content.split(/(\s+)/);
  
  let overlapText = "";
  let tokenCount = 0;
  
  // Work backwards from the end of the last chunk
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i];
    const wordTokens = countTokens(word);
    
    if (tokenCount + wordTokens > overlapTokens) {
      break;
    }
    
    overlapText = word + overlapText;
    tokenCount += wordTokens;
  }

  const overlapStartPos = lastChunk.metadata.endPosition - overlapText.length;
  
  return {
    text: overlapText,
    tokens: tokenCount,
    position: overlapStartPos,
  };
}

/**
 * Chunk by paragraphs, merging small paragraphs and splitting large ones
 */
function chunkByParagraph(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
): TextChunk[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: TextChunk[] = [];
  
  let currentChunk = "";
  let currentTokenCount = 0;
  let chunkStartPos = 0;
  let currentPos = 0;
  let chunkIndex = 0;

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) {
      currentPos += paragraph.length + 2; // Account for newlines
      continue;
    }

    const paragraphTokens = countTokens(trimmed);

    // If single paragraph exceeds chunk size, use token-based chunking
    if (paragraphTokens > chunkSize) {
      // Save current chunk if any
      if (currentChunk.trim().length > 0) {
        chunks.push({
          content: currentChunk.trim(),
          metadata: {
            chunkIndex,
            startPosition: chunkStartPos,
            endPosition: currentPos,
            tokenCount: currentTokenCount,
          },
        });
        chunkIndex++;
        currentChunk = "";
        currentTokenCount = 0;
      }

      // Split large paragraph by tokens
      const subChunks = chunkByTokens(trimmed, chunkSize, chunkOverlap);
      for (const subChunk of subChunks) {
        chunks.push({
          content: subChunk.content,
          metadata: {
            chunkIndex,
            startPosition: currentPos + subChunk.metadata.startPosition,
            endPosition: currentPos + subChunk.metadata.endPosition,
            tokenCount: subChunk.metadata.tokenCount,
          },
        });
        chunkIndex++;
      }
      chunkStartPos = currentPos + trimmed.length;
    } else if (currentTokenCount + paragraphTokens > chunkSize) {
      // Save current chunk and start new one
      if (currentChunk.trim().length > 0) {
        chunks.push({
          content: currentChunk.trim(),
          metadata: {
            chunkIndex,
            startPosition: chunkStartPos,
            endPosition: currentPos,
            tokenCount: currentTokenCount,
          },
        });
        chunkIndex++;
      }
      currentChunk = trimmed;
      currentTokenCount = paragraphTokens;
      chunkStartPos = currentPos;
    } else {
      // Add to current chunk
      currentChunk += (currentChunk ? "\n\n" : "") + trimmed;
      currentTokenCount += paragraphTokens;
    }

    currentPos += paragraph.length + 2;
  }

  // Add final chunk
  if (currentChunk.trim().length > 0) {
    chunks.push({
      content: currentChunk.trim(),
      metadata: {
        chunkIndex,
        startPosition: chunkStartPos,
        endPosition: currentPos,
        tokenCount: countTokens(currentChunk.trim()),
      },
    });
  }

  return chunks;
}

/**
 * Chunk by sentences, respecting sentence boundaries
 */
function chunkBySentence(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
): TextChunk[] {
  // Simple sentence splitting - matches ., !, ? followed by space or end
  const sentences = text.match(/[^.!?]*[.!?]+[\s]*/g) || [text];
  const chunks: TextChunk[] = [];
  
  let currentChunk = "";
  let currentTokenCount = 0;
  let chunkStartPos = 0;
  let currentPos = 0;
  let chunkIndex = 0;

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      currentPos += sentence.length;
      continue;
    }

    const sentenceTokens = countTokens(trimmed);

    // If single sentence exceeds chunk size, use token-based chunking
    if (sentenceTokens > chunkSize) {
      if (currentChunk.trim().length > 0) {
        chunks.push({
          content: currentChunk.trim(),
          metadata: {
            chunkIndex,
            startPosition: chunkStartPos,
            endPosition: currentPos,
            tokenCount: currentTokenCount,
          },
        });
        chunkIndex++;
        currentChunk = "";
        currentTokenCount = 0;
      }

      const subChunks = chunkByTokens(trimmed, chunkSize, chunkOverlap);
      for (const subChunk of subChunks) {
        chunks.push({
          content: subChunk.content,
          metadata: {
            chunkIndex,
            startPosition: currentPos + subChunk.metadata.startPosition,
            endPosition: currentPos + subChunk.metadata.endPosition,
            tokenCount: subChunk.metadata.tokenCount,
          },
        });
        chunkIndex++;
      }
      chunkStartPos = currentPos + sentence.length;
    } else if (currentTokenCount + sentenceTokens > chunkSize) {
      if (currentChunk.trim().length > 0) {
        chunks.push({
          content: currentChunk.trim(),
          metadata: {
            chunkIndex,
            startPosition: chunkStartPos,
            endPosition: currentPos,
            tokenCount: currentTokenCount,
          },
        });
        chunkIndex++;
      }
      currentChunk = trimmed;
      currentTokenCount = sentenceTokens;
      chunkStartPos = currentPos;
    } else {
      currentChunk += (currentChunk ? " " : "") + trimmed;
      currentTokenCount += sentenceTokens;
    }

    currentPos += sentence.length;
  }

  // Add final chunk
  if (currentChunk.trim().length > 0) {
    chunks.push({
      content: currentChunk.trim(),
      metadata: {
        chunkIndex,
        startPosition: chunkStartPos,
        endPosition: currentPos,
        tokenCount: countTokens(currentChunk.trim()),
      },
    });
  }

  return chunks;
}

/**
 * Calculate content hash for deduplication
 */
export function hashContent(content: string): string {
  // Simple hash function - in production, consider using crypto.subtle
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

/**
 * Calculate a more robust SHA-256 hash (if crypto available)
 */
export async function hashContentSHA256(content: string): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Fallback to simple hash
    return hashContent(content);
  }
}

