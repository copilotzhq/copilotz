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
CREATE EXTENSION IF NOT EXISTS "vector";
`;
