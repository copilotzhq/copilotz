/**
 * Knowledge Base Database Schema
 * PostgreSQL schema definitions for ominipg integration
 */

// =============================================================================
// SCHEMA DDL STATEMENTS
// =============================================================================

export const knowledgeBaseSchema = [
  // Enable required extensions
  `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,
  `CREATE EXTENSION IF NOT EXISTS "vector"`, // For pgvector if available
  `CREATE EXTENSION IF NOT EXISTS "pg_trgm"`, // For text search
  
  // Collections table
  `CREATE TABLE IF NOT EXISTS collections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // Documents table
  `CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    document_type VARCHAR(50) NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    source_url TEXT,
    file_name VARCHAR(255),
    file_size BIGINT,
    mime_type VARCHAR(100),
    metadata JSONB DEFAULT '{}',
    extracted_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    status VARCHAR(50) DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed', 'indexed')),
    error_message TEXT
  )`,

  // Chunks table (for text segmentation and embeddings)
  `CREATE TABLE IF NOT EXISTS chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    start_index INTEGER NOT NULL,
    end_index INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    metadata JSONB DEFAULT '{}',
    embedding VECTOR(1536), -- Default to OpenAI dimensions, can be adjusted
    embedding_model VARCHAR(100),
    embedded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(document_id, chunk_index)
  )`,

  // Document-Collection relationship (many-to-many)
  `CREATE TABLE IF NOT EXISTS document_collections (
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (document_id, collection_id)
  )`,

  // Indexing for performance
  `CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_metadata ON documents USING GIN(metadata)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_content_fts ON documents USING GIN(to_tsvector('english', content))`,
  
  `CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_content_fts ON chunks USING GIN(to_tsvector('english', content))`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_metadata ON chunks USING GIN(metadata)`,
  
  // Vector similarity search index (if pgvector is available)
  `CREATE INDEX IF NOT EXISTS idx_chunks_embedding_cosine ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
  
  `CREATE INDEX IF NOT EXISTS idx_collections_name ON collections(name)`,
  `CREATE INDEX IF NOT EXISTS idx_document_collections_collection ON document_collections(collection_id)`,

];

// =============================================================================
// ALTERNATIVE SCHEMA WITHOUT PGVECTOR (fallback)
// =============================================================================

export const knowledgeBaseSchemaNoPgVector = [
  // Enable required extensions (without vector)
  `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,
  `CREATE EXTENSION IF NOT EXISTS "pg_trgm"`,
  
  // Collections table
  `CREATE TABLE IF NOT EXISTS collections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // Documents table
  `CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    document_type VARCHAR(50) NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    source_url TEXT,
    file_name VARCHAR(255),
    file_size BIGINT,
    mime_type VARCHAR(100),
    metadata JSONB DEFAULT '{}',
    extracted_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    status VARCHAR(50) DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed', 'indexed')),
    error_message TEXT
  )`,

  // Chunks table without vector column
  `CREATE TABLE IF NOT EXISTS chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    start_index INTEGER NOT NULL,
    end_index INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    metadata JSONB DEFAULT '{}',
    embedding_json TEXT, -- Store as JSON string
    embedding_model VARCHAR(100),
    embedded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(document_id, chunk_index)
  )`,

  // Document-Collection relationship
  `CREATE TABLE IF NOT EXISTS document_collections (
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (document_id, collection_id)
  )`,

  // Basic indexes
  `CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_metadata ON documents USING GIN(metadata)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_content_fts ON documents USING GIN(to_tsvector('english', content))`,
  
  `CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_content_fts ON chunks USING GIN(to_tsvector('english', content))`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_metadata ON chunks USING GIN(metadata)`,
  
  `CREATE INDEX IF NOT EXISTS idx_collections_name ON collections(name)`,
  `CREATE INDEX IF NOT EXISTS idx_document_collections_collection ON document_collections(collection_id)`,

];

// =============================================================================
// MIGRATION UTILITIES
// =============================================================================

export const migrations = {
  // Add vector column if pgvector becomes available
  addVectorSupport: [
    `ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding VECTOR(1536)`,
    `CREATE INDEX IF NOT EXISTS idx_chunks_embedding_cosine ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    `ALTER TABLE chunks DROP COLUMN IF EXISTS embedding_json`
  ],

  // Remove vector column and fallback to JSON
  removeVectorSupport: [
    `ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_json TEXT`,
    `UPDATE chunks SET embedding_json = embedding::text WHERE embedding IS NOT NULL`,
    `DROP INDEX IF EXISTS idx_chunks_embedding_cosine`,
    `ALTER TABLE chunks DROP COLUMN IF EXISTS embedding`
  ],

  // Add full-text search improvements
  enhanceTextSearch: [
    `CREATE INDEX IF NOT EXISTS idx_documents_title_fts ON documents USING GIN(to_tsvector('english', title))`,
    `CREATE INDEX IF NOT EXISTS idx_chunks_content_trigram ON chunks USING GIN(content gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_documents_content_trigram ON documents USING GIN(content gin_trgm_ops)`
  ]
};

// =============================================================================
// SCHEMA VALIDATION
// =============================================================================

export const schemaValidation = {
  checkPgVectorSupport: `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector')`,
  checkPgTrgmSupport: `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')`,
  checkTableExists: (tableName: string) => `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = '${tableName}')`,
  getEmbeddingDimensions: `SELECT typlen FROM pg_type WHERE typname = 'vector'`
};

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

export const defaultSchemaConfig = {
  embeddingDimensions: 1536, // OpenAI default
  useVector: true, // Try to use pgvector if available
  fallbackToJson: true, // Fallback to JSON storage if pgvector unavailable
  enableFullTextSearch: true,
  enableTrigrams: true
}; 