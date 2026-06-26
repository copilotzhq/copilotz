import type { Copilotz } from "@/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";
import {
  USAGE_GENERATOR_EDGE_TYPES,
  USAGE_INITIATOR_EDGE_TYPES,
} from "@/runtime/usage/attribution.ts";

type Queryable = {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: any[] }>;
};

/** Result summary for the tenant namespace graph migration. */
export type TenantNamespaceGraphMigrationResult = {
  namespace: string;
  hasThreadMetadataColumn: boolean;
};

/** Result summary for the LLM usage contract migration. */
export type LlmUsageContractMigrationResult = {
  namespace: string;
  updatedUsageRows: number;
};

/** Result summary for the legacy `llm_usage` -> unified `usage` ledger migration. */
export type UsageLedgerMigrationResult = {
  namespace: string;
  migratedRows: number;
};

/** Runs the tenant namespace graph migration through a Copilotz instance. */
export async function migrateTenantNamespaceGraph(
  copilotz: Pick<Copilotz, "ops" | "config">,
  options: { namespace?: string } = {},
): Promise<TenantNamespaceGraphMigrationResult> {
  const namespace = options.namespace ?? copilotz.config.namespace;
  if (!namespace) {
    throw new Error("Tenant namespace is required for graph migration");
  }
  return migrateTenantNamespaceGraphWithQuery(copilotz.ops, namespace);
}

/** Rewrites legacy llm_usage row data into the canonical usage contract. */
export async function migrateLlmUsageContract(
  copilotz: Pick<Copilotz, "ops" | "config">,
  options: { namespace?: string } = {},
): Promise<LlmUsageContractMigrationResult> {
  const namespace = options.namespace ?? copilotz.config.namespace;
  if (!namespace) {
    throw new Error("Tenant namespace is required for LLM usage migration");
  }
  return migrateLlmUsageContractWithQuery(copilotz.ops, namespace);
}

/**
 * Converts legacy `llm_usage` nodes into the unified `usage` ledger in place.
 *
 * The node id is preserved, so `usageNodeId` references in message metadata and
 * all attribution edges (`has_llm_usage`, `used_llm`, `initiated_llm_usage`)
 * remain valid. Run {@link migrateLlmUsageContract} first so the flat
 * token/cost fields are present before they are mirrored into `metrics`.
 */
export async function migrateLlmUsageToUsageLedger(
  copilotz: Pick<Copilotz, "ops" | "config">,
  options: { namespace?: string } = {},
): Promise<UsageLedgerMigrationResult> {
  const namespace = options.namespace ?? copilotz.config.namespace;
  if (!namespace) {
    throw new Error("Tenant namespace is required for usage ledger migration");
  }
  return migrateLlmUsageToUsageLedgerWithQuery(copilotz.ops, namespace);
}

