/**
 * Knowledge Base Service Types
 * Comprehensive type definitions for document processing, storage, and retrieval
 */

// =============================================================================
// DOCUMENT TYPES & SOURCES
// =============================================================================

export type DocumentType = 'pdf' | 'doc' | 'docx' | 'txt' | 'md' | 'web' | 'video' | 'audio' | 'csv' | 'json';

export type DocumentSource = {
  type: 'file';
  file: File | Blob;
  fileName?: string;
} | {
  type: 'url';
  url: string;
  headers?: Record<string, string>;
} | {
  type: 'text';
  content: string;
  title?: string;
} | {
  type: 'base64';
  data: string;
  mimeType: string;
  fileName?: string;
};

// =============================================================================
// EXTRACTION PROVIDER TYPES
// =============================================================================

export type ExtractorName = 'pdf' | 'web' | 'text' | 'video' | 'doc' | 'audio' | 'csv' | 'json';

export interface ExtractorConfig {
  provider: ExtractorName;
  options?: {
    // PDF specific
    pages?: number[];
    ocrLanguage?: string;
    
    // Web specific
    selector?: string;
    waitFor?: number;
    maxDepth?: number;
    followLinks?: boolean;
    
    // Video/Audio specific
    transcriptionProvider?: 'openai' | 'assemblyai' | 'deepgram';
    language?: string;
    
    // Text chunking
    chunkSize?: number;
    chunkOverlap?: number;
    chunkStrategy?: 'sentences' | 'paragraphs' | 'fixed' | 'semantic';
    
    // General
    timeout?: number;
    retries?: number;
  };
}

export interface ExtractionRequest {
  source: DocumentSource;
  config: ExtractorConfig;
  metadata?: Record<string, any>;
}

export interface ExtractionResult {
  success: boolean;
  content?: string;
  metadata?: {
    title?: string;
    author?: string;
    pageCount?: number;
    duration?: number;
    language?: string;
    extractedAt: string;
    [key: string]: any;
  };
  chunks?: TextChunk[];
  error?: string;
  processingTime: number;
}

// =============================================================================
// TEXT CHUNKING TYPES
// =============================================================================

export interface TextChunk {
  id: string;
  content: string;
  startIndex: number;
  endIndex: number;
  metadata?: {
    page?: number;
    section?: string;
    title?: string;
    [key: string]: any;
  };
}

export interface ChunkingConfig {
  strategy: 'sentences' | 'paragraphs' | 'fixed' | 'semantic';
  size: number;
  overlap: number;
  preserveStructure?: boolean;
  minChunkSize?: number;
  maxChunkSize?: number;
}

// =============================================================================
// DATABASE ENTITY TYPES
// =============================================================================

export interface DocumentEntity {
  id: string;
  title: string;
  content: string;
  documentType: DocumentType;
  sourceType: DocumentSource['type'];
  sourceUrl?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  metadata: Record<string, any>;
  extractedAt: string;
  createdAt: string;
  updatedAt: string;
  status: 'processing' | 'completed' | 'failed' | 'indexed';
  errorMessage?: string;
}

export interface ChunkEntity {
  id: string;
  documentId: string;
  content: string;
  startIndex: number;
  endIndex: number;
  chunkIndex: number;
  metadata: Record<string, any>;
  embedding?: number[];
  embeddingModel?: string;
  embeddedAt?: string;
  createdAt: string;
}

