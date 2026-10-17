/** Safe immutable claim barrier data. It grants no authority by itself. */
import {
  copy,
  fail,
  OWNER_EFFECT_STEP_LIMIT,
  text,
} from "../owner/effects-client.ts";
import type { OwnerEffectStateReference } from "../owner/effects-client.ts";
import type { RegisteredExecutionReference } from "./registered-worker.ts";

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
}> {
  const data = copy(value) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return invalid();
  }
  const keys = Object.keys(data).sort().join(",");
  if (
    keys !== "deliveryId,dispatchAttemptId,executionId" &&
    keys !== "deliveryId,dispatchAttemptId,executionId,recovery"
  ) return invalid();
  text(data.executionId);
  text(data.deliveryId);
  text(data.dispatchAttemptId);
  return {
    reference: {
      executionId: data.executionId,
      deliveryId: data.deliveryId,
      dispatchAttemptId: data.dispatchAttemptId,
    },
    ...(Object.hasOwn(data, "recovery")
      ? { recovery: readExecutionRecovery(data.recovery) }
      : {}),
  };
}