export async function migrateLlmUsageToUsageLedgerWithQuery(
  db: Queryable,
  namespace: string,
): Promise<UsageLedgerMigrationResult> {
  const result = await db.query<{ migratedRows: number | string }>(
    `WITH updated AS (
       UPDATE "nodes"
       SET "type" = 'usage',
           "data" = jsonb_strip_nulls(
             COALESCE("data", '{}'::jsonb)
             || jsonb_build_object(
               'kind', 'llm',
               'resource', COALESCE("data"->>'model', "data"->>'provider', 'unknown'),
               'operation', COALESCE("data"->>'operation', 'chat'),
               'initiatedById', COALESCE(
                 "data"->>'initiatedById',
                 "data"->'runSender'->>'externalId',
                 "data"->'runSender'->>'id',
                 "data"->'runSender'->>'email',
                 "data"->'runSender'->>'name'
               ),
               'metrics', COALESCE(
                 "data"->'metrics',
                 jsonb_strip_nulls(jsonb_build_object(
                   'inputTokens', "data"->'inputTokens',
                   'outputTokens', "data"->'outputTokens',
                   'reasoningTokens', "data"->'reasoningTokens',
                   'cacheReadInputTokens', "data"->'cacheReadInputTokens',
                   'cacheCreationInputTokens', "data"->'cacheCreationInputTokens',
                   'totalTokens', "data"->'totalTokens'
                 ))
               )
             )
           )
       WHERE "type" = 'llm_usage'
         AND "namespace" = $1
       RETURNING 1
     )
     SELECT COUNT(*)::int AS "migratedRows" FROM updated`,
    [namespace],
  );

  // Legacy `llm_usage` rows never stored a flat `initiatedById`; the initiator
  // was only recorded as a participant→usage edge. Backfill from legacy and
  // current edge types so attribution resolves instead of "unknown".
  await db.query(
    `UPDATE "nodes" u
     SET "data" = jsonb_set(
       COALESCE(u."data", '{}'::jsonb),
       '{initiatedById}',
       to_jsonb(COALESCE(p."data"->>'externalId', p."source_id", p."id"))
     )
     FROM "edges" e
     INNER JOIN "nodes" p
       ON p."id" = e."source_node_id"
      AND p."type" = 'participant'
     WHERE u."type" = 'usage'
       AND u."namespace" = $1
       AND u."data"->>'kind' = 'llm'
       AND (u."data"->>'initiatedById' IS NULL OR u."data"->>'initiatedById' = '')
       AND e."target_node_id" = u."id"
       AND e."type" = ANY($2::text[])
       AND COALESCE(p."data"->>'externalId', p."source_id", p."id") IS NOT NULL`,
    [namespace, [...USAGE_INITIATOR_EDGE_TYPES]],
  );

  // Defensive: backfill agent attribution from participant→usage generator edges
  // when the flat `agentId` is missing (harmless no-op when already present).
  await db.query(
    `UPDATE "nodes" u
     SET "data" = jsonb_set(
       COALESCE(u."data", '{}'::jsonb),
       '{agentId}',
       to_jsonb(COALESCE(p."data"->>'externalId', p."source_id", p."id"))
     )
     FROM "edges" e
     INNER JOIN "nodes" p
       ON p."id" = e."source_node_id"
      AND p."type" = 'participant'
     WHERE u."type" = 'usage'
       AND u."namespace" = $1
       AND u."data"->>'kind' = 'llm'
       AND (u."data"->>'agentId' IS NULL OR u."data"->>'agentId' = '')
       AND e."target_node_id" = u."id"
       AND e."type" = ANY($2::text[])
       AND COALESCE(p."data"->>'externalId', p."source_id", p."id") IS NOT NULL`,
    [namespace, [...USAGE_GENERATOR_EDGE_TYPES]],
  );

  // Backfill initiator from thread memory identity when event metadata was lost
  // (common for LLM calls after tool loops before runSender propagation).
  await db.query(
    `UPDATE "nodes" u
     SET "data" = jsonb_set(
       COALESCE(u."data", '{}'::jsonb),
       '{initiatedById}',
       to_jsonb(
         NULLIF(trim(
           COALESCE(
             thread_node."data" #>> '{metadata,system,memory,identity,userExternalId}',
             thread_node."data" #>> '{system,memory,identity,userExternalId}'
           )
         ), '')
       )
     )
     FROM "nodes" thread_node
     WHERE u."type" = 'usage'
       AND u."namespace" = $1
       AND (u."data"->>'initiatedById' IS NULL OR u."data"->>'initiatedById' = '')
       AND thread_node."type" = 'thread'
       AND thread_node."id" = COALESCE(u."data"->>'threadId', u."source_id")
       AND thread_node."namespace" = u."namespace"
       AND NULLIF(trim(
         COALESCE(
           thread_node."data" #>> '{metadata,system,memory,identity,userExternalId}',
           thread_node."data" #>> '{system,memory,identity,userExternalId}'
         )
       ), '') IS NOT NULL`,
    [namespace],
  );

  return {
    namespace,
    migratedRows: Number(result.rows[0]?.migratedRows ?? 0),
  };
}

