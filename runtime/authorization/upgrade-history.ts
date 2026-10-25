/** Conservative terminal evidence for the offline authority inventory. */
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { verifiedEventBody } from "../events/body-store.ts";
import { protectedActionLifecycleBody } from "../actions/protected-lifecycle.ts";

export type AuthorityHistory = Readonly<{
  kind: "invocation" | "event";
  namespace: string;
  id: string;
  resumable: false;
  evidence: Readonly<Record<string, unknown>>;
}>;
export function authorityHistoryKey(
  kind: AuthorityHistory["kind"],
  namespace: string,
  id: string,
) {
  return JSON.stringify(["authorization.history", kind, namespace, id]);
}

/** Extract JSON identities once, retaining only small evidence coordinates. */
export async function terminalAuthorityEvidence(
  tx: SqlExecutor,
  schema: string,
) {
  const t = createCoreTableNames(schema);
  const rows = (await tx.query<{
    namespace: string;
    run_id: string;
    action_id: string;
    invoked_id: string;
    terminal_id: string | null;
    receipt: Record<string, unknown> | null;
    receipt_key: string | null;
    receipt_fingerprint: string | null;
    reviewed_fingerprint: string | null;
  }>(`WITH keys AS MATERIALIZED (
    -- Legacy deferred Actions also wrote 'deferred' bodies and status-less
    -- resolve bodies; both are known, non-terminal lifecycle steps.
    SELECT namespace,event_body_id,COALESCE(body->'data',body)->>'actionRunId' AS run_id,
      COALESCE(body->'data',body)->>'actionId' AS action_id,
      COALESCE(COALESCE(body->'data',body)->>'status',
        CASE WHEN COALESCE(body->'data',body) ? 'resolveGeneration' THEN 'resolve' END) AS status
    FROM ${t.event_bodies}
  ), runs AS (
    SELECT namespace,run_id,min(action_id) AS action_id,
      min(event_body_id) FILTER (WHERE status='invoked') AS invoked_id,
      min(event_body_id) FILTER (WHERE status IN ('completed','failed','cancelled')) AS terminal_id
    FROM keys WHERE run_id IS NOT NULL GROUP BY namespace,run_id
    HAVING count(*) FILTER (WHERE status='invoked')=1
      AND count(*) FILTER (WHERE status IN ('completed','failed','cancelled'))<=1
      AND count(DISTINCT action_id)=1 AND bool_and(action_id IS NOT NULL)
      AND bool_and(COALESCE(status IN ('invoked','progress','awaiting','deferred','resolve','completed','failed','cancelled'),false))
  ) SELECT r.*,receipt.result AS receipt,receipt.key AS receipt_key,receipt.intent->>'fingerprint' AS receipt_fingerprint,
      (SELECT to_jsonb(m)->>'upgrade_reviewed_fingerprint' FROM ${t.copilotz_schema_metadata} m WHERE singleton) AS reviewed_fingerprint FROM runs r
    LEFT JOIN ${t.owner_receipts} receipt ON receipt.owner='schema' AND receipt.domain='logical'
      AND receipt.kind='action.upgrade-terminal' AND receipt.principal='offline-upgrade'
      AND (receipt.key=('["action.upgrade-terminal",' || to_json(r.namespace)::text || ',' || to_json(r.run_id)::text || ']')
        OR (receipt.result->>'namespace'=r.namespace AND receipt.result->>'runId'=r.run_id))
    WHERE r.terminal_id IS NOT NULL OR receipt.key IS NOT NULL`)).rows;
  return new Map(rows.map((r) => [JSON.stringify([r.namespace, r.run_id]), r]));
}

export async function verifiedTerminalEvidence(
  terminal:
    | { body: unknown; digest: string; schema_version: number }
    | undefined,
  row: Awaited<ReturnType<typeof terminalAuthorityEvidence>> extends
    Map<string, infer T> ? T : never,
  bodyId: string,
): Promise<Record<string, unknown> | undefined> {
  if (row.invoked_id !== bodyId) return;
  let ownTerminal;
  if (row.terminal_id) {
    if (!terminal) return;
    const raw = await verifiedEventBody(terminal, {
      eventBodyId: row.terminal_id,
      schemaVersion: terminal.schema_version,
      mediaType: "application/json",
    });
    const data = (protectedActionLifecycleBody(raw)?.data ?? raw) as Record<
      string,
      unknown
    >;
    if (
      data.actionRunId !== row.run_id || data.actionId !== row.action_id ||
      !["completed", "failed", "cancelled"].includes(String(data.status))
    ) return;
    ownTerminal = {
      terminalSource: "own-terminal",
      bodyId: row.terminal_id,
      bodyDigest: terminal.digest,
      status: data.status,
    };
  }
  const r = row.receipt;
  if (!r) return row.receipt_key ? undefined : ownTerminal;
  if (
    !row.reviewed_fingerprint ||
    row.receipt_fingerprint !== row.reviewed_fingerprint ||
    (ownTerminal && ownTerminal.status !== r.status) ||
    row.receipt_key !==
      JSON.stringify(["action.upgrade-terminal", row.namespace, row.run_id]) ||
    r.namespace !== row.namespace || r.runId !== row.run_id ||
    r.actionId !== row.action_id || r.bodyId !== bodyId ||
    !["completed", "failed", "cancelled"].includes(String(r.status)) ||
    !["wrapper-attested", "reviewed-abandonment"].includes(
      String(r.terminalSource),
    ) ||
    (r.terminalSource === "reviewed-abandonment" &&
      (r.status !== "cancelled" || r.reason !== "abandoned-before-upgrade"))
  ) return;
  return {
    ...r,
    // Receipt bodyId/bodyDigest identify the reviewed invocation, not a terminal.
    ...(ownTerminal
      ? {
        terminalBodyId: ownTerminal.bodyId,
        terminalBodyDigest: ownTerminal.bodyDigest,
      }
      : {}),
    receiptKey: row.receipt_key,
    receiptFingerprint: row.receipt_fingerprint,
  };
}
