import type { Copilotz } from "@/index.ts";
import {
  type AdminOverview,
  buildUsageSumSelects,
  emptyUsageTotals,
  pushScopedThreadNode,
  pushThreadNamespace,
  pushTimeRange,
  toNum,
  toUsageTotals,
} from "./_helpers.ts";

type AdminUsageTotalsRow = Record<string, number>;

export default async function (
  request: { query?: Record<string, unknown> },
  copilotz: Copilotz,
) {
  const { query = {} } = request;
  const namespace = query.namespace as string | undefined;
  const from = query.from as string | undefined;
  const to = query.to as string | undefined;
  const q = copilotz.ops.query;

  // Thread totals
  const tp: unknown[] = [];
  const tf: string[] = [];
  pushThreadNamespace(tp, tf, `t."id"`, namespace);
  pushTimeRange(tp, tf, `t."createdAt"`, from, to);
  const tw = tf.length ? `WHERE ${tf.join(" AND ")}` : "";
  const threadResult = await q<{ total: number; active: number; archived: number }>(
    `SELECT COUNT(*)::int AS "total",
       COUNT(*) FILTER (WHERE t."status" = 'active')::int AS "active",
       COUNT(*) FILTER (WHERE t."status" = 'archived')::int AS "archived"
     FROM "threads" AS t ${tw}`,
    tp,
  );

  // Queue totals
  const qp: unknown[] = [];
  const qf: string[] = [];
  if (namespace) { qp.push(namespace); qf.push(`"namespace" = $${qp.length}`); }
  pushTimeRange(qp, qf, `"createdAt"`, from, to);
  const qw = qf.length ? `WHERE ${qf.join(" AND ")}` : "";
  const queueResult = await q<{
    total: number; pending: number; processing: number; completed: number;
    failed: number; expired: number; overwritten: number;
  }>(
    `SELECT COUNT(*)::int AS "total",
       COUNT(*) FILTER (WHERE "status" = 'pending')::int AS "pending",
       COUNT(*) FILTER (WHERE "status" = 'processing')::int AS "processing",
       COUNT(*) FILTER (WHERE "status" = 'completed')::int AS "completed",
       COUNT(*) FILTER (WHERE "status" = 'failed')::int AS "failed",
       COUNT(*) FILTER (WHERE "status" = 'expired')::int AS "expired",
       COUNT(*) FILTER (WHERE "status" = 'overwritten')::int AS "overwritten"
     FROM "events" ${qw}`,
    qp,
  );

  // Message totals
  const mp: unknown[] = [];
  const mf: string[] = [`"type" = 'message'`];
  pushScopedThreadNode(mp, mf, `"namespace"`, namespace);
  pushTimeRange(mp, mf, `"created_at"`, from, to);
  const messageResult = await q<{ total: number; toolCallMessages: number }>(
    `SELECT COUNT(*)::int AS "total",
       COUNT(*) FILTER (WHERE (
         ("data"->'toolCalls' IS NOT NULL AND jsonb_typeof("data"->'toolCalls') = 'array' AND jsonb_array_length("data"->'toolCalls') > 0)
         OR COALESCE("data"->>'toolCallId', '') <> ''
       ))::int AS "toolCallMessages"
     FROM "nodes" WHERE ${mf.join(" AND ")}`,
    mp,
  );

  // Participant totals
  const pp: unknown[] = [];
  const pf: string[] = [`"type" = 'user'`];
  if (namespace) {
    pp.push(namespace);
    pf.push(`("namespace" = $${pp.length} OR "namespace" = 'global')`);
  }
  const participantResult = await q<{ total: number; humans: number; agents: number }>(
    `SELECT COUNT(*)::int AS "total",
       COUNT(*) FILTER (WHERE COALESCE("data"->>'participantType', 'human') = 'human')::int AS "humans",
       COUNT(*) FILTER (WHERE COALESCE("data"->>'participantType', 'human') = 'agent')::int AS "agents"
     FROM "nodes" WHERE ${pf.join(" AND ")}`,
    pp,
  );

  // LLM usage totals
  const up: unknown[] = [];
  const uf: string[] = [`"type" = 'llm_usage'`];
  pushScopedThreadNode(up, uf, `"namespace"`, namespace);
  pushTimeRange(up, uf, `"created_at"`, from, to);
  const usageResult = await q<AdminUsageTotalsRow>(
    `SELECT COUNT(*)::int AS "totalCalls", ${buildUsageSumSelects(`"data"`)}
     FROM "nodes" WHERE ${uf.join(" AND ")}`,
    up,
  );

  const t = threadResult.rows[0] ?? { total: 0, active: 0, archived: 0 };
  const qr = queueResult.rows[0] ?? { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, expired: 0, overwritten: 0 };
  const mr = messageResult.rows[0] ?? { total: 0, toolCallMessages: 0 };
  const pr = participantResult.rows[0] ?? { total: 0, humans: 0, agents: 0 };

  const data: AdminOverview = {
    threadTotals: { total: toNum(t.total), active: toNum(t.active), archived: toNum(t.archived) },
    queueTotals: {
      total: toNum(qr.total), pending: toNum(qr.pending), processing: toNum(qr.processing),
      completed: toNum(qr.completed), failed: toNum(qr.failed), expired: toNum(qr.expired),
      overwritten: toNum(qr.overwritten),
    },
    messageTotals: { total: toNum(mr.total), toolCallMessages: toNum(mr.toolCallMessages) },
    participantTotals: { total: toNum(pr.total), humans: toNum(pr.humans), agents: toNum(pr.agents) },
    llmTotals: toUsageTotals(usageResult.rows[0] ?? emptyUsageTotals()),
  };

  return { status: 200, data };
}
