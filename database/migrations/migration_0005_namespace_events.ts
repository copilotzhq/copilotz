/**
 * Migration to add namespace support to events table.
 * 
 * This enables multi-tenant isolation for the event queue.
 * Events can be scoped to a namespace (e.g., tenant ID).
 * 
 * Uses exception handling for robustness - avoids race conditions
 * with information_schema checks that can fail in certain scenarios.
 */
export const generateNamespaceEventsMigrations = (): string => `
-- ============================================
-- ADD NAMESPACE TO EVENTS TABLE
-- ============================================

-- Add namespace column using exception handling (more robust than IF NOT EXISTS check)
DO $$
BEGIN
  -- Try to add the column - will fail safely if it exists
  ALTER TABLE "events" ADD COLUMN "namespace" VARCHAR(255);
EXCEPTION 
  WHEN duplicate_column THEN
    -- Column already exists, that's fine
    NULL;
  WHEN undefined_table THEN
    -- Table doesn't exist yet, that's also fine (will be created by migration_0001)
    NULL;
END $$;

-- Create namespace index (separate statement for better error isolation)
DO $$
BEGIN
  -- Only proceed if both table and column exist
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'events' AND column_name = 'namespace'
  ) THEN
    -- Create index for namespace queries
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_events_namespace') THEN
      CREATE INDEX "idx_events_namespace" ON "events" ("namespace");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Log but don't fail
  RAISE NOTICE 'idx_events_namespace creation skipped: %', SQLERRM;
END $$;

-- Create namespace+status composite index
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'events' AND column_name = 'namespace'
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_events_namespace_status') THEN
      CREATE INDEX "idx_events_namespace_status" ON "events" ("namespace", "status");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_events_namespace_status creation skipped: %', SQLERRM;
END $$;

-- Update pending events index to include namespace for better query performance
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'events' AND column_name = 'namespace'
  ) THEN
    -- Drop old index and recreate with namespace
    DROP INDEX IF EXISTS "idx_events_pending_order";
    CREATE INDEX "idx_events_pending_order"
      ON "events" (
        "threadId",
        "namespace",
        (COALESCE("priority", 0)) DESC,
        "createdAt" ASC,
        "id" ASC
      )
      WHERE "status" = 'pending';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_events_pending_order update skipped: %', SQLERRM;
END $$;
`;

