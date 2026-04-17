import type { Copilotz } from "@/index.ts";
import {
  type AdminParticipantSummary,
  normalizeLimit,
  normalizeOffset,
  normalizeSearch,
  toIso,
  toNum,
} from "./_helpers.ts";

export default async function (
  request: { query?: Record<string, unknown> },
  copilotz: Copilotz,
) {
  const { query = {} } = request;
  const q = copilotz.ops.query;
  const namespace = query.namespace as string | undefined;

  const params: unknown[] = [];
  const filters = [`n."type" = 'user'`];

  if (namespace) {
    params.push(namespace);
    filters.push(`(n."namespace" = $${params.length} OR n."namespace" = 'global')`);
  }

  const pType = query.participantType as string | undefined;
  if (pType && pType !== "all") {
    params.push(pType);
    filters.push(`COALESCE(n."data"->>'participantType', 'human') = $${params.length}`);
  }

  const search = normalizeSearch(query.search as string | undefined);
  if (search) {
    params.push(search);
    filters.push(
      `(LOWER(COALESCE(n."data"->>'externalId', n."source_id", n."id")) LIKE $${params.length}
        OR LOWER(COALESCE(n."data"->>'name', n."name", '')) LIKE $${params.length})`,
    );
  }

  const limit = normalizeLimit(query.limit ? Number(query.limit) : undefined);
  const offset = normalizeOffset(query.offset ? Number(query.offset) : undefined);
  params.push(limit);
  const li = params.length;
  params.push(offset);
  const oi = params.length;

  const msgScope: string[] = [`m."type" = 'message'`];
  if (namespace) {
    params.push(namespace);
    msgScope.push(
      `m."namespace" IN (SELECT DISTINCT "threadId" FROM "events" WHERE "namespace" = $${params.length})`,
    );
  }

  const result = await q<{
    externalId: string; displayName: string;
    participantType: "human" | "agent"; namespace: string; isGlobal: boolean;
    messageCount: number; threadCount: number;
    lastActivityAt: Date | string | null;
  }>(
    `WITH "message_stats" AS (
       SELECT COALESCE(m."data"->>'senderId', '') AS "externalId",
         COUNT(*)::int AS "messageCount",
         COUNT(DISTINCT m."namespace")::int AS "threadCount",
         MAX(m."created_at") AS "lastActivityAt"
       FROM "nodes" AS m WHERE ${msgScope.join(" AND ")} GROUP BY 1
     )
     SELECT
       COALESCE(n."data"->>'externalId', n."source_id", n."id") AS "externalId",
       COALESCE(n."data"->>'name', n."name", COALESCE(n."data"->>'externalId', n."source_id", n."id")) AS "displayName",
       COALESCE(n."data"->>'participantType', 'human') AS "participantType",
       n."namespace",
       COALESCE((n."data"->>'isGlobal')::boolean, n."namespace" = 'global') AS "isGlobal",
       COALESCE("message_stats"."messageCount", 0)::int AS "messageCount",
       COALESCE("message_stats"."threadCount", 0)::int AS "threadCount",
       "message_stats"."lastActivityAt"
     FROM "nodes" AS n
     LEFT JOIN "message_stats"
       ON "message_stats"."externalId" = COALESCE(n."data"->>'externalId', n."source_id", n."id")
     WHERE ${filters.join(" AND ")}
     ORDER BY "message_stats"."lastActivityAt" DESC NULLS LAST, "displayName" ASC
     LIMIT $${li} OFFSET $${oi}`,
    params,
  );

  const data: AdminParticipantSummary[] = result.rows.map((row) => ({
    externalId: row.externalId,
    displayName: row.displayName,
    participantType: row.participantType === "agent" ? "agent" : "human",
    namespace: row.namespace,
    isGlobal: Boolean(row.isGlobal),
    messageCount: toNum(row.messageCount),
    threadCount: toNum(row.threadCount),
    lastActivityAt: toIso(row.lastActivityAt),
  }));

  return { status: 200, data };
}
