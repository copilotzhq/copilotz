import type { Copilotz } from "@/index.ts";
import { listPublicAgents } from "@/utils/list-agents.ts";
import {
  type AdminAgentSummary,
  type AdminUsageBreakdown,
  buildUsageCoalesceSelects,
  buildUsageSumSelects,
  emptyUsageBreakdown,
  normalizeLimit,
  normalizeOffset,
  normalizeSearch,
  toIso,
  toNum,
  toUsageBreakdown,
} from "./_helpers.ts";

export default async function (
  request: { query?: Record<string, unknown> },
  copilotz: Copilotz,
) {
  const { query = {} } = request;
  const q = copilotz.ops.query;
  const namespace = query.namespace as string | undefined;
  const search = normalizeSearch(query.search as string | undefined);

  const params: unknown[] = [];
  const filters = [
    `n."type" = 'user'`,
    `COALESCE(n."data"->>'participantType', 'human') = 'agent'`,
  ];

  if (namespace) {
    params.push(namespace);
    filters.push(`(n."namespace" = $${params.length} OR n."namespace" = 'global')`);
  }
  if (search) {
    params.push(search);
    filters.push(
      `(LOWER(COALESCE(n."data"->>'externalId', n."source_id", n."id")) LIKE $${params.length}
        OR LOWER(COALESCE(n."data"->>'name', n."name", '')) LIKE $${params.length}
        OR LOWER(COALESCE(n."data"->>'agentId', '')) LIKE $${params.length})`,
    );
  }

  const msgScope: string[] = [`m."type" = 'message'`];
  const usageScope: string[] = [`u."type" = 'llm_usage'`];
  if (namespace) {
    params.push(namespace);
    const ni = params.length;
    msgScope.push(`m."namespace" IN (SELECT DISTINCT "threadId" FROM "events" WHERE "namespace" = $${ni})`);
    usageScope.push(`u."namespace" IN (SELECT DISTINCT "threadId" FROM "events" WHERE "namespace" = $${ni})`);
  }

  const result = await q<{
    agentId: string; displayName: string; namespace: string; isGlobal: boolean;
    messageCount: number; toolCallMessageCount: number; llmCallCount: number;
    lastActivityAt: Date | string | null;
  } & Record<keyof AdminUsageBreakdown, number>>(
    `WITH "message_stats" AS (
       SELECT COALESCE(m."data"->>'senderId', '') AS "agentId",
         COUNT(*)::int AS "messageCount",
         COUNT(*) FILTER (WHERE (
           ("data"->'toolCalls' IS NOT NULL AND jsonb_typeof("data"->'toolCalls') = 'array' AND jsonb_array_length("data"->'toolCalls') > 0)
           OR COALESCE("data"->>'toolCallId', '') <> ''
         ))::int AS "toolCallMessageCount",
         MAX(m."created_at") AS "lastActivityAt"
       FROM "nodes" AS m WHERE ${msgScope.join(" AND ")} GROUP BY 1
     ),
     "usage_stats" AS (
       SELECT COALESCE(u."data"->>'agentId', '') AS "agentId",
         COUNT(*)::int AS "llmCallCount",
         ${buildUsageSumSelects(`u."data"`)},
         MAX(u."created_at") AS "lastActivityAt"
       FROM "nodes" AS u WHERE ${usageScope.join(" AND ")} GROUP BY 1
     )
     SELECT
       COALESCE(n."data"->>'agentId', n."data"->>'externalId', n."source_id", n."id") AS "agentId",
       COALESCE(n."data"->>'name', n."name", COALESCE(n."data"->>'agentId', n."data"->>'externalId', n."source_id", n."id")) AS "displayName",
       n."namespace",
       COALESCE((n."data"->>'isGlobal')::boolean, n."namespace" = 'global') AS "isGlobal",
       COALESCE("message_stats"."messageCount", 0)::int AS "messageCount",
       COALESCE("message_stats"."toolCallMessageCount", 0)::int AS "toolCallMessageCount",
       COALESCE("usage_stats"."llmCallCount", 0)::int AS "llmCallCount",
       ${buildUsageCoalesceSelects("usage_stats")},
       COALESCE(GREATEST("message_stats"."lastActivityAt", "usage_stats"."lastActivityAt"),
         "message_stats"."lastActivityAt", "usage_stats"."lastActivityAt") AS "lastActivityAt"
     FROM "nodes" AS n
     LEFT JOIN "message_stats"
       ON "message_stats"."agentId" = COALESCE(n."data"->>'agentId', n."data"->>'externalId', n."source_id", n."id")
     LEFT JOIN "usage_stats"
       ON "usage_stats"."agentId" = COALESCE(n."data"->>'agentId', n."data"->>'externalId', n."source_id", n."id")
     WHERE ${filters.join(" AND ")}
     ORDER BY "lastActivityAt" DESC, "displayName" ASC`,
    params,
  );

  const configuredAgents = listPublicAgents(copilotz.config.agents ?? []);
  const configuredById = new Map(configuredAgents.map((a) => [a.id, a]));

  const merged = new Map<string, AdminAgentSummary>();
  for (const row of result.rows) {
    const cfg = configuredById.get(row.agentId);
    merged.set(row.agentId, {
      agentId: row.agentId,
      displayName: cfg?.name ?? row.displayName,
      description: cfg?.description ?? null,
      isConfigured: Boolean(cfg),
      namespace: row.namespace,
      isGlobal: Boolean(row.isGlobal),
      messageCount: toNum(row.messageCount),
      llmCallCount: toNum(row.llmCallCount),
      toolCallMessageCount: toNum(row.toolCallMessageCount),
      ...toUsageBreakdown(row),
      lastActivityAt: toIso(row.lastActivityAt),
    });
  }

  for (const cfg of configuredAgents) {
    if (merged.has(cfg.id)) continue;
    if (search) {
      const haystack = `${cfg.id} ${cfg.name} ${cfg.description ?? ""}`.toLowerCase();
      if (!haystack.includes(search.replaceAll("%", ""))) continue;
    }
    merged.set(cfg.id, {
      agentId: cfg.id,
      displayName: cfg.name,
      description: cfg.description ?? null,
      isConfigured: true,
      namespace: namespace ?? "global",
      isGlobal: !namespace,
      messageCount: 0, llmCallCount: 0, toolCallMessageCount: 0,
      ...emptyUsageBreakdown(),
      lastActivityAt: null,
    });
  }

  const limit = normalizeLimit(query.limit ? Number(query.limit) : undefined);
  const offset = normalizeOffset(query.offset ? Number(query.offset) : undefined);

  const data: AdminAgentSummary[] = Array.from(merged.values())
    .sort((a, b) => {
      const at = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
      const bt = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
      if (bt !== at) return bt - at;
      return a.displayName.localeCompare(b.displayName);
    })
    .slice(offset, offset + limit);

  return { status: 200, data };
}
