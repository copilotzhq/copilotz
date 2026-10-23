import { assertFlowOperation } from "./flow.ts";
import type { AuthenticatedAuthority } from "./authority.ts";
import { authorizationRefused, type OwnerEvaluator } from "./evaluator.ts";
import {
  captureOperationConstraints,
  matchesOperationConstraints,
} from "./metadata.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import type { CommandContext } from "../engine/commands.ts";

/** A proof is a receipt capability for this completed self-revocation only. */
export async function logoutReceipt(
  catalog: OperationCatalog,
  authority: AuthenticatedAuthority,
  id: string,
  command: CommandContext,
) {
  const proof = authority.scope.bindings["@credential-proof"];
  if (
    !proof || authority.flow || authority.validity.kind === "credential" &&
      Date.parse(authority.validity.expiresAt) <=
        Date.parse(command.commandTime)
  ) return;
  const schema = authority.scope.databaseSchema.replaceAll('"', '""');
  const effect = await command.transaction.query(
    `SELECT 1 FROM "${schema}".authorization_effects AS revoked
     WHERE namespace=$1 AND tenant=$2 AND operation_id=$3 AND method='session.revoke'
       AND claims->>'type'='clear' AND (claims->>'expiresAt')::timestamptz>$5::timestamptz
       AND initiator::jsonb->>'proof'=$4
       AND initiator::jsonb->'basis'->>'kind'='session'
       AND initiator::jsonb->'basis'->>'id'=claims->>'id'
       AND ((initiator::jsonb->'basis'->>'id'=$6 AND initiator::jsonb->'principal'->>'id'=$7) OR NOT EXISTS (SELECT 1 FROM "${schema}".authorization_effects AS issued WHERE issued.namespace=revoked.namespace AND issued.tenant=revoked.tenant AND issued.operation_id=revoked.operation_id AND issued.method IN ('session.create','flow.start'))) LIMIT 1`,
    [
      authority.scope.namespace,
      authority.scope.tenant,
      id,
      proof,
      command.commandTime,
      authority.authorityBasis.kind === "session"
        ? authority.authorityBasis.id
        : "",
      authority.principal.id,
    ],
  );
  if (!effect.rows.length) return;
  const result = await catalog.get(
    authority.scope.namespace,
    id,
    command.transaction,
  );
  return result ?? undefined;
}

/** Read and cancellation decisions use the operation row in the effect transaction. */
export async function authorizeOperation(
  evaluate: OwnerEvaluator | undefined,
  catalog: OperationCatalog,
  authority: AuthenticatedAuthority,
  id: string,
  operation: "read" | "cancel",
  command: CommandContext,
) {
  if (operation === "read") {
    const receipt = await logoutReceipt(catalog, authority, id, command);
    if (receipt?.state === "completed") return receipt;
  }
  if (!evaluate) authorizationRefused();
  const decision = await evaluate(authority, {
    kind: "operation",
    resource: id,
    operation,
    input: { id },
  }, command);
  await assertFlowOperation(authority, id, command.transaction);
  const result = await catalog.get(
    authority.scope.namespace,
    id,
    command.transaction,
  );
  const constraint = decision.constraints.operations;
  if (
    !result || !constraint ||
    !matchesOperationConstraints(
      result.metadata?.operationMetadata ?? {},
      captureOperationConstraints(constraint),
    )
  ) {
    throw Object.assign(new Error("Operation was not found."), {
      code: "operation_not_found",
      status: 404,
    });
  }
  return result;
}
