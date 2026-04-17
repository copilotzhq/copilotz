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
  participantTotals: { total: number; humans: number; agents: number };
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
  participantType: "human" | "agent";
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
  { key: "inputTokens", cast: "bigint" },
  { key: "outputTokens", cast: "bigint" },
  { key: "reasoningTokens", cast: "bigint" },
  { key: "cacheReadInputTokens", cast: "bigint" },
  { key: "cacheCreationInputTokens", cast: "bigint" },
  { key: "totalTokens", cast: "bigint" },
  { key: "inputCostUsd", cast: "float8" },
  { key: "outputCostUsd", cast: "float8" },
  { key: "reasoningCostUsd", cast: "float8" },
  { key: "cacheReadInputCostUsd", cast: "float8" },
  { key: "cacheCreationInputCostUsd", cast: "float8" },
  { key: "totalCostUsd", cast: "float8" },
] as const;

export function buildUsageSumSelects(dataColumn: string): string {
  return USAGE_BREAKDOWN_FIELDS
    .map((f) => `COALESCE(SUM((${dataColumn}->>'${f.key}')::${f.cast}), 0)::${f.cast} AS "${f.key}"`)
    .join(",\n         ");
}

export function buildUsageCoalesceSelects(alias: string): string {
  return USAGE_BREAKDOWN_FIELDS
    .map((f) => `COALESCE("${alias}"."${f.key}", 0)::${f.cast} AS "${f.key}"`)
    .join(",\n         ");
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

export function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function emptyUsageBreakdown(): AdminUsageBreakdown {
  return {
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0,
    inputCostUsd: 0, outputCostUsd: 0, reasoningCostUsd: 0,
    cacheReadInputCostUsd: 0, cacheCreationInputCostUsd: 0, totalCostUsd: 0,
  };
}

export function emptyUsageTotals(): AdminUsageTotals {
  return { totalCalls: 0, ...emptyUsageBreakdown() };
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
  if (f) { params.push(f); filters.push(`${column} >= $${params.length}`); }
  const t = toIsoString(to ?? null);
  if (t) { params.push(t); filters.push(`${column} <= $${params.length}`); }
}

export function pushThreadNamespace(
  params: unknown[],
  filters: string[],
  threadIdExpr: string,
  namespace?: string,
) {
  if (!namespace) return;
  params.push(namespace);
  filters.push(
    `EXISTS (SELECT 1 FROM "events" AS "scope_events" WHERE "scope_events"."threadId" = ${threadIdExpr} AND "scope_events"."namespace" = $${params.length})`,
  );
}

export function pushScopedThreadNode(
  params: unknown[],
  filters: string[],
  nsExpr: string,
  namespace?: string,
) {
  if (!namespace) return;
  params.push(namespace);
  filters.push(
    `${nsExpr} IN (SELECT DISTINCT "threadId" FROM "events" WHERE "namespace" = $${params.length})`,
  );
}

export function normalizeSearch(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? `%${trimmed.toLowerCase()}%` : null;
}

export function normalizeLimit(value?: number, fallback = 25): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

export function normalizeOffset(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}
