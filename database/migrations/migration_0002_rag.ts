/**
 * RAG (Retrieval-Augmented Generation) Migration
 *
 * Keeps the vector extension available for graph-backed retrieval.
 * Document and chunk content now live in graph nodes rather than dedicated
 * relational tables.
 */

export const generateRagMigrations = (): string => `
-- Enable vector extension for embeddings (safe to re-run)
CREATE EXTENSION IF NOT EXISTS "vector";
`;
