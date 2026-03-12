/**
 * Knowledge Graph Migration
 * 
 * Creates unified nodes and edges tables that generalize RAG chunks
 * into a full knowledge graph structure.
 * 
 * The existing document_chunks table is kept for backward compatibility
 * but new ingestion will populate the nodes table instead.
 */
export const generateKnowledgeGraphMigrations = (): string => `
-- ============================================
-- KNOWLEDGE GRAPH TABLES
-- ============================================

-- Unified nodes table: chunks, entities, concepts, decisions, etc.
CREATE TABLE IF NOT EXISTS "nodes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "namespace" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "embedding" VECTOR(1536),
  "content" TEXT,
  "data" JSONB DEFAULT '{}',
  "source_type" TEXT,
  "source_id" TEXT,
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Edges: relationships between nodes (created without inline FK for better error handling)
CREATE TABLE IF NOT EXISTS "edges" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_node_id" UUID NOT NULL,
  "target_node_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "data" JSONB DEFAULT '{}',
  "weight" FLOAT DEFAULT 1.0,
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

/* Idempotent FKs: drop first (IF EXISTS), then re-add. NOT VALID skips existing-row checks. */
ALTER TABLE "edges" DROP CONSTRAINT IF EXISTS "edges_source_node_id_nodes_fk";
ALTER TABLE "edges" ADD CONSTRAINT "edges_source_node_id_nodes_fk"
  FOREIGN KEY ("source_node_id") REFERENCES "nodes"("id") ON DELETE CASCADE NOT VALID;

ALTER TABLE "edges" DROP CONSTRAINT IF EXISTS "edges_target_node_id_nodes_fk";
ALTER TABLE "edges" ADD CONSTRAINT "edges_target_node_id_nodes_fk"
  FOREIGN KEY ("target_node_id") REFERENCES "nodes"("id") ON DELETE CASCADE NOT VALID;

-- Indexes for nodes
CREATE INDEX IF NOT EXISTS "idx_nodes_namespace" ON "nodes"("namespace");
CREATE INDEX IF NOT EXISTS "idx_nodes_type" ON "nodes"("type");
CREATE INDEX IF NOT EXISTS "idx_nodes_namespace_type" ON "nodes"("namespace", "type");
CREATE INDEX IF NOT EXISTS "idx_nodes_source" ON "nodes"("source_type", "source_id");
CREATE INDEX IF NOT EXISTS "idx_nodes_embedding" ON "nodes" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS "idx_nodes_name" ON "nodes"("name");
CREATE INDEX IF NOT EXISTS "idx_nodes_data" ON "nodes" USING gin ("data");

-- Indexes for edges
CREATE INDEX IF NOT EXISTS "idx_edges_source" ON "edges"("source_node_id");
CREATE INDEX IF NOT EXISTS "idx_edges_target" ON "edges"("target_node_id");
CREATE INDEX IF NOT EXISTS "idx_edges_type" ON "edges"("type");
CREATE INDEX IF NOT EXISTS "idx_edges_source_type" ON "edges"("source_node_id", "type");
CREATE INDEX IF NOT EXISTS "idx_edges_target_type" ON "edges"("target_node_id", "type");

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_node_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updated_at" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update timestamp
DROP TRIGGER IF EXISTS "trigger_nodes_updated_at" ON "nodes";
CREATE TRIGGER "trigger_nodes_updated_at"
  BEFORE UPDATE ON "nodes"
  FOR EACH ROW
  EXECUTE FUNCTION update_node_timestamp();
`;

