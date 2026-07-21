/** Supports lightweight trace completion checks without scanning event payloads. */
export const generateTraceWaitIndexMigrations = (): string => `
CREATE INDEX IF NOT EXISTS "idx_events_trace_status"
  ON "events" ("traceId", "status");
`;
