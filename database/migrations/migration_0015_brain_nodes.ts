/**
 * Promotes durable memory items to first-class brain nodes and adds indexes for
 * Brain admin and long-term-memory retrieval.
 */
export const BRAIN_NODE_MIGRATIONS = [
  `UPDATE "nodes"
      SET "type" = 'brain_node',
          "data" = "data" ||
            jsonb_build_object(
              'layer', COALESCE("data"->>'layer', 'knowledge'),
              'status', COALESCE("data"->>'status', 'active')
            )
    WHERE "type" = 'memory_item'`,
  `UPDATE "edges"
      SET "type" = 'has_brain_node'
    WHERE "type" = 'has_memory_item'`,
  `UPDATE "edges"
      SET "type" = 'includes_brain_node'
    WHERE "type" = 'includes_memory_item'`,
  `UPDATE "nodes" AS target
      SET "data" = jsonb_set(target."data", '{status}', '"superseded"', true)
     FROM "edges" AS supersedes
    WHERE target."type" = 'brain_node'
      AND supersedes."type" = 'supersedes'
      AND supersedes."target_node_id" = target."id"`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_brain_node_space_agent"
     ON "nodes" (
       "namespace",
       ("data"->>'memorySpaceId'),
       ("data"->>'createdByAgentId')
     )
     WHERE "type" = 'brain_node'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_brain_node_origin_thread"
     ON "nodes" ("namespace", ("data"->>'originThreadId'))
     WHERE "type" = 'brain_node'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_brain_node_layer_kind"
     ON "nodes" (
       "namespace",
       ("data"->>'layer'),
       ("data"->>'kind')
     )
     WHERE "type" = 'brain_node'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_brain_node_status"
     ON "nodes" ("namespace", ("data"->>'status'))
     WHERE "type" = 'brain_node'`,
] as const;

export const generateBrainNodeMigrations = (): string =>
  BRAIN_NODE_MIGRATIONS.map((statement) => `${statement};`).join("\n\n");
