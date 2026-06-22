export const generateAdminLlmAttemptIndexesMigrations = (): string => `
CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_time"
  ON "nodes" ("namespace", "created_at")
  WHERE "type" = 'llm_attempt';

CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_agent_time"
  ON "nodes" ("namespace", ("data"->>'agentId'), "created_at")
  WHERE "type" = 'llm_attempt';

CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_initiator_time"
  ON "nodes" (
    "namespace",
    (COALESCE("data"->'runSender'->>'externalId', "data"->'runSender'->>'id', "data"->'runSender'->>'email', "data"->'runSender'->>'name', '')),
    "created_at"
  )
  WHERE "type" = 'llm_attempt';

CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_provider_time"
  ON "nodes" ("namespace", ("data"->>'provider'), "created_at")
  WHERE "type" = 'llm_attempt';

CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_model_time"
  ON "nodes" ("namespace", ("data"->>'model'), "created_at")
  WHERE "type" = 'llm_attempt';
`;