export async function migrateLlmUsageContractWithQuery(
  db: Queryable,
  namespace: string,
): Promise<LlmUsageContractMigrationResult> {
  const result = await db.query<{ updatedUsageRows: number | string }>(
    `WITH updated AS (
       UPDATE "nodes"
       SET "data" = (
         COALESCE("data", '{}'::jsonb)
           - 'promptTokens'
           - 'completionTokens'
           - 'promptCost'
           - 'completionCost'
           - 'totalCost'
       ) || jsonb_strip_nulls(jsonb_build_object(
         'inputTokens',
           COALESCE(NULLIF("data"->'inputTokens', 'null'::jsonb), NULLIF("data"->'promptTokens', 'null'::jsonb)),
         'outputTokens',
           COALESCE(NULLIF("data"->'outputTokens', 'null'::jsonb), NULLIF("data"->'completionTokens', 'null'::jsonb)),
         'inputCostUsd',
           COALESCE(NULLIF("data"->'inputCostUsd', 'null'::jsonb), NULLIF("data"->'promptCost', 'null'::jsonb)),
         'outputCostUsd',
           COALESCE(NULLIF("data"->'outputCostUsd', 'null'::jsonb), NULLIF("data"->'completionCost', 'null'::jsonb)),
         'totalCostUsd',
           COALESCE(NULLIF("data"->'totalCostUsd', 'null'::jsonb), NULLIF("data"->'totalCost', 'null'::jsonb))
       ))
       WHERE "type" = 'llm_usage'
         AND (
           COALESCE("data", '{}'::jsonb) ? 'promptTokens'
           OR COALESCE("data", '{}'::jsonb) ? 'completionTokens'
           OR COALESCE("data", '{}'::jsonb) ? 'promptCost'
           OR COALESCE("data", '{}'::jsonb) ? 'completionCost'
           OR COALESCE("data", '{}'::jsonb) ? 'totalCost'
         )
       RETURNING 1
     )
     SELECT COUNT(*)::int AS "updatedUsageRows" FROM updated`,
  );

  return {
    namespace,
    updatedUsageRows: Number(result.rows[0]?.updatedUsageRows ?? 0),
  };
}

