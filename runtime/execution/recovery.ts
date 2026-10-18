/** Safe immutable claim barrier data. It grants no authority by itself. */
import {
  copy,
  fail,
  OWNER_EFFECT_STEP_LIMIT,
  text,
} from "../owner/effects-client.ts";
import type { OwnerEffectStateReference } from "../owner/effects-client.ts";
import type { RegisteredExecutionReference } from "./registered-worker.ts";

/** Historical admission evidence, never a worker permission or replay key. */
export const OWNER_EFFECT_EXECUTION_CONTRACT = "copilotz.owner-effects.v1";
export type RegisteredExecutionContract = Readonly<{
  protocol: typeof OWNER_EFFECT_EXECUTION_CONTRACT;
  attempt: 1;
  ownerEpoch: number;
  ownerId: string;
  namespace: string;
  actionId: string;
  actionRunId: string;
  sourceEventId: string;
  deliveryId: string;
  workerId: string;
  assignmentId: string;
  sessionId: string;
  dispatchAttemptId: string;
}>;
export function readExecutionContract(
  value: unknown,
): RegisteredExecutionContract {
  const data = copy(value) as Record<string, unknown>;
  const identifiers = [
    "ownerId",
    "namespace",
    "actionId",
    "actionRunId",
    "sourceEventId",
    "deliveryId",
    "workerId",
    "assignmentId",
    "sessionId",
    "dispatchAttemptId",
  ] as const;
  if (
    !data || typeof data !== "object" || Array.isArray(data) ||
    Object.keys(data).sort().join(",") !==
      [...identifiers, "protocol", "attempt", "ownerEpoch"].sort().join(",") ||
    data.protocol !== OWNER_EFFECT_EXECUTION_CONTRACT || data.attempt !== 1 ||
    !Number.isSafeInteger(data.ownerEpoch) || Number(data.ownerEpoch) < 1
  ) return invalid();
  for (const key of identifiers) text(data[key]);
  return data as RegisteredExecutionContract;
}

export type RegisteredExecutionRecovery = Readonly<{
  status: "eligible" | "blocked";
  effects: readonly OwnerEffectStateReference[];
}>;
function invalid(): never {
  fail(
    "registered_worker_recovery_invalid",
    "Invalid execution recovery barrier.",
  );
}
export function readExecutionRecovery(
  value: unknown,
): RegisteredExecutionRecovery {
  const data = copy(value) as RegisteredExecutionRecovery;
  if (
    !data || typeof data !== "object" ||
    Object.keys(data).sort().join(",") !== "effects,status" ||
    !["eligible", "blocked"].includes(data.status) ||
    !Array.isArray(data.effects) ||
    data.effects.length > OWNER_EFFECT_STEP_LIMIT
  ) return invalid();
  const seen = new Set<string>();
  for (const effect of data.effects) {
    if (
      !effect || typeof effect !== "object" ||
      Object.keys(effect).sort().join(",") !== "status,step" ||
      !["begun", "confirmed", "not_started"].includes(effect.status)
    ) return invalid();
    text(effect.step);
    if (seen.has(effect.step)) return invalid();
    seen.add(effect.step);
  }
  return data;
}
export function readExecutionClaim(value: unknown): Readonly<{
  reference: RegisteredExecutionReference;
  recovery?: RegisteredExecutionRecovery;
  contract?: RegisteredExecutionContract;
}> {
  const data = copy(value) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return invalid();
  }
  const keys = Object.keys(data).sort().join(",");
  if (
    keys !== "deliveryId,dispatchAttemptId,executionId" &&
    keys !== "deliveryId,dispatchAttemptId,executionId,recovery" &&
    keys !== "contract,deliveryId,dispatchAttemptId,executionId"
  ) return invalid();
  text(data.executionId);
  text(data.deliveryId);
  text(data.dispatchAttemptId);
  const contract = Object.hasOwn(data, "contract")
    ? readExecutionContract(data.contract)
    : undefined;
  if (
    contract &&
    (contract.actionRunId !== data.executionId ||
      contract.deliveryId !== data.deliveryId ||
      contract.dispatchAttemptId !== data.dispatchAttemptId)
  ) return invalid();
  return {
    reference: {
      executionId: data.executionId,
      deliveryId: data.deliveryId,
      dispatchAttemptId: data.dispatchAttemptId,
    },
    ...(contract ? { contract } : {}),
    ...(Object.hasOwn(data, "recovery")
      ? { recovery: readExecutionRecovery(data.recovery) }
      : {}),
  };
}
