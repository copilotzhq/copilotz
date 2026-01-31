/**
 * Migration to add namespace support to events table.
 * 
 * This enables multi-tenant isolation for the event queue.
 * Events can be scoped to a namespace (e.g., tenant ID).
 */
export const generateNamespaceEventsMigrations = (): string => `
-- ============================================
-- ADD NAMESPACE TO EVENTS TABLE
-- ============================================

-- Add namespace column and indexes in a single DO block to ensure atomicity
DO $$
BEGIN
  -- Ensure we're checking the current schema only
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'events'
  ) THEN
    -- Add namespace column if not exists
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = current_schema()
        AND table_name = 'events'
        AND column_name = 'namespace'
    ) THEN
      ALTER TABLE "events" ADD COLUMN "namespace" VARCHAR(255);
    END IF;

    -- Only create indexes if the column exists in the current schema
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'events'
        AND column_name = 'namespace'
    ) THEN
      -- Create index for namespace queries
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'idx_events_namespace'
      ) THEN
        CREATE INDEX "idx_events_namespace" ON "events" ("namespace");
      END IF;

      -- Create composite index for namespace + status queries
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'idx_events_namespace_status'
      ) THEN
        CREATE INDEX "idx_events_namespace_status" ON "events" ("namespace", "status");
      END IF;

      -- Update pending events index to include namespace
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
  END IF;
END $$;
`;

