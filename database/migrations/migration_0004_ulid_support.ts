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

ALTER TABLE "edges" DROP CONSTRAINT IF EXISTS "edges_source_node_id_fkey";
ALTER TABLE "edges" DROP CONSTRAINT IF EXISTS "edges_target_node_id_fkey";
ALTER TABLE "edges" DROP CONSTRAINT IF EXISTS "edges_source_node_id_nodes_fk";
ALTER TABLE "edges" DROP CONSTRAINT IF EXISTS "edges_target_node_id_nodes_fk";

ALTER TABLE "nodes" ALTER COLUMN "id" TYPE TEXT USING "id"::TEXT;
ALTER TABLE "nodes" ALTER COLUMN "id" SET DEFAULT NULL;

ALTER TABLE "edges" ALTER COLUMN "id" TYPE TEXT USING "id"::TEXT;
ALTER TABLE "edges" ALTER COLUMN "id" SET DEFAULT NULL;
ALTER TABLE "edges" ALTER COLUMN "source_node_id" TYPE TEXT USING "source_node_id"::TEXT;
ALTER TABLE "edges" ALTER COLUMN "target_node_id" TYPE TEXT USING "target_node_id"::TEXT;

ALTER TABLE "edges" ADD CONSTRAINT "edges_source_node_id_fkey" 
FOREIGN KEY ("source_node_id") REFERENCES "nodes"("id") ON DELETE CASCADE;

ALTER TABLE "edges" ADD CONSTRAINT "edges_target_node_id_fkey" 
FOREIGN KEY ("target_node_id") REFERENCES "nodes"("id") ON DELETE CASCADE;

`;
