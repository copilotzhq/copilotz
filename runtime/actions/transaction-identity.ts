import type { ActionTransactionOptions, RuntimeIdentity } from "./types.ts";

/**
 * Carries causal authority into an Action-owned graph transaction. The
 * transaction keeps its own operation-derived deduplication identity unless
 * the Action explicitly supplies one for that transaction.
 */
export function actionTransactionIdentity(
  action: RuntimeIdentity | undefined,
  transaction: ActionTransactionOptions["identity"],
): ActionTransactionOptions["identity"] {
  const causationId = transaction?.causationId ?? action?.causationId;
  const correlationId = transaction?.correlationId ?? action?.correlationId;
  const settlementScopeId = transaction?.settlementScopeId ??
    action?.settlementScopeId;
  const actionScopeId = transaction?.actionScopeId ?? action?.actionScopeId;
  const deduplicationId = transaction?.deduplicationId;
  const metadata = transaction?.metadata;
  if (
    !causationId && !correlationId && !settlementScopeId &&
    !deduplicationId && !metadata && !actionScopeId
  ) return undefined;
  return ({
    ...(causationId ? { causationId } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(deduplicationId ? { deduplicationId } : {}),
    ...(settlementScopeId ? { settlementScopeId } : {}),
    ...(actionScopeId ? { actionScopeId } : {}),
    ...(metadata ? { metadata } : {}),
  } as const);
}
