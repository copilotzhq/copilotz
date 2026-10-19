import type { AuthenticatedAuthority } from "./authority.ts";
import { authorizationRefused, type OwnerEvaluator } from "./evaluator.ts";
import {
  captureOperationConstraints,
  matchesOperationConstraints,
} from "./metadata.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import type { CommandContext } from "../engine/commands.ts";

/** Read and cancellation decisions use the operation row in the effect transaction. */
export async function authorizeOperation(
  evaluate: OwnerEvaluator | undefined,
  catalog: OperationCatalog,
  authority: AuthenticatedAuthority,
  id: string,
  operation: "read" | "cancel",
  command: CommandContext,
) {
  if (!evaluate) authorizationRefused();
  const decision = await evaluate(authority, {
    kind: "operation",
    resource: id,
    operation,
    input: { id },
  }, command);
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
