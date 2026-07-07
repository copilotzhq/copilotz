/**
 * Shared helpers for admin feature queries.
 * Internal module — not loaded as a feature action (prefixed with underscore).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  reasoningCostUsd: number;
  cacheReadInputCostUsd: number;
  cacheCreationInputCostUsd: number;
  totalCostUsd: number;
}

export interface AdminUsageTotals extends AdminUsageBreakdown {
  totalCalls: number;
  failedCalls: number;
  unpricedCalls: number;
  totalDurationMs: number;
  totalCredits: number;
}

export interface AdminOverview {
  threadTotals: { total: number; active: number; archived: number };
  queueTotals: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    expired: number;
    overwritten: number;
  };
  messageTotals: { total: number; toolCallMessages: number };
  participantTotals: {
    total: number;
    humans: number;
    agents: number;
    jobs: number;
  };
  llmTotals: AdminUsageTotals;
}

export interface AdminActivityPoint extends AdminUsageTotals {
  bucket: string;
  messageCount: number;
  toolCallMessageCount: number;
  llmCallCount: number;
}

export interface AdminThreadSummary {
  threadId: string;
  name: string;
  status: string;
  summary: string | null;
  participantIds: string[];
  messageCount: number;
  lastActivityAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AdminParticipantSummary {
  externalId: string;
  displayName: string;
  participantType: "human" | "agent" | "job";
  namespace: string;
  isGlobal: boolean;
  messageCount: number;
  threadCount: number;
  lastActivityAt: string | null;
}

export interface AdminAgentSummary {
  agentId: string;
  displayName: string;
  description: string | null;
  isConfigured: boolean;
  namespace: string;
  isGlobal: boolean;
  messageCount: number;
  llmCallCount: number;
  toolCallMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  reasoningCostUsd: number;
  cacheReadInputCostUsd: number;
  cacheCreationInputCostUsd: number;
  totalCostUsd: number;
  lastActivityAt: string | null;
}

// ---------------------------------------------------------------------------
// LLM usage field definitions
// ---------------------------------------------------------------------------

const USAGE_BREAKDOWN_FIELDS = [
  { key: "inputTokens", source: "usage", cast: "bigint" },
  { key: "outputTokens", source: "usage", cast: "bigint" },
  { key: "reasoningTokens", source: "usage", cast: "bigint" },
  { key: "cacheReadInputTokens", source: "usage", cast: "bigint" },
  { key: "cacheCreationInputTokens", source: "usage", cast: "bigint" },
  { key: "totalTokens", source: "usage", cast: "bigint" },
  { key: "inputCostUsd", source: "cost", cast: "float8" },
  { key: "outputCostUsd", source: "cost", cast: "float8" },
  { key: "reasoningCostUsd", source: "cost", cast: "float8" },
  { key: "cacheReadInputCostUsd", source: "cost", cast: "float8" },
  { key: "cacheCreationInputCostUsd", source: "cost", cast: "float8" },
  { key: "totalCostUsd", source: "cost", cast: "float8" },
] as const;

export function buildUsageSumSelects(dataColumn: string): string {
  return USAGE_BREAKDOWN_FIELDS
    .map((f) =>
      `COALESCE(SUM((${dataColumn}->>'${f.key}')::${f.cast}), 0)::${f.cast} AS "${f.key}"`
    )
    .join(",\n         ");
}

export function buildAttemptUsageSumSelects(dataColumn: string): string {
  return USAGE_BREAKDOWN_FIELDS
    .map((f) =>
      `COALESCE(SUM((${dataColumn}->'${f.source}'->>'${f.key}')::${f.cast}), 0)::${f.cast} AS "${f.key}"`
    )
    .join(",\n         ");
}

export function buildUsageCoalesceSelects(alias: string): string {
  return USAGE_BREAKDOWN_FIELDS
    .map((f) => `COALESCE("${alias}"."${f.key}", 0)::${f.cast} AS "${f.key}"`)
    .join(",\n         ");
}

function usageMetricExpr(dataColumn: string, metric: string): string {
  return `NULLIF(${dataColumn}->'metrics'->>'${metric}', '')::float8`;
}

function usageCallsExpr(dataColumn: string): string {
  return `COALESCE(${usageMetricExpr(dataColumn, "calls")}, 1)`;
}

function usageCostExpr(dataColumn: string): string {
  return `NULLIF(${dataColumn}->>'totalCostUsd', '')::float8`;
}

export function buildUsageMeteringSumSelects(dataColumn: string): string {
  const callsExpr = usageCallsExpr(dataColumn);
  const failedStatuses = "'failed', 'cancelled', 'aborted', 'error'";
  return [
    `COALESCE(SUM(${callsExpr}), 0)::float8 AS "totalCalls"`,
    `COALESCE(SUM(COALESCE(${
      usageMetricExpr(dataColumn, "durationMs")
    }, 0)), 0)::float8 AS "totalDurationMs"`,
    `COALESCE(SUM(COALESCE(${
      usageMetricExpr(dataColumn, "credits")
    }, 0)), 0)::float8 AS "totalCredits"`,
    `COALESCE(SUM(CASE WHEN COALESCE(${dataColumn}->>'status', '') IN (${failedStatuses}) THEN ${callsExpr} ELSE 0 END), 0)::float8 AS "failedCalls"`,
    `COALESCE(SUM(CASE WHEN ${
      usageCostExpr(dataColumn)
    } IS NULL THEN ${callsExpr} ELSE 0 END), 0)::float8 AS "unpricedCalls"`,
  ].join(",\n         ");
}

export function buildUsageMeteringCoalesceSelects(alias: string): string {
  return [
    "totalCalls",
    "totalDurationMs",
    "totalCredits",
    "failedCalls",
    "unpricedCalls",
  ].map((key) => `COALESCE("${alias}"."${key}", 0)::float8 AS "${key}"`)
    .join(",\n         ");
}

export interface AdminUsageSourceScope {
  namespacePlaceholder?: string;
  fromPlaceholder?: string;
  toPlaceholder?: string;
  threadIdPlaceholder?: string;
  kindPlaceholder?: string;
  includeAllKinds?: boolean;
}

export function pushAdminUsageSourceScope(
  params: unknown[],
  namespace?: string,
  from?: string | null,
  to?: string | null,
  threadId?: string,
  kind?: string | null,
): AdminUsageSourceScope {
  const scope: AdminUsageSourceScope = {};
  if (namespace) {
    params.push(namespace);
    scope.namespacePlaceholder = `$${params.length}`;
  }
  const f = toIsoString(from ?? null);
  if (f) {
    params.push(f);
    scope.fromPlaceholder = `$${params.length}`;
  }
  const t = toIsoString(to ?? null);
  if (t) {
    params.push(t);
    scope.toPlaceholder = `$${params.length}`;
  }
  if (threadId) {
    params.push(threadId);
    scope.threadIdPlaceholder = `$${params.length}`;
  }
  if (kind === null || kind === "all") {
    scope.includeAllKinds = true;
  } else if (kind && kind !== "llm") {
    params.push(kind);
    scope.kindPlaceholder = `$${params.length}`;
  }
  return scope;
}

function buildUsageSourceNodeFilters(
  alias: string,
  scope: AdminUsageSourceScope,
): string {
  // Aggregate from the lightweight unified usage ledger. By default admin
  // aggregate surfaces remain LLM-scoped for compatibility; callers can opt
  // into a specific kind or all kinds for the generic Usage explorer.
  const filters = [`${alias}."type" = 'usage'`];
  if (!scope.includeAllKinds) {
    filters.push(
      scope.kindPlaceholder
        ? `${alias}."data"->>'kind' = ${scope.kindPlaceholder}`
        : `${alias}."data"->>'kind' = 'llm'`,
    );
  }
  if (scope.namespacePlaceholder) {
    filters.push(`${alias}."namespace" = ${scope.namespacePlaceholder}`);
  }
  if (scope.fromPlaceholder) {
    filters.push(`${alias}."created_at" >= ${scope.fromPlaceholder}`);
  }
  if (scope.toPlaceholder) {
    filters.push(`${alias}."created_at" <= ${scope.toPlaceholder}`);
  }
  if (scope.threadIdPlaceholder) {
    filters.push(
      `COALESCE(${alias}."data"->>'threadId', ${alias}."source_id") = ${scope.threadIdPlaceholder}`,
    );
  }
  return filters.join(" AND ");
}

export function buildAdminUsageSourceCte(
  name = `"admin_usage_source"`,
  scope: AdminUsageSourceScope = {},
): string {
  const sourceWhere = buildUsageSourceNodeFilters("a", scope);
  return `${name} AS (
       SELECT
         a."id",
         a."namespace",
         a."created_at",
         COALESCE(a."data"->>'threadId', a."source_id") AS "threadId",
         NULLIF(a."data"->>'eventId', '') AS "eventId",
         COALESCE(a."data"->>'kind', 'unknown') AS "kind",
         COALESCE(a."data"->>'resource', '') AS "resource",
         COALESCE(a."data"->>'operation', '') AS "operation",
         COALESCE(a."data"->>'status', '') AS "status",
         COALESCE(a."data"->>'agentId', '') AS "agentId",
         COALESCE(a."data"->>'initiatedById', '') AS "initiatedById",
         COALESCE(a."data"->>'provider', '') AS "provider",
         COALESCE(a."data"->>'model', '') AS "model",
         a."data" AS "data",
         'usage'::text AS "sourceType"
       FROM "nodes" a
       WHERE ${sourceWhere}
     )`;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

export function toNum(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function toIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return null;
}

export function toIsoString(
  value: Date | string | null | undefined,
): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function emptyUsageBreakdown(): AdminUsageBreakdown {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    inputCostUsd: 0,
    outputCostUsd: 0,
    reasoningCostUsd: 0,
    cacheReadInputCostUsd: 0,
    cacheCreationInputCostUsd: 0,
    totalCostUsd: 0,
  };
}

export function emptyUsageTotals(): AdminUsageTotals {
  return {
    totalCalls: 0,
    failedCalls: 0,
    unpricedCalls: 0,
    totalDurationMs: 0,
    totalCredits: 0,
    ...emptyUsageBreakdown(),
  };
}

export function sumUsageTotalsFromPoints(
  points: ReadonlyArray<Partial<AdminUsageTotals>>,
): AdminUsageTotals {
  return points.reduce<AdminUsageTotals>(
    (acc, point) => ({
      totalCalls: acc.totalCalls + toNum(point.totalCalls),
      failedCalls: acc.failedCalls + toNum(point.failedCalls),
      unpricedCalls: acc.unpricedCalls + toNum(point.unpricedCalls),
      totalDurationMs: acc.totalDurationMs + toNum(point.totalDurationMs),
      totalCredits: acc.totalCredits + toNum(point.totalCredits),
      inputTokens: acc.inputTokens + toNum(point.inputTokens),
      outputTokens: acc.outputTokens + toNum(point.outputTokens),
      reasoningTokens: acc.reasoningTokens + toNum(point.reasoningTokens),
      cacheReadInputTokens: acc.cacheReadInputTokens +
        toNum(point.cacheReadInputTokens),
      cacheCreationInputTokens: acc.cacheCreationInputTokens +
        toNum(point.cacheCreationInputTokens),
      totalTokens: acc.totalTokens + toNum(point.totalTokens),
      inputCostUsd: acc.inputCostUsd + toNum(point.inputCostUsd),
      outputCostUsd: acc.outputCostUsd + toNum(point.outputCostUsd),
      reasoningCostUsd: acc.reasoningCostUsd + toNum(point.reasoningCostUsd),
      cacheReadInputCostUsd: acc.cacheReadInputCostUsd +
        toNum(point.cacheReadInputCostUsd),
      cacheCreationInputCostUsd: acc.cacheCreationInputCostUsd +
        toNum(point.cacheCreationInputCostUsd),
      totalCostUsd: acc.totalCostUsd + toNum(point.totalCostUsd),
    }),
    emptyUsageTotals(),
  );
}

export function toUsageBreakdown(
  row?: Partial<Record<keyof AdminUsageBreakdown, unknown>> | null,
): AdminUsageBreakdown {
  return {
    inputTokens: toNum(row?.inputTokens),
    outputTokens: toNum(row?.outputTokens),
    reasoningTokens: toNum(row?.reasoningTokens),
    cacheReadInputTokens: toNum(row?.cacheReadInputTokens),
    cacheCreationInputTokens: toNum(row?.cacheCreationInputTokens),
    totalTokens: toNum(row?.totalTokens),
    inputCostUsd: toNum(row?.inputCostUsd),
    outputCostUsd: toNum(row?.outputCostUsd),
    reasoningCostUsd: toNum(row?.reasoningCostUsd),
    cacheReadInputCostUsd: toNum(row?.cacheReadInputCostUsd),
    cacheCreationInputCostUsd: toNum(row?.cacheCreationInputCostUsd),
    totalCostUsd: toNum(row?.totalCostUsd),
  };
}

export function toUsageTotals(
  row?: Partial<Record<keyof AdminUsageTotals, unknown>> | null,
  callCountKey: string = "totalCalls",
): AdminUsageTotals {
  return {
    totalCalls: toNum((row as Record<string, unknown>)?.[callCountKey]),
    failedCalls: toNum(row?.failedCalls),
    unpricedCalls: toNum(row?.unpricedCalls),
    totalDurationMs: toNum(row?.totalDurationMs),
    totalCredits: toNum(row?.totalCredits),
    ...toUsageBreakdown(row),
  };
}

// ---------------------------------------------------------------------------
// SQL filter builders
// ---------------------------------------------------------------------------

export function pushTimeRange(
  params: unknown[],
  filters: string[],
  column: string,
  from?: string | null,
  to?: string | null,
) {
  const f = toIsoString(from ?? null);
  if (f) {
    params.push(f);
    filters.push(`${column} >= $${params.length}`);
  }
  const t = toIsoString(to ?? null);
  if (t) {
    params.push(t);
    filters.push(`${column} <= $${params.length}`);
  }
}

export function pushThreadNamespace(
  params: unknown[],
  filters: string[],
  threadNamespaceExpr: string,
  namespace?: string,
) {
  if (!namespace) return;
  params.push(namespace);
  filters.push(`${threadNamespaceExpr} = $${params.length}`);
}

export function pushScopedThreadNode(
  params: unknown[],
  filters: string[],
  nsExpr: string,
  namespace?: string,
) {
  if (!namespace) return;
  params.push(namespace);
  filters.push(`${nsExpr} = $${params.length}`);
}

export function normalizeSearch(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? `%${trimmed.toLowerCase()}%` : null;
}

export function normalizeLimit(value?: number, fallback = 25): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function normalizeOffset(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}
