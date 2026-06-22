/**
 * Mutation outbox columns.
 *
 * The physical table remains "events" for compatibility with existing queue,
 * stream, and admin surfaces. These columns let durable lifecycle facts be
 * recorded from graph/domain mutations with forensic before/after snapshots.
 */
export const generateMutationOutboxMigrations = (): string => `
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "subjectType" varchar(255);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "subjectId" varchar(255);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "operation" varchar(64);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "causationId" varchar(255);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "correlationId" varchar(255);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "dedupeKey" varchar(512);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "input" jsonb;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "before" jsonb;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "after" jsonb;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "patch" jsonb;

CREATE INDEX IF NOT EXISTS "idx_events_subject"
  ON "events" ("subjectType", "subjectId", "createdAt");

CREATE INDEX IF NOT EXISTS "idx_events_causation"
  ON "events" ("causationId");

CREATE INDEX IF NOT EXISTS "idx_events_correlation"
  ON "events" ("correlationId");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_events_dedupe_key"
  ON "events" ("dedupeKey")
  WHERE "dedupeKey" IS NOT NULL;
`;
