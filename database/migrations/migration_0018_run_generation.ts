/**
 * Add framework-owned run generations to thread and event rows.
 *
 * A human/job abort advances the thread generation before its message event is
 * committed. Continuations carry the generation that created them, allowing
 * the runtime to reject stale work without relying on timestamps or model
 * generated identifiers.
 */
export const generateRunGenerationMigrations = (): string => `
ALTER TABLE "threads"
  ADD COLUMN IF NOT EXISTS "runGeneration" integer DEFAULT 0 NOT NULL;

ALTER TABLE "events"
  ADD COLUMN IF NOT EXISTS "runGeneration" integer;

CREATE INDEX IF NOT EXISTS "idx_events_thread_run_generation_status"
  ON "events" ("threadId", "runGeneration", "status");
`;
