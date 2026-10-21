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
  const invocation = intent.invocation;
  const receipts = `"${authority.scope.databaseSchema}".owner_receipts`;
  const key = (runId: string) =>
    JSON.stringify([
      "flow.descendant",
      authority.scope.namespace,
      authority.scope.tenant,
      flow.id,
      runId,
    ]);
  const descendant = async (runId: string, actionId?: string) => {
    const receipt = (await command.transaction.query<{
      intent: { root: string; operation: string; action: string };
    }>(
      `SELECT intent FROM ${receipts} WHERE owner='schema' AND domain='logical' AND key=$1 AND kind='flow.descendant'`,
      [key(runId)],
    )).rows[0];
    return !!receipt && receipt.intent.root === row.consumed_run &&
      receipt.intent.operation === row.accepted_operation &&
      (!actionId || receipt.intent.action === actionId);
  };
  if (intent.kind === "action") {
    if (intent.operation === "admit" && intent.resource === flow.continuation) {
      return;
    }
    if (
      row.consumed_run && row.accepted_operation &&
      invocation?.kind === "action" && invocation.runId &&
      intent.sourceOperationId === row.accepted_operation
    ) {
      if (await descendant(invocation.runId, invocation.id)) return;
      if (
        intent.operation === "capture" && invocation.parentRunId &&
        (invocation.parentRunId === row.consumed_run ||
          await descendant(invocation.parentRunId))
      ) {
        // The owner supplies the frame; policy and input capture share this
        // transaction, so a refused child cannot leave a delegation receipt.
        await command.transaction.query(
          `INSERT INTO ${receipts}(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical',$1,'runtime','flow.descendant',$2::jsonb,'{}'::jsonb)`,
          [
            key(invocation.runId),
            JSON.stringify({
              root: row.consumed_run,
              operation: row.accepted_operation,
              parent: invocation.parentRunId,
              action: invocation.id,
            }),
          ],
        );
        return;
      }
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
  // Only the consumed continuation and its admitted descendants may exercise
  // internal capabilities. Every effect still passes the product's policy.
  if (
    invocation?.kind === "action" && invocation.runId && row.consumed_run &&
    ["collection", "session", "asset", "directory"].includes(intent.kind) &&
    (row.consumed_run === invocation.runId ||
      await descendant(invocation.runId, invocation.id))
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
