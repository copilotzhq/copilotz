/**
 * Partial indexes for the unified `usage` ledger (node type = 'usage').
 *
 * Mirrors the admin llm_attempt indexes but targets the lightweight usage
 * ledger that the cost dashboards aggregate. Because usage rows are small and
 * carry no conversation payload, these support fast time/group-scoped
 * aggregation without TOAST detoasting.
 */
export const generateUsageLedgerIndexesMigrations = (): string => `
CREATE INDEX IF NOT EXISTS "idx_nodes_usage_time"
  ON "nodes" ("namespace", "created_at")
  WHERE "type" = 'usage';

CREATE INDEX IF NOT EXISTS "idx_nodes_usage_kind_time"
  ON "nodes" ("namespace", ("data"->>'kind'), "created_at")
  WHERE "type" = 'usage';

CREATE INDEX IF NOT EXISTS "idx_nodes_usage_agent_time"
  ON "nodes" ("namespace", ("data"->>'agentId'), "created_at")
  WHERE "type" = 'usage';

CREATE INDEX IF NOT EXISTS "idx_nodes_usage_initiator_time"
  ON "nodes" ("namespace", ("data"->>'initiatedById'), "created_at")
  WHERE "type" = 'usage';

CREATE INDEX IF NOT EXISTS "idx_nodes_usage_provider_time"
  ON "nodes" ("namespace", ("data"->>'provider'), "created_at")
  WHERE "type" = 'usage';

CREATE INDEX IF NOT EXISTS "idx_nodes_usage_model_time"
  ON "nodes" ("namespace", ("data"->>'model'), "created_at")
  WHERE "type" = 'usage';

CREATE INDEX IF NOT EXISTS "idx_nodes_usage_thread_time"
  ON "nodes" ("namespace", ("data"->>'threadId'), "created_at")
  WHERE "type" = 'usage';

CREATE INDEX IF NOT EXISTS "idx_nodes_usage_dedupe"
  ON "nodes" ("namespace", ("data"->>'dedupeKey'))
  WHERE "type" = 'usage' AND ("data"->>'dedupeKey') IS NOT NULL;
`;
