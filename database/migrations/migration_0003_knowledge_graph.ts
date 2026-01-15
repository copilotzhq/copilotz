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

-- Edges: relationships between nodes
CREATE TABLE IF NOT EXISTS "edges" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_node_id" UUID NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
  "target_node_id" UUID NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "data" JSONB DEFAULT '{}',
  "weight" FLOAT DEFAULT 1.0,
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- INDEXES FOR NODES
-- ============================================

-- Namespace-based queries (most common)
CREATE INDEX IF NOT EXISTS "idx_nodes_namespace" 
  ON "nodes"("namespace");

-- Type-based queries
CREATE INDEX IF NOT EXISTS "idx_nodes_type" 
  ON "nodes"("type");

-- Combined namespace + type (for scoped type queries)
CREATE INDEX IF NOT EXISTS "idx_nodes_namespace_type" 
  ON "nodes"("namespace", "type");

-- Source reference lookups (for provenance queries)
CREATE INDEX IF NOT EXISTS "idx_nodes_source" 
  ON "nodes"("source_type", "source_id");

-- Vector similarity search
CREATE INDEX IF NOT EXISTS "idx_nodes_embedding" 
  ON "nodes" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);

-- Name-based lookups (for entity matching)
CREATE INDEX IF NOT EXISTS "idx_nodes_name" 
  ON "nodes"("name");

-- GIN index for JSONB data queries
CREATE INDEX IF NOT EXISTS "idx_nodes_data" 
  ON "nodes" USING gin ("data");

-- ============================================
-- INDEXES FOR EDGES
-- ============================================

-- Outgoing edges from a node
CREATE INDEX IF NOT EXISTS "idx_edges_source" 
  ON "edges"("source_node_id");

-- Incoming edges to a node
CREATE INDEX IF NOT EXISTS "idx_edges_target" 
  ON "edges"("target_node_id");

-- Edge type queries (for filtered traversal)
CREATE INDEX IF NOT EXISTS "idx_edges_type" 
  ON "edges"("type");

-- Combined source + type (for typed outgoing traversal)
CREATE INDEX IF NOT EXISTS "idx_edges_source_type" 
  ON "edges"("source_node_id", "type");

-- Combined target + type (for typed incoming traversal)
CREATE INDEX IF NOT EXISTS "idx_edges_target_type" 
  ON "edges"("target_node_id", "type");

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

