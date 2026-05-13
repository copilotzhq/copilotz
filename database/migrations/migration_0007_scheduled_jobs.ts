export const generateScheduledJobsMigrations = (): string => `
-- Scheduled jobs are graph nodes. Runs are idempotent NEW_MESSAGE events.

CREATE INDEX IF NOT EXISTS "idx_nodes_scheduled_jobs_due"
  ON "nodes" (
    "namespace",
    ("data"->>'status'),
    ((NULLIF("data"->>'nextRunAtMs', '')::bigint))
  )
  WHERE "type" = 'scheduled_job';

CREATE INDEX IF NOT EXISTS "idx_nodes_scheduled_jobs_lease"
  ON "nodes" (
    "namespace",
    ((NULLIF("data"->>'leaseUntilMs', '')::bigint))
  )
  WHERE "type" = 'scheduled_job';

CREATE UNIQUE INDEX IF NOT EXISTS "idx_events_scheduled_job_run_id"
  ON "events" ((metadata->'scheduledJob'->>'runId'))
  WHERE metadata ? 'scheduledJob';
`;