export interface CollectionEntity {
  id: string;
  name: string;
  description?: string;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentCollectionEntity {
  documentId: string;
  collectionId: string;
  addedAt: string;
}

// =============================================================================
// KNOWLEDGE BASE OPERATIONS
// =============================================================================

export interface KnowledgeBaseConfig {
  database: {
    url: string;
    syncUrl?: string;
    schema?: string[];
  };
  embedding: {
    provider: 'openai' | 'cohere' | 'huggingface';
    model?: string;
    dimensions?: number;
  };
  chunking: ChunkingConfig;
  extractors: {
    [K in ExtractorName]?: ExtractorConfig['options'];
  };
}

// =============================================================================
// REQUEST/RESPONSE TYPES FOR UNIFIED INTERFACE
// =============================================================================

export type KnowledgeBaseRequest = 
  | { type: 'ingest'; source: DocumentSource; config?: Partial<ExtractorConfig>; collectionId?: string; }
  | { type: 'query'; query: string; config?: QueryConfig; collectionId?: string; }
  | { type: 'search'; query: string; config?: SearchConfig; collectionId?: string; }
  | { type: 'retrieve'; documentId: string; }
  | { type: 'delete'; documentId: string; }
  | { type: 'collections'; action: 'list' | 'create' | 'delete'; data?: any; };

export interface QueryConfig {
  limit?: number;
  threshold?: number;
  includeContent?: boolean;
  includeMetadata?: boolean;
  filter?: {
    documentType?: DocumentType[];
    createdAfter?: string;
    createdBefore?: string;
    metadata?: Record<string, any>;
  };
  rerank?: {
    provider?: 'cohere' | 'openai';
    model?: string;
  };
}

export interface SearchConfig extends QueryConfig {
  searchType: 'semantic' | 'keyword' | 'hybrid';
  keywordWeight?: number;
  semanticWeight?: number;
}

export type KnowledgeBaseResponse = 
  | { type: 'ingest'; success: boolean; documentId?: string; chunks?: number; error?: string; processingTime: number; }
  | { type: 'query'; results: SearchResult[]; totalResults: number; processingTime: number; }
  | { type: 'search'; results: SearchResult[]; totalResults: number; processingTime: number; }
  | { type: 'retrieve'; document?: DocumentEntity; chunks?: ChunkEntity[]; error?: string; }
  | { type: 'delete'; success: boolean; error?: string; }
  | { type: 'collections'; collections?: CollectionEntity[]; success?: boolean; error?: string; };

// =============================================================================
// SEARCH & QUERY TYPES
// =============================================================================

export interface SearchResult {
  documentId: string;
  chunkId: string;
  content: string;
  score: number;
  metadata: Record<string, any>;
  document: {
    title: string;
    documentType: DocumentType;
    sourceUrl?: string;
    fileName?: string;
    createdAt: string;
  };
  highlights?: string[];
}

export interface QueryOptions {
  embedding?: number[];
  keywords?: string[];
  filters?: Record<string, any>;
  limit?: number;
  offset?: number;
  threshold?: number;
}

// =============================================================================
// PROVIDER INTERFACES
// =============================================================================

export interface DocumentExtractor {
  name: ExtractorName;
  supportedTypes: DocumentType[];
  extract(request: ExtractionRequest): Promise<ExtractionResult>;
  validate(source: DocumentSource): boolean;
}

export interface ExtractorFactory {
  (config: ExtractorConfig): DocumentExtractor;
}

export interface ChunkingStrategy {
  chunk(content: string, config: ChunkingConfig): TextChunk[];
}

// =============================================================================
// DATABASE OPERATIONS
// =============================================================================

export interface DatabaseOperations {
  // Documents
  insertDocument(doc: Omit<DocumentEntity, 'id' | 'createdAt' | 'updatedAt'>): Promise<string>;
  getDocument(id: string): Promise<DocumentEntity | null>;
  updateDocument(id: string, updates: Partial<DocumentEntity>): Promise<boolean>;
  deleteDocument(id: string): Promise<boolean>;
  listDocuments(filters?: any, limit?: number, offset?: number): Promise<DocumentEntity[]>;
  
  // Chunks
  insertChunks(chunks: Omit<ChunkEntity, 'id' | 'createdAt'>[]): Promise<string[]>;
  getChunks(documentId: string): Promise<ChunkEntity[]>;
  updateChunkEmbedding(id: string, embedding: number[], model: string): Promise<boolean>;
  deleteChunks(documentId: string): Promise<boolean>;
  
  // Collections
  createCollection(collection: Omit<CollectionEntity, 'id' | 'createdAt' | 'updatedAt'>): Promise<string>;
  getCollection(id: string): Promise<CollectionEntity | null>;
  listCollections(): Promise<CollectionEntity[]>;
  addDocumentToCollection(documentId: string, collectionId: string): Promise<boolean>;
  removeDocumentFromCollection(documentId: string, collectionId: string): Promise<boolean>;
  
  // Search
  searchSemantic(embedding: number[], options: QueryOptions): Promise<SearchResult[]>;
  searchKeyword(query: string, options: QueryOptions): Promise<SearchResult[]>;
  searchHybrid(query: string, embedding: number[], options: QueryOptions): Promise<SearchResult[]>;
}

// =============================================================================
// ERROR TYPES
// =============================================================================

export class KnowledgeBaseError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'KnowledgeBaseError';
  }
}

export const ErrorCodes = {
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  EMBEDDING_FAILED: 'EMBEDDING_FAILED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INVALID_CONFIG: 'INVALID_CONFIG',
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  COLLECTION_NOT_FOUND: 'COLLECTION_NOT_FOUND',
} as const;

// =============================================================================
// UTILITY TYPES
// =============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequiredConfig<T> = T & Required<Pick<T, keyof T>>;

// =============================================================================
// RE-EXPORT COMMON TYPES
// =============================================================================

export type { File, Blob } from 'https://deno.land/std@0.208.0/streams/mod.ts'; 