import type { Copilotz } from "@/index.ts";
import {
  type AdminThreadSummary,
  normalizeLimit,
  normalizeOffset,
  normalizeSearch,
  pushThreadNamespace,
  toIso,
  toNum,
} from "./_helpers.ts";

export default async function (
  request: { query?: Record<string, unknown> },
  copilotz: Copilotz,
) {
  const { query = {} } = request;
  const q = copilotz.ops.query;

  const params: unknown[] = [];
  const filters: string[] = [];
  pushThreadNamespace(params, filters, `t."id"`, query.namespace as string | undefined);

  const status = query.status as string | undefined;
  if (status && status !== "all") {
    params.push(status);
    filters.push(`t."status" = $${params.length}`);
  }

  const search = normalizeSearch(query.search as string | undefined);
  if (search) {
    params.push(search);
    filters.push(
      `(LOWER(COALESCE(t."name", '')) LIKE $${params.length}
        OR LOWER(COALESCE(t."summary", '')) LIKE $${params.length}
        OR LOWER(COALESCE(t."externalId", '')) LIKE $${params.length}
        OR LOWER(t."id") LIKE $${params.length})`,
    );
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = normalizeLimit(query.limit ? Number(query.limit) : undefined);
  const offset = normalizeOffset(query.offset ? Number(query.offset) : undefined);
  params.push(limit);
  const li = params.length;
  params.push(offset);
  const oi = params.length;

  const result = await q<{
    threadId: string; name: string; status: string; summary: string | null;
    participantIds: string[] | null; messageCount: number;
    lastActivityAt: Date | string | null; lastMessagePreview: string | null;
    createdAt: Date | string | null; updatedAt: Date | string | null;
  }>(
    `SELECT
       t."id" AS "threadId", t."name", t."status", t."summary",
       t."participants" AS "participantIds",
       COALESCE("ms"."messageCount", 0)::int AS "messageCount",
       "ms"."lastActivityAt", "ms"."lastMessagePreview",
       t."createdAt", t."updatedAt"
     FROM "threads" AS t
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS "messageCount",
         MAX(m."created_at") AS "lastActivityAt",
         (ARRAY_AGG(LEFT(COALESCE(m."content", ''), 280) ORDER BY m."created_at" DESC))[1] AS "lastMessagePreview"
       FROM "nodes" AS m WHERE m."type" = 'message' AND m."namespace" = t."id"
     ) AS "ms" ON TRUE
     ${whereClause}
     ORDER BY COALESCE("ms"."lastActivityAt", t."updatedAt") DESC, t."updatedAt" DESC
     LIMIT $${li} OFFSET $${oi}`,
    params,
  );

  const data: AdminThreadSummary[] = result.rows.map((row) => ({
    threadId: row.threadId,
    name: row.name,
    status: row.status,
    summary: row.summary ?? null,
    participantIds: Array.isArray(row.participantIds) ? row.participantIds : [],
    messageCount: toNum(row.messageCount),
    lastActivityAt: toIso(row.lastActivityAt),
    lastMessagePreview: row.lastMessagePreview ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }));

  return { status: 200, data };
}
