/**
 * RAG (Retrieval-Augmented Generation) Migration
 * 
 * Creates tables for document storage and vector embeddings:
 * - documents: Source documents with metadata and status
 * - document_chunks: Chunked content with vector embeddings
 * 
 * Requires pgvector extension for vector similarity search.
 */

export const generateRagMigrations = (): string => `
-- Enable vector extension for embeddings (safe to re-run)
CREATE EXTENSION IF NOT EXISTS vector;

-- Documents table: stores source document metadata
CREATE TABLE IF NOT EXISTS "documents" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "namespace" varchar(255) NOT NULL DEFAULT 'default',
  "externalId" varchar(255),
  "sourceType" varchar(64) NOT NULL,
  "sourceUri" text,
  "title" text,
  "mimeType" varchar(128),
  "contentHash" varchar(128) NOT NULL,
  "assetId" varchar(255),
  "status" varchar(32) DEFAULT 'pending' NOT NULL,
  "chunkCount" integer,
  "errorMessage" text,
  "metadata" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

-- Document chunks table: stores chunked content with embeddings
CREATE TABLE IF NOT EXISTS "document_chunks" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "documentId" varchar(255) NOT NULL,
  "namespace" varchar(255) NOT NULL,
  "chunkIndex" integer NOT NULL,
  "content" text NOT NULL,
  "tokenCount" integer,
  "embedding" vector(1536),
  "startPosition" integer,
  "endPosition" integer,
  "metadata" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

-- Foreign key constraint (wrapped in DO block to handle existing data gracefully)
DO $$
BEGIN
  -- Drop old constraint if exists
  ALTER TABLE "document_chunks"
    DROP CONSTRAINT IF EXISTS "document_chunks_documentId_documents_id_fk";
  
  -- Try to add constraint, but don't fail if data violates it
  BEGIN
    ALTER TABLE "document_chunks"
      ADD CONSTRAINT "document_chunks_documentId_documents_id_fk"
      FOREIGN KEY ("documentId") REFERENCES "documents"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'FK constraint document_chunks_documentId_documents_id_fk not added: %', SQLERRM;
  END;
END $$;

-- Indexes for documents table (wrapped in DO blocks for error isolation)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_documents_namespace') THEN
    CREATE INDEX "idx_documents_namespace" ON "documents" ("namespace");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_documents_namespace_status') THEN
    CREATE INDEX "idx_documents_namespace_status" ON "documents" ("namespace", "status");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_documents_content_hash') THEN
    CREATE INDEX "idx_documents_content_hash" ON "documents" ("contentHash", "namespace");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_documents_external_id') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'documents' AND column_name = 'externalId') THEN
      CREATE INDEX "idx_documents_external_id" ON "documents" ("externalId");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_documents_asset_id') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'documents' AND column_name = 'assetId') THEN
      CREATE INDEX "idx_documents_asset_id" ON "documents" ("assetId");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Indexes for document_chunks table
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_chunks_document_id') THEN
    CREATE INDEX "idx_chunks_document_id" ON "document_chunks" ("documentId");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_chunks_namespace') THEN
    CREATE INDEX "idx_chunks_namespace" ON "document_chunks" ("namespace");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_chunks_namespace_document') THEN
    CREATE INDEX "idx_chunks_namespace_document" ON "document_chunks" ("namespace", "documentId");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_chunks_document_chunk_unique') THEN
    CREATE UNIQUE INDEX "idx_chunks_document_chunk_unique" ON "document_chunks" ("documentId", "chunkIndex");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
`;
