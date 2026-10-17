/** Private historical evidence lookup. Call only after current fenced command
 * authorization. The returned data is not a grant or a replay-safety assertion. */
import type { SqlExecutor } from "../events/session.ts";
import { ownerClaimKey } from "../execution/owner-port.ts";
import {
  readExecutionClaim,
  type RegisteredExecutionContract,
} from "../execution/recovery.ts";
import { ownerPrincipalIdentity } from "./principal.ts";
import { ownerTableNames } from "./schema.ts";

export async function readOwnerOriginalExecutionContract(
  tx: SqlExecutor,
  scope: Readonly<{
    ownerId: string;
    schema: string;
    epoch: number;
    namespace: string;
    actionId: string;
    actionRunId: string;
    sourceEventId: string;
    deliveryId: string;
  }>,
): Promise<RegisteredExecutionContract | undefined> {
  const facts = { ...scope };
  if (
    !Number.isSafeInteger(facts.epoch) || facts.epoch < 1 ||
    Object.entries(facts).some(([key, value]) =>
      key !== "epoch" &&
      (typeof value !== "string" || !value.trim() || value.length > 1024)
    )
  ) {
    throw new TypeError("Invalid historical execution contract scope.");
  }
  // A retry can never write this marker. Two candidates are corruption, not an
  // invitation to choose the newer or more permissive one. LIMIT bounds retained
  // data only; a large-history query-plan/index proof remains separate.
  const rows = (await tx.query<{
    key: string;
    principal_kind: string;
    principal_id: string;
    intent: unknown;
    result: unknown;
  }>(
    `SELECT key,principal_kind,principal_id,
      CASE WHEN octet_length(intent::text)<=8192 THEN intent ELSE NULL END AS intent,
      CASE WHEN octet_length(result::text)<=32768 THEN result ELSE NULL END AS result
     FROM ${ownerTableNames(facts.schema).receipts}
     WHERE owner=$1 AND domain='incarnation' AND kind='execution.claim'
       AND result->>'deliveryId'=$2 AND result ? 'contract'
     ORDER BY key LIMIT 2`,
    [facts.ownerId, facts.deliveryId],
  )).rows;
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  try {
    const captured = readExecutionClaim(row.result);
    const contract = captured.contract;
    if (
      !contract || captured.recovery || contract.ownerId !== facts.ownerId ||
      contract.ownerEpoch > facts.epoch ||
      contract.namespace !== facts.namespace ||
      contract.actionId !== facts.actionId ||
      contract.actionRunId !== facts.actionRunId ||
      contract.sourceEventId !== facts.sourceEventId ||
      contract.deliveryId !== facts.deliveryId ||
      row.key !==
        ownerClaimKey(facts.ownerId, contract.assignmentId, contract.sessionId)
    ) return undefined;
    const principal = ownerPrincipalIdentity({
      kind: "worker",
      workerId: contract.workerId,
    });
    if (
      row.principal_kind !== principal.kind || row.principal_id !== principal.id
    ) return undefined;
    const intent = row.intent as Record<string, unknown> | null;
    if (
      !intent || typeof intent !== "object" || Array.isArray(intent) ||
      Object.keys(intent).sort().join(",") !== "assignmentId,sessionId" ||
      intent.assignmentId !== contract.assignmentId ||
      intent.sessionId !== contract.sessionId
    ) return undefined;
    return contract;
  } catch {
    // Malformed historical provenance never licenses an otherwise empty replay.
    return undefined;
  }
}
