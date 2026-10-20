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
      accepted_operation: string | null;
      initiator: string;
    }
  >(
    `SELECT claims,consumed_run,accepted_operation,initiator FROM ${table} WHERE namespace=$1 AND tenant=$2 AND effect_key=$3 AND method='flow.start'`,
    [authority.scope.namespace, authority.scope.tenant, flow.id],
  )).rows[0];
  if (
    !row || row.claims.kind !== flow.kind ||
    row.claims.continuation !== flow.continuation ||
    row.claims.expiresAt !== flow.expiresAt ||
    Date.parse(flow.expiresAt) <= Date.parse(command.commandTime) ||
    !authority.scope.bindings["@credential-proof"] ||
    JSON.parse(row.initiator).proof !==
      authority.scope.bindings["@credential-proof"]
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
      row.consumed_run && row.consumed_run !== intent.invocation.runId ||
      intent.operation === "capture" &&
        row.accepted_operation !== intent.sourceOperationId
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
    `SELECT 1 FROM ${schema}.authorization_effects AS effect WHERE effect.namespace=$1 AND effect.tenant=$2 AND effect.effect_key=$3 AND (effect.operation_id=$4 OR effect.accepted_operation=$4)`,
    [authority.scope.namespace, authority.scope.tenant, authority.flow.id, id],
  );
  if (!rows.rows.length) authorizationRefused();
}

/** Reserve only a newly inserted, owner-authorized continuation before dispatch. */
export async function bindFlowOperation(
  authority: AuthenticatedAuthority,
  operationId: string,
  transaction: SqlExecutor,
) {
  if (!authority.flow) return;
  const result = await transaction.query(
    `UPDATE "${authority.scope.databaseSchema}".authorization_effects SET accepted_operation=$4 WHERE namespace=$1 AND tenant=$2 AND effect_key=$3 AND method='flow.start' AND accepted_operation IS NULL AND consumed_run IS NULL RETURNING effect_key`,
    [
      authority.scope.namespace,
      authority.scope.tenant,
      authority.flow.id,
      operationId,
    ],
  );
  if (!result.rows.length) authorizationRefused();
}
