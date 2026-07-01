/**
 * Backfills agent ownership for existing long-term-memory items and adds
 * indexes for agent-scoped checkpoint and semantic-memory lookups.
 */
export const AGENT_MEMORY_OWNERSHIP_MIGRATIONS = [
  `UPDATE "nodes" AS item
     SET "data" = jsonb_set(
       item."data",
       '{createdByAgentId}',
       to_jsonb(checkpoint."data"->>'agentId'),
       true
     )
    FROM "nodes" AS checkpoint
    WHERE item."type" = 'memory_item'
      AND item."source_type" = 'long_term_memory'
      AND item."source_id" = checkpoint."id"
      AND item."namespace" = checkpoint."namespace"
      AND checkpoint."type" = 'long_term_memory'
      AND item."data"->>'createdByAgentId' IS NULL
      AND checkpoint."data"->>'agentId' IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_long_term_memory_agent_status"
     ON "nodes" (
       "namespace",
       "source_id",
       ("data"->>'agentId'),
       ("data"->>'status')
     )
     WHERE "type" = 'long_term_memory' AND "source_type" = 'thread'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_memory_item_space_agent"
     ON "nodes" (
       "namespace",
       ("data"->>'memorySpaceId'),
       ("data"->>'createdByAgentId')
     )
     WHERE "type" = 'memory_item'`,
] as const;

export const generateAgentMemoryOwnershipMigrations = (): string =>
  AGENT_MEMORY_OWNERSHIP_MIGRATIONS.map((statement) => `${statement};`).join(
    "\n\n",
  );
