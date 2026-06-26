import type { Copilotz } from "@/index.ts";
import {
  USAGE_GENERATOR_EDGE_TYPES,
  USAGE_INITIATOR_EDGE_TYPES,
} from "@/runtime/usage/attribution.ts";
import {
  type AdminUsageTotals,
  buildAdminUsageSourceCte,
  buildUsageCoalesceSelects,
  buildUsageSumSelects,
  pushAdminUsageSourceScope,
  sumUsageTotalsFromPoints,
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
type UsageAttribution = "generatedBy" | "initiatedBy";

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
const ATTRIBUTIONS = new Set<UsageAttribution>([
  "generatedBy",
  "initiatedBy",
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

function normalizeAttribution(value: unknown): UsageAttribution {
  return typeof value === "string" &&
      ATTRIBUTIONS.has(value as UsageAttribution)
    ? value as UsageAttribution
    : "generatedBy";
}

export default async function (
  request: { query?: Record<string, unknown> },
  copilotz: Copilotz,
) {
  const { query = {} } = request;
  const q = copilotz.ops.query;
  const interval = normalizeInterval(query.interval);
  const groupBy = normalizeGroupBy(query.groupBy);
  const attribution = normalizeAttribution(query.attribution);
  const participantEdgeTypes = attribution === "initiatedBy"
    ? USAGE_INITIATOR_EDGE_TYPES
    : USAGE_GENERATOR_EDGE_TYPES;
  const participantEdgeTypeList = participantEdgeTypes
    .map((type) => `'${type}'`)
    .join(", ");

  const params: unknown[] = [];
  const filters: string[] = [];
  const threadId = typeof query.threadId === "string"
    ? query.threadId
    : undefined;
  const sourceScope = pushAdminUsageSourceScope(
    params,
    typeof query.namespace === "string" ? query.namespace : undefined,
    query.from as string | undefined,
    query.to as string | undefined,
    threadId,
  );

  const namespace = typeof query.namespace === "string"
    ? query.namespace
    : undefined;
  if (namespace) {
    filters.push(`u."namespace" = ${sourceScope.namespacePlaceholder}`);
  }
  if (sourceScope.fromPlaceholder) {
    filters.push(`u."created_at" >= ${sourceScope.fromPlaceholder}`);
  }
  if (sourceScope.toPlaceholder) {
    filters.push(`u."created_at" <= ${sourceScope.toPlaceholder}`);
  }

  const provider = typeof query.provider === "string"
    ? query.provider
    : undefined;
  if (provider) {
    params.push(provider);
    filters.push(`u."provider" = $${params.length}`);
  }

  const model = typeof query.model === "string" ? query.model : undefined;
  if (model) {
    params.push(model);
    filters.push(`u."model" = $${params.length}`);
  }

  const participantId = typeof query.participantId === "string"
    ? query.participantId
    : undefined;
  const participantType = typeof query.participantType === "string" &&
      query.participantType !== "all"
    ? query.participantType
    : undefined;
  const participantKeyExpr = attribution === "initiatedBy"
    ? `NULLIF(u."initiatedById", '')`
    : `NULLIF(u."agentId", '')`;
  const whereClause = filters.length ? filters.join(" AND ") : "TRUE";

  if (groupBy === "participant") {
    const participantFilters: string[] = [];
    if (participantId) {
      params.push(participantId);
      participantFilters.push(
        `COALESCE(p."data"->>'externalId', p."source_id", p."id") = $${params.length}`,
      );
    }
    if (participantType) {
      params.push(participantType);
      participantFilters.push(
        `COALESCE(p."data"->>'participantType', 'human') = $${params.length}`,
      );
    }
    const participantWhere = participantFilters.length
      ? `WHERE ${participantFilters.join(" AND ")}`
      : "";
    const participantNamespaceJoin = sourceScope.namespacePlaceholder
      ? `AND p."namespace" = ${sourceScope.namespacePlaceholder}`
      : "";
    const result = await q<
      {
        bucket: Date | string;
        groupKey: string;
        groupLabel: string;
        totalCalls: number;
      } & Record<string, number>
    >(
      `WITH ${buildAdminUsageSourceCte(`"admin_usage_source"`, sourceScope)},
       "usage_series" AS (
         SELECT
           DATE_TRUNC('${interval}', u."created_at") AS "bucket",
           COALESCE(${participantKeyExpr}, 'unknown') AS "groupKey",
           COUNT(*)::int AS "totalCalls",
           ${buildUsageSumSelects(`u."data"`)}
         FROM "admin_usage_source" u
         WHERE ${whereClause}
         GROUP BY 1, 2
       ),
       "usage_with_participant" AS (
         SELECT
           usage_series.*,
           COALESCE(p."data"->>'name', p."name", usage_series."groupKey") AS "groupLabel"
         FROM "usage_series"
         LEFT JOIN "nodes" p
           ON p."type" = 'participant'
          ${participantNamespaceJoin}
          AND COALESCE(p."data"->>'externalId', p."source_id", p."id") = usage_series."groupKey"
         ${participantWhere}
       )
       SELECT
         "bucket",
         "groupKey",
         "groupLabel",
         COALESCE("totalCalls", 0)::int AS "totalCalls",
         ${buildUsageCoalesceSelects("usage_with_participant")}
       FROM "usage_with_participant"
       ORDER BY "bucket" ASC, "totalCostUsd" DESC, "totalTokens" DESC`,
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
    const totals = sumUsageTotalsFromPoints(points);

    return {
      status: 200,
      data: {
        points,
        rows: points,
        totals,
      } satisfies AdminUsageResponse,
    };
  }

  const needsParticipantJoin = Boolean(participantId || participantType);
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
        AND usage_participant."type" IN (${participantEdgeTypeList})
       INNER JOIN "nodes" p
         ON p."id" = usage_participant."source_node_id"
        AND p."type" = 'participant'`
    : "";

  const threadJoin = groupBy === "thread"
    ? `LEFT JOIN "threads" t ON t."id" = u."threadId"`
    : "";

  const groupExpr = groupBy === "thread"
    ? `COALESCE(u."threadId", 'unknown')`
    : groupBy === "namespace"
    ? `COALESCE(u."namespace", 'unknown')`
    : groupBy === "provider"
    ? `COALESCE(u."provider", 'unknown')`
    : `COALESCE(u."model", 'unknown')`;

  const labelExpr = groupBy === "thread"
    ? `COALESCE(t."name", ${groupExpr})`
    : groupExpr;

  const result = await q<
    {
      bucket: Date | string;
      groupKey: string;
      groupLabel: string;
      totalCalls: number;
    } & Record<string, number>
  >(
    `WITH ${buildAdminUsageSourceCte(`"admin_usage_source"`, sourceScope)},
     "usage_series" AS (
       SELECT
         DATE_TRUNC('${interval}', u."created_at") AS "bucket",
         ${groupExpr} AS "groupKey",
         ${labelExpr} AS "groupLabel",
         COUNT(*)::int AS "totalCalls",
         ${buildUsageSumSelects(`u."data"`)}
       FROM "admin_usage_source" u
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
      totals: sumUsageTotalsFromPoints(points),
    } satisfies AdminUsageResponse,
  };
}
