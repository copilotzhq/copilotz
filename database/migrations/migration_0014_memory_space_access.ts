/**
 * Migrates thread-owned memory spaces to the generic many-to-many access
 * model while preserving the legacy ownership edge for compatibility.
 */
export const MEMORY_SPACE_ACCESS_DATA_MIGRATIONS = [
  `UPDATE "nodes"
      SET "data" = "data" ||
        jsonb_build_object(
          'scopeType', COALESCE("data"->>'scopeType', "data"->>'kind', "source_type", 'custom'),
          'scopeId', COALESCE("data"->>'scopeId', "data"->>'ownerNodeId', "source_id", "id")
        )
    WHERE "type" = 'memory_space'
      AND (
        "data"->>'scopeType' IS NULL OR
        "data"->>'scopeId' IS NULL
      )`,
  `UPDATE "nodes" AS item
      SET "data" = item."data" ||
        jsonb_build_object('originThreadId', checkpoint."data"->>'threadId')
     FROM "nodes" AS checkpoint
    WHERE item."type" = 'memory_item'
      AND item."source_type" = 'long_term_memory'
      AND item."source_id" = checkpoint."id"
      AND item."namespace" = checkpoint."namespace"
      AND checkpoint."type" = 'long_term_memory'
      AND item."data"->>'originThreadId' IS NULL
      AND checkpoint."data"->>'threadId' IS NOT NULL`,
  `INSERT INTO "edges" (
       "id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at"
     )
     SELECT ownership."id" || ':uses',
            ownership."source_node_id",
            ownership."target_node_id",
            'uses_memory_space',
            jsonb_build_object('access', 'read_write', 'defaultWrite', true),
            ownership."weight",
            ownership."created_at"
       FROM "edges" AS ownership
      WHERE ownership."type" = 'owns_memory_space'
        AND NOT EXISTS (
          SELECT 1
            FROM "edges" AS access
           WHERE access."source_node_id" = ownership."source_node_id"
             AND access."target_node_id" = ownership."target_node_id"
             AND access."type" = 'uses_memory_space'
        )
     ON CONFLICT ("id") DO NOTHING`,
] as const;

export const MEMORY_SPACE_ACCESS_INDEX_MIGRATIONS = [
  `CREATE INDEX IF NOT EXISTS "idx_edges_uses_memory_space_source"
     ON "edges" ("source_node_id", "type", "created_at")
     WHERE "type" = 'uses_memory_space'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_memory_space_scope"
     ON "nodes" (
       "namespace",
       ("data"->>'scopeType'),
       ("data"->>'scopeId')
     )
     WHERE "type" = 'memory_space'`,
  `CREATE INDEX IF NOT EXISTS "idx_nodes_memory_item_origin_thread"
     ON "nodes" ("namespace", ("data"->>'originThreadId'))
     WHERE "type" = 'memory_item'`,
] as const;

export const MEMORY_SPACE_ACCESS_MIGRATIONS = [
  ...MEMORY_SPACE_ACCESS_DATA_MIGRATIONS,
  ...MEMORY_SPACE_ACCESS_INDEX_MIGRATIONS,
] as const;

export const generateMemorySpaceAccessMigrations = (): string =>
  MEMORY_SPACE_ACCESS_MIGRATIONS.map((statement) => `${statement};`).join(
    "\n\n",
  );
