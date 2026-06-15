export const generateThreadActivityIndexesMigrations = (): string => `
-- Thread activity read model indexes. These support foreground queue checks
-- without introducing a separate run/activity table.

CREATE INDEX IF NOT EXISTS "idx_events_thread_status_priority"
  ON "events" ("threadId", "status", (COALESCE("priority", 0)), "createdAt", "id");

CREATE INDEX IF NOT EXISTS "idx_events_thread_status_updated"
  ON "events" ("threadId", "status", (COALESCE("priority", 0)), "updatedAt", "createdAt");
`;
