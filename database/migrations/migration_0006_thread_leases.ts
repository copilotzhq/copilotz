export const generateThreadLeasesMigrations = (): string => `
-- Thread leases: allow only one worker to process a thread at a time,
-- and recover quickly after crashes/restarts without waiting for stale thresholds.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'threads'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'threads'
        AND column_name = 'workerLockedBy'
    ) THEN
      ALTER TABLE "threads" ADD COLUMN "workerLockedBy" VARCHAR(255);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'threads'
        AND column_name = 'workerLeaseExpiresAt'
    ) THEN
      ALTER TABLE "threads" ADD COLUMN "workerLeaseExpiresAt" TIMESTAMP;
    END IF;
  END IF;
END $$;

-- Optional index to speed up lease checks (safe to re-run)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'threads_worker_lease_idx'
  ) THEN
    CREATE INDEX "threads_worker_lease_idx"
      ON "threads" ("workerLeaseExpiresAt", "workerLockedBy");
  END IF;
END $$;
`;
