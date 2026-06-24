export const generateAdminLlmAttemptIndexesV2Migrations = (): string => `
CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_created_at"
  ON "nodes" ("created_at")
  WHERE "type" = 'llm_attempt';

CREATE INDEX IF NOT EXISTS "idx_nodes_admin_llm_attempt_thread_time"
  ON "nodes" ("namespace", ("data"->>'threadId'), "created_at")
  WHERE "type" = 'llm_attempt';
`;
