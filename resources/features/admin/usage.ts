import type { Copilotz } from "@/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";
import {
  type AdminUsageTotals,
  buildUsageCoalesceSelects,
  buildUsageSumSelects,
  pushTimeRange,
  toIso,
  toNum,
  toUsageTotals,
} from "./_helpers.ts";

type UsageInterval = "minute" | "hour" | "day" | "week" | "month";
type UsageGroupBy =
  | "thread"
  | "participant"
  | "namespace"
  | "provider"
  | "model";

export interface AdminUsagePoint extends AdminUsageTotals {
  bucket: string;
  groupKey: string;
  groupLabel: string;
}

export interface AdminUsageResponse {
  points: AdminUsagePoint[];
  rows: AdminUsagePoint[];
  totals: AdminUsageTotals;
}

const INTERVALS = new Set<UsageInterval>([
  "minute",
  "hour",
  "day",
  "week",
  "month",
]);

const GROUPS = new Set<UsageGroupBy>([
  "thread",
  "participant",
  "namespace",
  "provider",
  "model",
]);

function normalizeInterval(value: unknown): UsageInterval {
  return typeof value === "string" && INTERVALS.has(value as UsageInterval)
    ? value as UsageInterval
    : "day";
}

function normalizeGroupBy(value: unknown): UsageGroupBy {
  return typeof value === "string" && GROUPS.has(value as UsageGroupBy)
    ? value as UsageGroupBy
    : "participant";
}

export default async function (
  request: { query?: Record<string, unknown> },
  copilotz: Copilotz,
) {
  const { query = {} } = request;
  const q = copilotz.ops.query;
  const interval = normalizeInterval(query.interval);
  const groupBy = normalizeGroupBy(query.groupBy);

  const params: unknown[] = [];
  const filters: string[] = [`u."type" = 'llm_usage'`];

  const namespace = typeof query.namespace === "string"
    ? query.namespace
    : undefined;
  if (namespace) {
    params.push(namespace);
    filters.push(`u."namespace" = $${params.length}`);
  }
  pushTimeRange(
    params,
    filters,
    `u."created_at"`,
    query.from as string | undefined,
    query.to as string | undefined,
  );

  const threadId = typeof query.threadId === "string"
    ? query.threadId
    : undefined;
  if (threadId) {
    params.push(threadId);
    filters.push(
      `COALESCE(u."data"->>'threadId', u."source_id") = $${params.length}`,
    );
  }

  const provider = typeof query.provider === "string"
    ? query.provider
    : undefined;
  if (provider) {
    params.push(provider);
    filters.push(`COALESCE(u."data"->>'provider', '') = $${params.length}`);
  }

  const model = typeof query.model === "string" ? query.model : undefined;
  if (model) {
    params.push(model);
    filters.push(`COALESCE(u."data"->>'model', '') = $${params.length}`);
  }

  const participantId = typeof query.participantId === "string"
    ? query.participantId
    : undefined;
  const participantType = typeof query.participantType === "string" &&
      query.participantType !== "all"
    ? query.participantType
    : undefined;

  const needsParticipantJoin = groupBy === "participant" || participantId ||
    participantType;
  if (participantId) {
    params.push(participantId);
    filters.push(
      `COALESCE(p."data"->>'externalId', p."source_id", p."id") = $${params.length}`,
    );
  }
  if (participantType) {
    params.push(participantType);
    filters.push(
      `COALESCE(p."data"->>'participantType', 'human') = $${params.length}`,
    );
  }

  const participantJoins = needsParticipantJoin
    ? `INNER JOIN "edges" usage_participant
         ON usage_participant."target_node_id" = u."id"
        AND usage_participant."type" = '${GRAPH_EDGE.USED_LLM}'
       INNER JOIN "nodes" p
         ON p."id" = usage_participant."source_node_id"
        AND p."type" = 'participant'`
    : "";

  const threadJoin = groupBy === "thread"
    ? `LEFT JOIN "threads" t ON t."id" = COALESCE(u."data"->>'threadId', u."source_id")`
    : "";

  const groupExpr = groupBy === "participant"
    ? `COALESCE(p."data"->>'externalId', p."source_id", p."id", 'unknown')`
    : groupBy === "thread"
    ? `COALESCE(u."data"->>'threadId', u."source_id", 'unknown')`
    : groupBy === "namespace"
    ? `COALESCE(u."namespace", 'unknown')`
    : groupBy === "provider"
    ? `COALESCE(u."data"->>'provider', 'unknown')`
    : `COALESCE(u."data"->>'model', 'unknown')`;

  const labelExpr = groupBy === "participant"
    ? `COALESCE(p."data"->>'name', p."name", ${groupExpr})`
    : groupBy === "thread"
    ? `COALESCE(t."name", ${groupExpr})`
    : groupExpr;

  const whereClause = filters.join(" AND ");

  const result = await q<
    {
      bucket: Date | string;
      groupKey: string;
      groupLabel: string;
      totalCalls: number;
    } & Record<string, number>
  >(
    `WITH "usage_series" AS (
       SELECT
         DATE_TRUNC('${interval}', u."created_at") AS "bucket",
         ${groupExpr} AS "groupKey",
         ${labelExpr} AS "groupLabel",
         COUNT(*)::int AS "totalCalls",
         ${buildUsageSumSelects(`u."data"`)}
       FROM "nodes" u
       ${participantJoins}
       ${threadJoin}
       WHERE ${whereClause}
       GROUP BY 1, 2, 3
     )
     SELECT
       "bucket",
       "groupKey",
       "groupLabel",
       COALESCE("totalCalls", 0)::int AS "totalCalls",
       ${buildUsageCoalesceSelects("usage_series")}
     FROM "usage_series"
     ORDER BY "bucket" ASC, "totalCostUsd" DESC, "totalTokens" DESC`,
    params,
  );

  const totalsResult = await q<Record<keyof AdminUsageTotals, number>>(
    `SELECT COUNT(*)::int AS "totalCalls", ${buildUsageSumSelects(`u."data"`)}
     FROM "nodes" u
     ${participantJoins}
     ${threadJoin}
     WHERE ${whereClause}`,
    params,
  );

  const points = result.rows.map((row) => ({
    bucket: toIso(row.bucket) ??
      new Date(row.bucket as string | Date).toISOString(),
    groupKey: row.groupKey,
    groupLabel: row.groupLabel,
    ...toUsageTotals(row),
    totalCalls: toNum(row.totalCalls),
  }));

  return {
    status: 200,
    data: {
      points,
      rows: points,
      totals: toUsageTotals(totalsResult.rows[0]),
    } satisfies AdminUsageResponse,
  };
}
