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

-- Add namespace column to events (nullable for backwards compatibility)
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "namespace" VARCHAR(255);

-- Create index for namespace queries
CREATE INDEX IF NOT EXISTS "idx_events_namespace" ON "events" ("namespace");

-- Create composite index for namespace + status queries
CREATE INDEX IF NOT EXISTS "idx_events_namespace_status" ON "events" ("namespace", "status");

-- Update pending events index to include namespace
DROP INDEX IF EXISTS "idx_events_pending_order";
CREATE INDEX IF NOT EXISTS "idx_events_pending_order"
  ON "events" (
    "threadId",
    "namespace",
    (COALESCE("priority", 0)) DESC,
    "createdAt" ASC,
    "id" ASC
  )
  WHERE "status" = 'pending';
`;

