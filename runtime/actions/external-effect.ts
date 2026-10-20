/** Run one JSON-result external call only after a fresh durable dispatch permit. */
import type { ActionContext, ActionEffectOutcome } from "./types.ts";
import { confirmCapturedEffect, copy, fail } from "./effect-client.ts";

export async function externalEffect<T>(
  context: Pick<ActionContext, "effect" | "signal">,
  step: string,
  dispatch: () => T | Promise<T>,
): Promise<T> {
  if (context.signal.aborted) {
    const reason = context.signal.reason;
    throw reason instanceof DOMException && reason.name === "AbortError"
      ? reason
      : new DOMException(
        reason instanceof Error ? reason.message : "Action cancelled",
        "AbortError",
      );
  }
  const permission = await context.effect.begin(step);
  if (permission.status === "replay") return permission.outcome as T;
  if (permission.status !== "proceed") {
    return fail(
      "effect_indeterminate",
      "A closed effect step cannot dispatch again.",
    );
  }
  if (context.signal.aborted) {
    const reason = context.signal.reason;
    throw reason instanceof DOMException && reason.name === "AbortError"
      ? reason
      : new DOMException(
        reason instanceof Error ? reason.message : "Action cancelled",
        "AbortError",
      );
  }
  const result = copy(await dispatch());
  await confirmCapturedEffect(
    context.effect,
    step,
    result as ActionEffectOutcome,
  );
  return result;
}
