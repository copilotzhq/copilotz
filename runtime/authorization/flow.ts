/** Hard flow bounds supplement host policy; policy cannot widen them. */
import type { AuthenticatedAuthority } from "./authority.ts";
import type { SqlExecutor } from "../events/session.ts";
import { type AuthorizationIntent, authorizationRefused } from "./evaluator.ts";
export async function checkFlow(
  authority: AuthenticatedAuthority,
  intent: AuthorizationIntent,
  command: { transaction: SqlExecutor; commandTime: string },
) {
  const flow = authority.flow;
  if (!flow) return;
  const table = `"${authority.scope.databaseSchema}".authorization_effects`;
  const row = (await command.transaction.query<
    {
      claims: { kind: string; continuation: string; expiresAt: string };
      consumed_run: string | null;
    }
  >(
    `SELECT claims,consumed_run FROM ${table} WHERE namespace=$1 AND tenant=$2 AND effect_key=$3 AND method='flow.start'`,
    [authority.scope.namespace, authority.scope.tenant, flow.id],
  )).rows[0];
  if (
    !row || row.claims.kind !== flow.kind ||
    row.claims.continuation !== flow.continuation ||
    row.claims.expiresAt !== flow.expiresAt ||
    Date.parse(flow.expiresAt) <= Date.parse(command.commandTime)
  ) authorizationRefused();
  if (intent.kind === "operation" && intent.operation === "read") return;
  if (intent.kind === "observation" && intent.operation === "attach") {
    const input = intent.input as { operationIds?: unknown; record?: unknown };
    if (
      input.record || !Array.isArray(input.operationIds) ||
      !input.operationIds.length
    ) authorizationRefused();
    return;
  }
  if (intent.kind === "action") {
    if (intent.operation === "admit" && intent.resource === flow.continuation) {
      return;
    }
    if (
      intent.resource !== flow.continuation || !intent.invocation?.runId ||
      row.consumed_run && row.consumed_run !== intent.invocation.runId
    ) authorizationRefused();
    if (intent.operation === "capture" && !row.consumed_run) {
      await command.transaction.query(
        `UPDATE ${table} SET consumed_run=$4 WHERE namespace=$1 AND tenant=$2 AND effect_key=$3`,
        [
          authority.scope.namespace,
          authority.scope.tenant,
          flow.id,
          intent.invocation.runId,
        ],
      );
    }
    return;
  }
  // Only the owner-resolved continuation can exercise its granted internal writes.
  if (
    intent.invocation?.runId && row.consumed_run === intent.invocation.runId &&
    ["collection", "session", "asset"].includes(intent.kind)
  ) return;
  authorizationRefused();
}
export async function assertFlowOperation(
  authority: AuthenticatedAuthority,
  id: string,
  transaction: SqlExecutor,
) {
  if (!authority.flow) return;
  const schema = `"${authority.scope.databaseSchema}"`;
  const rows = await transaction.query(
    `SELECT 1 FROM ${schema}.authorization_effects AS effect LEFT JOIN ${schema}.authorization_invocations AS invocation ON invocation.namespace=effect.namespace AND invocation.run_id=effect.consumed_run WHERE effect.namespace=$1 AND effect.tenant=$2 AND effect.effect_key=$3 AND (effect.operation_id=$4 OR invocation.source_event_id=$4)`,
    [authority.scope.namespace, authority.scope.tenant, authority.flow.id, id],
  );
  if (!rows.rows.length) authorizationRefused();
}
