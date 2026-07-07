import type { Copilotz } from "@/index.ts";
import {
  normalizeLimit,
  normalizeOffset,
  normalizeSearch,
  toIso,
  toNum,
} from "./_helpers.ts";

type AdminQueueEventStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "expired"
  | "overwritten";

interface AdminQueueEventRow extends Record<string, unknown> {
  id: string;
  threadId: string;
  eventType: string;
  payload: unknown;
  parentEventId: string | null;
  traceId: string | null;
  priority: number | null;
  status: AdminQueueEventStatus;
  namespace: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}

function normalizeExactFilter(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export default async function (
  request: { query?: Record<string, unknown> },
  copilotz: Copilotz,
) {
  const { query = {} } = request;
  const q = copilotz.ops.query;

  const params: unknown[] = [];
  const filters: string[] = [];

  const namespace = normalizeExactFilter(query.namespace);
  if (namespace) {
    params.push(namespace);
    filters.push(`e."namespace" = $${params.length}`);
  }

  const threadId = normalizeExactFilter(query.threadId);
  if (threadId) {
    params.push(threadId);
    filters.push(`e."threadId" = $${params.length}`);
  }

  const status = normalizeExactFilter(query.status);
  if (status && status !== "all") {
    params.push(status);
    filters.push(`e."status" = $${params.length}`);
  }

  const eventType = normalizeExactFilter(query.eventType ?? query.type);
  if (eventType) {
    params.push(eventType);
    filters.push(`e."eventType" = $${params.length}`);
  }

  const traceId = normalizeExactFilter(query.traceId);
  if (traceId) {
    params.push(traceId);
    filters.push(`e."traceId" = $${params.length}`);
  }

  const search = normalizeSearch(query.search as string | undefined);
  if (search) {
    params.push(search);
    filters.push(
      `(LOWER(e."id") LIKE $${params.length}
        OR LOWER(e."threadId") LIKE $${params.length}
        OR LOWER(e."eventType") LIKE $${params.length}
        OR LOWER(COALESCE(e."traceId", '')) LIKE $${params.length}
        OR LOWER(COALESCE(e."parentEventId", '')) LIKE $${params.length})`,
    );
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = Math.min(
    normalizeLimit(query.limit ? Number(query.limit) : undefined, 50),
    200,
  );
  const offset = normalizeOffset(
    query.offset ? Number(query.offset) : undefined,
  );
  params.push(limit);
  const li = params.length;
  params.push(offset);
  const oi = params.length;

  const result = await q<AdminQueueEventRow>(
    `SELECT
       e."id",
       e."threadId",
       e."eventType",
       e."payload",
       e."parentEventId",
       e."traceId",
       e."priority",
       e."status",
       e."namespace",
       e."metadata",
       e."createdAt",
       e."updatedAt"
     FROM "events" AS e
     ${whereClause}
     ORDER BY e."createdAt" DESC, e."id" DESC
     LIMIT $${li} OFFSET $${oi}`,
    params,
  );

  const data = result.rows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    eventType: row.eventType,
    payload: row.payload,
    parentEventId: row.parentEventId ?? null,
    traceId: row.traceId ?? null,
    priority: row.priority === null || row.priority === undefined
      ? null
      : toNum(row.priority),
    status: row.status,
    namespace: row.namespace ?? null,
    metadata: row.metadata ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }));

  return { status: 200, data };
}
