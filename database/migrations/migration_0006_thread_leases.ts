export const generateThreadLeasesMigrations = (): string => `
-- Thread leases: allow only one worker to process a thread at a time,
-- and recover quickly after crashes/restarts without waiting for stale thresholds.

ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "workerLockedBy" VARCHAR(255);
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "workerLeaseExpiresAt" TIMESTAMP;

-- Optional index to speed up lease checks (safe to re-run)
CREATE INDEX IF NOT EXISTS "threads_worker_lease_idx"
  ON "threads" ("workerLeaseExpiresAt", "workerLockedBy");
`;
