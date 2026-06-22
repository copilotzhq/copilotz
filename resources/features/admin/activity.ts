import type { Copilotz } from "@/index.ts";
import {
  type AdminActivityPoint,
  buildAdminUsageSourceCte,
  buildAttemptUsageSumSelects,
  buildUsageCoalesceSelects,
  pushAdminUsageSourceScope,
  pushScopedThreadNode,
  pushTimeRange,
  toIso,
  toNum,
  toUsageTotals,
} from "./_helpers.ts";

export default async function (
  request: { query?: Record<string, unknown> },
  copilotz: Copilotz,
) {
  const { query = {} } = request;
  const namespace = query.namespace as string | undefined;
  const from = query.from as string | undefined;
  const to = query.to as string | undefined;
  const interval = query.interval === "hour" ? "hour" : "day";
  const q = copilotz.ops.query;

  const params: unknown[] = [];
  const mf: string[] = [`"type" = 'message'`];
  pushScopedThreadNode(params, mf, `"namespace"`, namespace);
  pushTimeRange(params, mf, `"created_at"`, from, to);
  const messageWhere = `WHERE ${mf.join(" AND ")}`;

  const uf: string[] = [];
  const usageScope = pushAdminUsageSourceScope(params, namespace, from, to);
  if (usageScope.namespacePlaceholder) {
    uf.push(`"namespace" = ${usageScope.namespacePlaceholder}`);
  }
  if (usageScope.fromPlaceholder) {
    uf.push(`"created_at" >= ${usageScope.fromPlaceholder}`);
  }
  if (usageScope.toPlaceholder) {
    uf.push(`"created_at" <= ${usageScope.toPlaceholder}`);
  }
  const usageWhere = `WHERE ${uf.length ? uf.join(" AND ") : "TRUE"}`;

  const result = await q<
    {
      bucket: Date | string;
      messageCount: number;
      toolCallMessageCount: number;
      totalCalls: number;
    } & Record<string, number>
  >(
    `WITH ${buildAdminUsageSourceCte(`"admin_usage_source"`, usageScope)},
     "message_series" AS (
       SELECT
         DATE_TRUNC('${interval}', "created_at") AS "bucket",
         COUNT(*)::int AS "messageCount",
         COUNT(*) FILTER (WHERE (
           ("data"->'toolCalls' IS NOT NULL AND jsonb_typeof("data"->'toolCalls') = 'array' AND jsonb_array_length("data"->'toolCalls') > 0)
           OR COALESCE("data"->>'toolCallId', '') <> ''
         ))::int AS "toolCallMessageCount"
       FROM "nodes" ${messageWhere}
       GROUP BY 1
     ),
     "usage_series" AS (
       SELECT
         DATE_TRUNC('${interval}', "created_at") AS "bucket",
         COUNT(*)::int AS "totalCalls",
         ${buildAttemptUsageSumSelects(`"data"`)}
       FROM "admin_usage_source" ${usageWhere}
       GROUP BY 1
     ),
     "all_buckets" AS (
       SELECT "bucket" FROM "message_series" UNION SELECT "bucket" FROM "usage_series"
     )
     SELECT
       "all_buckets"."bucket" AS "bucket",
       COALESCE("message_series"."messageCount", 0)::int AS "messageCount",
       COALESCE("message_series"."toolCallMessageCount", 0)::int AS "toolCallMessageCount",
       COALESCE("usage_series"."totalCalls", 0)::int AS "totalCalls",
       ${buildUsageCoalesceSelects("usage_series")}
     FROM "all_buckets"
     LEFT JOIN "message_series" ON "message_series"."bucket" = "all_buckets"."bucket"
     LEFT JOIN "usage_series" ON "usage_series"."bucket" = "all_buckets"."bucket"
     ORDER BY "all_buckets"."bucket" ASC`,
    params,
  );

  const data: AdminActivityPoint[] = result.rows.map((row) => ({
    bucket: toIso(row.bucket) ??
      new Date(row.bucket as string | Date).toISOString(),
    messageCount: toNum(row.messageCount),
    toolCallMessageCount: toNum(row.toolCallMessageCount),
    llmCallCount: toNum(row.totalCalls),
    ...toUsageTotals(row),
  }));

  return { status: 200, data };
}
