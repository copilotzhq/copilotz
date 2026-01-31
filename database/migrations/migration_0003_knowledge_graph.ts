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

-- Add FK constraints for edges (in DO block for better error handling)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = current_schema() AND table_name = 'edges'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = current_schema() AND table_name = 'nodes'
  ) THEN
    -- Add source FK if not exists
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints 
      WHERE table_schema = current_schema() 
        AND table_name = 'edges' 
        AND constraint_name = 'edges_source_node_id_nodes_fk'
    ) THEN
      BEGIN
        ALTER TABLE "edges" ADD CONSTRAINT "edges_source_node_id_nodes_fk"
          FOREIGN KEY ("source_node_id") REFERENCES "nodes"("id") ON DELETE CASCADE;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'FK edges_source_node_id_nodes_fk not added: %', SQLERRM;
      END;
    END IF;
    
    -- Add target FK if not exists
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints 
      WHERE table_schema = current_schema() 
        AND table_name = 'edges' 
        AND constraint_name = 'edges_target_node_id_nodes_fk'
    ) THEN
      BEGIN
        ALTER TABLE "edges" ADD CONSTRAINT "edges_target_node_id_nodes_fk"
          FOREIGN KEY ("target_node_id") REFERENCES "nodes"("id") ON DELETE CASCADE;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'FK edges_target_node_id_nodes_fk not added: %', SQLERRM;
      END;
    END IF;
  END IF;
END $$;

-- ============================================
-- INDEXES FOR NODES (wrapped in DO blocks for error isolation)
-- ============================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_nodes_namespace') THEN
    CREATE INDEX "idx_nodes_namespace" ON "nodes"("namespace");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_nodes_type') THEN
    CREATE INDEX "idx_nodes_type" ON "nodes"("type");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_nodes_namespace_type') THEN
    CREATE INDEX "idx_nodes_namespace_type" ON "nodes"("namespace", "type");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_nodes_source') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'nodes' AND column_name = 'source_type') THEN
      CREATE INDEX "idx_nodes_source" ON "nodes"("source_type", "source_id");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_nodes_embedding') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'nodes' AND column_name = 'embedding') THEN
      CREATE INDEX "idx_nodes_embedding" ON "nodes" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_nodes_name') THEN
    CREATE INDEX "idx_nodes_name" ON "nodes"("name");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_nodes_data') THEN
    CREATE INDEX "idx_nodes_data" ON "nodes" USING gin ("data");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ============================================
-- INDEXES FOR EDGES (wrapped in DO blocks for error isolation)
-- ============================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_edges_source') THEN
    CREATE INDEX "idx_edges_source" ON "edges"("source_node_id");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_edges_target') THEN
    CREATE INDEX "idx_edges_target" ON "edges"("target_node_id");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_edges_type') THEN
    CREATE INDEX "idx_edges_type" ON "edges"("type");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_edges_source_type') THEN
    CREATE INDEX "idx_edges_source_type" ON "edges"("source_node_id", "type");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_edges_target_type') THEN
    CREATE INDEX "idx_edges_target_type" ON "edges"("target_node_id", "type");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

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

