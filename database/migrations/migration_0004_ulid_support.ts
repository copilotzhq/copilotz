/**
 * Migration to change UUID columns to TEXT for ULID support.
 * 
 * This makes the nodes/edges tables consistent with the rest of the project
 * which uses ULID for IDs (stored as TEXT/VARCHAR).
 */
export const generateUlidSupportMigrations = (): string => `
-- ============================================
-- ALTER ID COLUMNS FOR ULID SUPPORT
-- ============================================

-- Only run if nodes table exists (skip for databases without graph tables yet)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'nodes') THEN
    -- Drop existing foreign key constraints
    ALTER TABLE "edges" DROP CONSTRAINT IF EXISTS "edges_source_node_id_fkey";
    ALTER TABLE "edges" DROP CONSTRAINT IF EXISTS "edges_target_node_id_fkey";

    -- Alter nodes.id from UUID to TEXT (if not already TEXT)
    IF EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_name = 'nodes' AND column_name = 'id' AND data_type = 'uuid'
    ) THEN
      ALTER TABLE "nodes" ALTER COLUMN "id" TYPE TEXT USING "id"::TEXT;
      ALTER TABLE "nodes" ALTER COLUMN "id" SET DEFAULT NULL;
    END IF;

    -- Alter edges columns from UUID to TEXT (if not already TEXT)
    IF EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_name = 'edges' AND column_name = 'id' AND data_type = 'uuid'
    ) THEN
      ALTER TABLE "edges" ALTER COLUMN "id" TYPE TEXT USING "id"::TEXT;
      ALTER TABLE "edges" ALTER COLUMN "id" SET DEFAULT NULL;
      ALTER TABLE "edges" ALTER COLUMN "source_node_id" TYPE TEXT USING "source_node_id"::TEXT;
      ALTER TABLE "edges" ALTER COLUMN "target_node_id" TYPE TEXT USING "target_node_id"::TEXT;
    END IF;

    -- Re-add foreign key constraints with TEXT type
    BEGIN
      ALTER TABLE "edges" ADD CONSTRAINT "edges_source_node_id_fkey" 
        FOREIGN KEY ("source_node_id") REFERENCES "nodes"("id") ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    
    BEGIN
      ALTER TABLE "edges" ADD CONSTRAINT "edges_target_node_id_fkey" 
        FOREIGN KEY ("target_node_id") REFERENCES "nodes"("id") ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;
`;