export async function migrateTenantNamespaceGraphWithQuery(
  db: Queryable,
  namespace: string,
): Promise<TenantNamespaceGraphMigrationResult> {
  const threadMetadataColumn = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'threads'
         AND column_name = 'metadata'
     ) AS "exists"`,
  );
  const hasThreadMetadataColumn = threadMetadataColumn.rows[0]?.exists === true;
  const threadMetadataExpr = hasThreadMetadataColumn
    ? `t."metadata"`
    : `thread_node."data"->'metadata'`;

  await db.query(
    `ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "namespace" varchar(255)`,
  );
  await db.query(
    `ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "rootThreadId" varchar(255)`,
  );
  await db.query(
    `ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "lastEventId" varchar(255)`,
  );
  await db.query(
    `ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "lastEventAt" timestamp`,
  );

  await db.query(
    `UPDATE "threads"
     SET "namespace" = COALESCE("namespace", $1),
         "rootThreadId" = COALESCE("rootThreadId", "parentThreadId", "id")
     WHERE "namespace" IS NULL OR "rootThreadId" IS NULL`,
    [namespace],
  );

  await db.query(
    `UPDATE "events"
     SET "namespace" = COALESCE("namespace", $1)
     WHERE "namespace" IS NULL`,
    [namespace],
  );

  await db.query(
    `INSERT INTO "nodes" (
       "id", "namespace", "type", "name", "content", "data",
       "source_type", "source_id", "created_at", "updated_at"
     )
     SELECT
       t."id",
       COALESCE(t."namespace", $1),
       'thread',
       COALESCE(t."name", 'Thread'),
       NULL,
       jsonb_build_object(
         'description', t."description",
         'summary', t."summary",
         'initialMessage', t."initialMessage",
         'metadata', ${threadMetadataExpr},
         'participants', t."participants",
         'externalId', t."externalId",
         'mode', t."mode",
         'status', t."status"
       ),
       'thread',
       t."id",
       t."createdAt",
       t."updatedAt"
     FROM "threads" t
     LEFT JOIN "nodes" thread_node
       ON thread_node."id" = t."id"
      AND thread_node."type" = 'thread'
     ON CONFLICT ("id") DO UPDATE SET
       "namespace" = EXCLUDED."namespace",
       "type" = 'thread',
       "name" = EXCLUDED."name",
       "data" = EXCLUDED."data",
       "source_type" = 'thread',
       "source_id" = EXCLUDED."source_id",
       "updated_at" = NOW()`,
    [namespace],
  );

  await db.query(
    `UPDATE "nodes" m
     SET "namespace" = COALESCE(t."namespace", $1),
         "source_type" = 'thread',
         "source_id" = t."id",
         "content" = COALESCE(m."content", m."data"->>'content', ''),
         "data" = COALESCE(m."data", '{}'::jsonb) || jsonb_build_object('threadId', t."id")
     FROM "threads" t
     WHERE m."type" = 'message'
       AND (m."namespace" = t."id" OR m."source_id" = t."id")`,
    [namespace],
  );

  await db.query(
    `UPDATE "nodes" m
     SET "namespace" = COALESCE(t."namespace", $1),
         "source_type" = 'thread',
         "source_id" = t."id",
         "content" = COALESCE(m."content", m."data"->>'content', ''),
         "data" = COALESCE(m."data", '{}'::jsonb) || jsonb_build_object('threadId', t."id")
     FROM "threads" t
     WHERE m."type" = 'message'
       AND m."data"->>'threadId' = t."id"`,
    [namespace],
  );

  await db.query(
    `UPDATE "nodes"
     SET "namespace" = $1,
         "content" = COALESCE("content", "data"->>'content', ''),
         "data" = COALESCE("data", '{}'::jsonb) || jsonb_build_object(
           'legacyNamespace',
           CASE WHEN "namespace" IS DISTINCT FROM $1 THEN "namespace" ELSE NULL END
         )
     WHERE "type" = 'message'`,
    [namespace],
  );

  await db.query(
    `UPDATE "nodes"
     SET "type" = 'participant',
         "namespace" = $1,
         "data" = COALESCE("data", '{}'::jsonb) - 'isGlobal'
     WHERE "type" = 'user'
       AND COALESCE("data"->>'participantType', '') IN ('human', 'agent')`,
    [namespace],
  );

  await db.query(
    `UPDATE "nodes"
     SET "data" = COALESCE("data", '{}'::jsonb) - 'isGlobal'
     WHERE "type" = 'participant'`,
  );

  await db.query(
    `UPDATE "nodes"
     SET "namespace" = $1
     WHERE "type" = 'participant'`,
    [namespace],
  );

  await db.query(
    `UPDATE "nodes" u
     SET "namespace" = COALESCE(t."namespace", $1),
         "source_type" = 'thread',
         "source_id" = t."id",
         "data" = COALESCE(u."data", '{}'::jsonb) || jsonb_build_object('threadId', t."id")
     FROM "threads" t
     WHERE u."type" = 'llm_usage'
       AND (u."namespace" = t."id" OR u."source_id" = t."id")`,
    [namespace],
  );

  await db.query(
    `UPDATE "nodes" u
     SET "namespace" = COALESCE(t."namespace", $1),
         "source_type" = 'thread',
         "source_id" = t."id",
         "data" = COALESCE(u."data", '{}'::jsonb) || jsonb_build_object('threadId', t."id")
     FROM "threads" t
     WHERE u."type" = 'llm_usage'
       AND u."data"->>'threadId' = t."id"`,
    [namespace],
  );

  await db.query(
    `UPDATE "nodes"
     SET "namespace" = $1,
         "data" = COALESCE("data", '{}'::jsonb) || jsonb_build_object(
           'legacyNamespace',
           CASE WHEN "namespace" IS DISTINCT FROM $1 THEN "namespace" ELSE NULL END
         )
     WHERE "type" = 'llm_usage'`,
    [namespace],
  );

  await db.query(
    `INSERT INTO "edges" ("id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at")
     SELECT gen_random_uuid(), t."parentThreadId", t."id", $1, '{}'::jsonb, 1.0, NOW()
     FROM "threads" t
     WHERE t."parentThreadId" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "edges" e
         WHERE e."source_node_id" = t."parentThreadId"
           AND e."target_node_id" = t."id"
           AND e."type" = $1
       )`,
    [GRAPH_EDGE.HAS_CHILD_THREAD],
  );

  await db.query(
    `INSERT INTO "edges" ("id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at")
     SELECT gen_random_uuid(), m."source_id", m."id", $1, '{}'::jsonb, 1.0, NOW()
     FROM "nodes" m
     WHERE m."type" = 'message'
       AND m."source_type" = 'thread'
       AND m."source_id" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "edges" e
         WHERE e."source_node_id" = m."source_id"
           AND e."target_node_id" = m."id"
           AND e."type" = $1
       )`,
    [GRAPH_EDGE.HAS_MESSAGE],
  );

  await db.query(
    `INSERT INTO "edges" ("id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at")
     SELECT gen_random_uuid(), u."source_id", u."id", $1, '{}'::jsonb, 1.0, NOW()
     FROM "nodes" u
     WHERE u."type" = 'llm_usage'
       AND u."source_type" = 'thread'
       AND u."source_id" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "edges" e
         WHERE e."source_node_id" = u."source_id"
           AND e."target_node_id" = u."id"
           AND e."type" = $1
       )`,
    [GRAPH_EDGE.HAS_LLM_USAGE],
  );

  await db.query(
    `UPDATE "nodes"
     SET "namespace" = $1,
         "data" = COALESCE("data", '{}'::jsonb) || jsonb_build_object(
           'legacyNamespace',
           CASE WHEN "namespace" IS DISTINCT FROM $1 THEN "namespace" ELSE NULL END
         )
     WHERE "type" = 'asset'`,
    [namespace],
  );

  await db.query(
    `WITH message_assets AS (
       SELECT DISTINCT
         COALESCE(m."source_id", m."data"->>'threadId') AS "thread_id",
         attachment."value"->>'assetRef' AS "ref",
         CASE
           WHEN attachment."value"->>'assetRef' LIKE 'asset://%/%'
             THEN regexp_replace(attachment."value"->>'assetRef', '^asset://[^/]+/', '')
           WHEN attachment."value"->>'assetRef' LIKE 'asset://%'
             THEN regexp_replace(attachment."value"->>'assetRef', '^asset://', '')
           ELSE attachment."value"->>'assetRef'
         END AS "asset_id",
         CASE
           WHEN attachment."value"->>'assetRef' LIKE 'asset://%/%'
             THEN substring(attachment."value"->>'assetRef' from '^asset://([^/]+)/')
           ELSE NULL
         END AS "legacy_asset_namespace",
         attachment."value"->>'mimeType' AS "mime_type",
         attachment."value"->>'kind' AS "kind"
       FROM "nodes" m
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(m."data" #> '{metadata,attachments}') = 'array'
             THEN m."data" #> '{metadata,attachments}'
           ELSE '[]'::jsonb
         END
       ) AS attachment("value")
       WHERE m."type" = 'message'
         AND attachment."value" ? 'assetRef'
     )
     INSERT INTO "nodes" (
       "id", "namespace", "type", "name", "content", "data",
       "source_type", "source_id", "created_at", "updated_at"
     )
     SELECT
       message_assets."asset_id",
       $1,
       'asset',
       message_assets."asset_id",
       NULL,
       jsonb_build_object(
         'assetId', message_assets."asset_id",
         'ref', message_assets."ref",
         'legacyNamespace', message_assets."legacy_asset_namespace",
         'mime', message_assets."mime_type",
         'kind', message_assets."kind"
       ),
       'asset_store',
       message_assets."asset_id",
       NOW(),
       NOW()
     FROM message_assets
     WHERE message_assets."asset_id" IS NOT NULL
       AND message_assets."asset_id" <> ''
     ON CONFLICT ("id") DO UPDATE SET
       "namespace" = EXCLUDED."namespace",
       "type" = 'asset',
       "data" = COALESCE("nodes"."data", '{}'::jsonb) || EXCLUDED."data",
       "source_type" = COALESCE("nodes"."source_type", EXCLUDED."source_type"),
       "source_id" = COALESCE("nodes"."source_id", EXCLUDED."source_id"),
       "updated_at" = NOW()`,
    [namespace],
  );

  await db.query(
    `WITH message_assets AS (
       SELECT DISTINCT
         COALESCE(m."source_id", m."data"->>'threadId') AS "thread_id",
         CASE
           WHEN attachment."value"->>'assetRef' LIKE 'asset://%/%'
             THEN regexp_replace(attachment."value"->>'assetRef', '^asset://[^/]+/', '')
           WHEN attachment."value"->>'assetRef' LIKE 'asset://%'
             THEN regexp_replace(attachment."value"->>'assetRef', '^asset://', '')
           ELSE attachment."value"->>'assetRef'
         END AS "asset_id"
       FROM "nodes" m
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(m."data" #> '{metadata,attachments}') = 'array'
             THEN m."data" #> '{metadata,attachments}'
           ELSE '[]'::jsonb
         END
       ) AS attachment("value")
       WHERE m."type" = 'message'
         AND attachment."value" ? 'assetRef'
     )
     INSERT INTO "edges" ("id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at")
     SELECT gen_random_uuid(), message_assets."thread_id", message_assets."asset_id", $1, '{}'::jsonb, 1.0, NOW()
     FROM message_assets
     INNER JOIN "threads" t ON t."id" = message_assets."thread_id"
     INNER JOIN "nodes" asset ON asset."id" = message_assets."asset_id" AND asset."type" = 'asset'
     WHERE message_assets."thread_id" IS NOT NULL
       AND message_assets."asset_id" IS NOT NULL
       AND message_assets."asset_id" <> ''
       AND NOT EXISTS (
         SELECT 1 FROM "edges" e
         WHERE e."source_node_id" = message_assets."thread_id"
           AND e."target_node_id" = message_assets."asset_id"
           AND e."type" = $1
       )`,
    [GRAPH_EDGE.HAS_ASSET],
  );

  await db.query(
    `DELETE FROM "edges" e
     USING "nodes" s, "nodes" u
     WHERE e."type" = $1
       AND s."id" = e."source_node_id"
       AND u."id" = e."target_node_id"
       AND u."type" = 'llm_usage'
       AND s."type" <> 'thread'`,
    [GRAPH_EDGE.HAS_LLM_USAGE],
  );

  await db.query(
    `INSERT INTO "edges" ("id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at")
     SELECT gen_random_uuid(), p."id", t."id", $1, '{}'::jsonb, 1.0, NOW()
     FROM "threads" t
     CROSS JOIN LATERAL jsonb_array_elements_text(
       CASE
         WHEN jsonb_typeof(t."participants") = 'array' THEN t."participants"
         ELSE '[]'::jsonb
       END
     ) AS participant("external_id")
     INNER JOIN "nodes" p
       ON p."type" = 'participant'
      AND p."namespace" = COALESCE(t."namespace", $2)
      AND p."data"->>'externalId' = participant."external_id"
     WHERE NOT EXISTS (
       SELECT 1 FROM "edges" e
       WHERE e."source_node_id" = p."id"
         AND e."target_node_id" = t."id"
         AND e."type" = $1
     )`,
    [GRAPH_EDGE.PARTICIPATES_IN, namespace],
  );

  await db.query(
    `WITH owner_threads AS (
       SELECT DISTINCT
         COALESCE(t."namespace", $1) AS "namespace",
         NULLIF(trim(${threadMetadataExpr} #>> '{system,memory,identity,userExternalId}'), '') AS "external_id"
       FROM "threads" t
       LEFT JOIN "nodes" thread_node
         ON thread_node."id" = t."id"
        AND thread_node."type" = 'thread'
     )
     INSERT INTO "nodes" (
       "id", "namespace", "type", "name", "content", "data",
       "source_type", "source_id", "created_at", "updated_at"
     )
     SELECT
       gen_random_uuid(),
       owner_threads."namespace",
       'participant',
       owner_threads."external_id",
       NULL,
       jsonb_build_object(
         'externalId', owner_threads."external_id",
         'participantType', 'human',
         'name', owner_threads."external_id",
         'email', NULL,
         'agentId', NULL,
         'metadata', NULL
       ),
       'user',
       owner_threads."external_id",
       NOW(),
       NOW()
     FROM owner_threads
     WHERE owner_threads."external_id" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "nodes" p
         WHERE p."type" = 'participant'
           AND p."namespace" = owner_threads."namespace"
           AND (
             p."data"->>'externalId' = owner_threads."external_id"
             OR p."source_id" = owner_threads."external_id"
           )
       )`,
    [namespace],
  );

  await db.query(
    `WITH owner_threads AS (
       SELECT
         t."id" AS "thread_id",
         COALESCE(t."namespace", $1) AS "namespace",
         NULLIF(trim(${threadMetadataExpr} #>> '{system,memory,identity,userExternalId}'), '') AS "external_id"
       FROM "threads" t
       LEFT JOIN "nodes" thread_node
         ON thread_node."id" = t."id"
        AND thread_node."type" = 'thread'
     )
     INSERT INTO "edges" ("id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at")
     SELECT gen_random_uuid(), p."id", owner_threads."thread_id", $2, '{}'::jsonb, 1.0, NOW()
     FROM owner_threads
     INNER JOIN "nodes" p
       ON p."type" = 'participant'
      AND p."namespace" = owner_threads."namespace"
      AND (
        p."data"->>'externalId' = owner_threads."external_id"
        OR p."source_id" = owner_threads."external_id"
      )
     WHERE owner_threads."external_id" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "edges" e
         WHERE e."source_node_id" = p."id"
           AND e."target_node_id" = owner_threads."thread_id"
           AND e."type" = $2
       )`,
    [namespace, GRAPH_EDGE.PARTICIPATES_IN],
  );

  await db.query(
    `WITH auth_users AS (
       SELECT
         a."id" AS "auth_user_id",
         COALESCE(a."data"->>'id', a."id") AS "external_id",
         COALESCE(a."data"->>'namespace', a."namespace", $1) AS "namespace",
         COALESCE(a."data"->>'name', a."name", a."id") AS "name",
         a."data"->>'email' AS "email"
       FROM "nodes" a
       WHERE a."type" = 'authUser'
     )
     INSERT INTO "nodes" (
       "id", "namespace", "type", "name", "content", "data",
       "source_type", "source_id", "created_at", "updated_at"
     )
     SELECT
       gen_random_uuid(),
       auth_users."namespace",
       'participant',
       auth_users."name",
       NULL,
       jsonb_build_object(
         'externalId', auth_users."external_id",
         'participantType', 'human',
         'name', auth_users."name",
         'email', auth_users."email",
         'agentId', NULL,
         'metadata', NULL
       ),
       'user',
       auth_users."external_id",
       NOW(),
       NOW()
     FROM auth_users
     WHERE auth_users."external_id" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "nodes" p
         WHERE p."type" = 'participant'
           AND p."namespace" = auth_users."namespace"
           AND (
             p."data"->>'externalId' = auth_users."external_id"
             OR p."source_id" = auth_users."external_id"
           )
       )`,
    [namespace],
  );

  await db.query(
    `WITH owner_threads AS (
       SELECT
         t."id" AS "thread_id",
         COALESCE(t."namespace", $1) AS "namespace",
         NULLIF(trim(${threadMetadataExpr} #>> '{system,memory,identity,userExternalId}'), '') AS "legacy_external_id"
       FROM "threads" t
       LEFT JOIN "nodes" thread_node
         ON thread_node."id" = t."id"
        AND thread_node."type" = 'thread'
     ),
     auth_matches AS (
       SELECT
         owner_threads."thread_id",
         owner_threads."namespace",
         COALESCE(a."data"->>'id', a."id") AS "auth_external_id"
       FROM owner_threads
       INNER JOIN "nodes" a
         ON a."type" = 'authUser'
        AND COALESCE(a."data"->>'namespace', a."namespace", $1) = owner_threads."namespace"
        AND (
          COALESCE(a."data"->>'id', a."id") = owner_threads."legacy_external_id"
          OR lower(split_part(COALESCE(a."data"->>'email', ''), '@', 1)) = lower(owner_threads."legacy_external_id")
        )
       WHERE owner_threads."legacy_external_id" IS NOT NULL
     )
     INSERT INTO "edges" ("id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at")
     SELECT gen_random_uuid(), p."id", auth_matches."thread_id", $2, '{}'::jsonb, 1.0, NOW()
     FROM auth_matches
     INNER JOIN "nodes" p
       ON p."type" = 'participant'
      AND p."namespace" = auth_matches."namespace"
      AND (
        p."data"->>'externalId' = auth_matches."auth_external_id"
        OR p."source_id" = auth_matches."auth_external_id"
      )
     WHERE NOT EXISTS (
       SELECT 1 FROM "edges" e
       WHERE e."source_node_id" = p."id"
         AND e."target_node_id" = auth_matches."thread_id"
         AND e."type" = $2
     )`,
    [namespace, GRAPH_EDGE.PARTICIPATES_IN],
  );

  await db.query(
    `UPDATE "edges"
     SET "type" = CASE "type"
       WHEN 'SENT_BY' THEN $1
       WHEN 'REPLIED_BY' THEN $2
       WHEN 'NEXT_CHUNK' THEN $2
       WHEN 'HAS_LLM_USAGE' THEN $3
       WHEN 'HAS_CHUNK' THEN $4
       ELSE lower("type")
     END
     WHERE "type" ~ '[A-Z]'`,
    [
      GRAPH_EDGE.SENT_BY,
      GRAPH_EDGE.DERIVED_FROM,
      GRAPH_EDGE.HAS_LLM_USAGE,
      GRAPH_EDGE.HAS_CHUNK,
    ],
  );

  await db.query(
    `INSERT INTO "edges" ("id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at")
     SELECT gen_random_uuid(), e."source_node_id", e."target_node_id", $1, COALESCE(e."data", '{}'::jsonb), e."weight", e."created_at"
     FROM "edges" e
     INNER JOIN "nodes" s ON s."id" = e."source_node_id" AND s."type" = 'participant'
     INNER JOIN "nodes" m ON m."id" = e."target_node_id" AND m."type" = 'message'
     WHERE e."type" = $2
       AND NOT EXISTS (
         SELECT 1 FROM "edges" existing
         WHERE existing."source_node_id" = e."source_node_id"
           AND existing."target_node_id" = e."target_node_id"
           AND existing."type" = $1
       )`,
    [GRAPH_EDGE.SENT_BY, GRAPH_EDGE.HAS_MESSAGE],
  );

  await db.query(
    `DELETE FROM "edges" e
     USING "nodes" s, "nodes" m
     WHERE e."type" = $1
       AND s."id" = e."source_node_id"
       AND m."id" = e."target_node_id"
       AND m."type" = 'message'
       AND s."type" <> 'thread'`,
    [GRAPH_EDGE.HAS_MESSAGE],
  );

  await db.query(
    `DELETE FROM "edges" e
     USING "nodes" s, "nodes" u
     WHERE e."type" = $1
       AND s."id" = e."source_node_id"
       AND u."id" = e."target_node_id"
       AND u."type" = 'llm_usage'
       AND s."type" <> 'thread'`,
    [GRAPH_EDGE.HAS_LLM_USAGE],
  );

  const legacyRagNamespaces = await db.query<{ namespace: string }>(
    `SELECT DISTINCT "namespace"
     FROM "nodes"
     WHERE "type" IN ('document', 'chunk')
       AND "namespace" IS NOT NULL
       AND "namespace" <> $1`,
    [namespace],
  );

  for (const row of legacyRagNamespaces.rows) {
    const oldNamespace = row.namespace;
    const existingKnowledgeSpace = await db.query<{ id: string }>(
      `SELECT "id"
       FROM "nodes"
       WHERE "namespace" = $1
         AND "type" = 'knowledge_space'
         AND "source_type" = 'legacy_namespace'
         AND "source_id" = $2
       LIMIT 1`,
      [namespace, oldNamespace],
    );
    const knowledgeSpaceId = existingKnowledgeSpace.rows[0]?.id ??
      crypto.randomUUID();
    await db.query(
      `INSERT INTO "nodes" (
         "id", "namespace", "type", "name", "content", "data",
         "source_type", "source_id", "created_at", "updated_at"
       ) VALUES (
         $1, $2, 'knowledge_space', $3, NULL, $4, 'legacy_namespace', $5, NOW(), NOW()
       )
       ON CONFLICT DO NOTHING`,
      [
        knowledgeSpaceId,
        namespace,
        oldNamespace,
        { legacyNamespace: oldNamespace },
        oldNamespace,
      ],
    );

    await db.query(
      `INSERT INTO "edges" ("id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at")
       SELECT gen_random_uuid(), $1, d."id", $2, '{}'::jsonb, 1.0, NOW()
       FROM "nodes" d
       WHERE d."type" = 'document' AND d."namespace" = $3
         AND NOT EXISTS (
           SELECT 1 FROM "edges" e
           WHERE e."source_node_id" = $1
             AND e."target_node_id" = d."id"
             AND e."type" = $2
         )`,
      [knowledgeSpaceId, GRAPH_EDGE.HAS_DOCUMENT, oldNamespace],
    );
  }

  await db.query(
    `UPDATE "nodes"
     SET "namespace" = $1
     WHERE "type" IN ('document', 'chunk', 'entity')`,
    [namespace],
  );

  await db.query(
    `INSERT INTO "edges" ("id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at")
     SELECT gen_random_uuid(), d."id", c."id", $1, '{}'::jsonb, 1.0, NOW()
     FROM "nodes" c
     INNER JOIN "nodes" d ON d."id" = c."source_id"
     WHERE c."type" = 'chunk'
       AND c."source_type" = 'document'
       AND d."type" = 'document'
       AND NOT EXISTS (
         SELECT 1 FROM "edges" e
         WHERE e."source_node_id" = d."id"
           AND e."target_node_id" = c."id"
           AND e."type" = $1
       )`,
    [GRAPH_EDGE.HAS_CHUNK],
  );

  if (hasThreadMetadataColumn) {
    await db.query(`ALTER TABLE "threads" DROP COLUMN IF EXISTS "metadata"`);
  }

  return { namespace, hasThreadMetadataColumn };
}
