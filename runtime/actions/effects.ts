/** Pure live-attempt orchestration. Durable state and authorization belong to
 * the owner client. Concurrent or recursive reconciliation fails closed. */
import type { ActionEffectClient } from "./effect-client.ts";
import {
  bindCapturedConfirmation,
  confirmCapturedEffect,
  fail,
  text,
} from "./effect-client.ts";
import type {
  ActionContext,
  ActionEffect,
  ActionEffectBegin,
  ActionEffectOptions,
  ActionReconcileResult,
} from "./types.ts";

function unknownOutcome(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return value.indeterminate === true || value.outcome === "unknown" ||
    value.execution === "indeterminate" ||
    ["owner_commit_unknown", "persistence_indeterminate"].includes(
      String(value.code),
    );
}

type ActionEffectControllerOptions = Readonly<{
  client: ActionEffectClient;
  signal: AbortSignal;
  /** Private invocation/lease check; not derived from the exposed ctx.signal. */
  check(): void;
  context(): ActionContext;
  /** Register every call in the host's private pending/uncertainty drain. */
  track<T>(start: () => Promise<T>): Promise<T>;
  reconcile?(
    step: string,
    context: ActionContext,
  ): ActionReconcileResult | Promise<ActionReconcileResult>;
}>;

export function createActionEffectController(
  options: ActionEffectControllerOptions,
): Readonly<{
  effect: ActionEffect;
  recover(step: string): Promise<void>;
}> {
  // Author code must never receive these private controller options as `this`.
  const reconcile = options.reconcile;
  let reconciling = false;
  let refused = false;
  let uncertain: unknown;
  const check = (signal: AbortSignal) => {
    options.check();
    signal.throwIfAborted();
  };
  const scope = (step: string, callOptions?: ActionEffectOptions) => {
    text(step);
    const signal = callOptions?.signal
      ? AbortSignal.any([options.signal, callOptions.signal])
      : options.signal;
    check(signal);
    return { signal };
  };
  const indeterminate = (): never =>
    fail("effect_indeterminate", "External effect requires reconciliation.");
  const reconcileStep = async (
    step: string,
    active: { signal: AbortSignal },
  ): Promise<Exclude<ActionEffectBegin, { status: "proceed" }>> => {
    if (uncertain) throw uncertain;
    if (!reconcile || reconciling) {
      refused = true;
      return indeterminate();
    }
    reconciling = true;
    try {
      let result: ActionReconcileResult;
      try {
        result = await reconcile(step, options.context());
      } catch (error) {
        if (unknownOutcome(error)) throw error;
        return indeterminate();
      }
      check(active.signal);
      if (refused || !result || typeof result !== "object") {
        return indeterminate();
      }
      const keys = Object.keys(result).sort().join(",");
      if (result.status === "confirmed" && keys === "outcome,status") {
        await options.client.confirm(step, result.outcome, active);
      } else if (
        result.status === "not_started" && keys === "evidence,status"
      ) {
        await options.client.notStarted(step, result.evidence, active);
      } else return indeterminate();
      check(active.signal);
      const current = await options.client.inspect(step, active);
      check(active.signal);
      if (current.status === "replay" || current.status === "not_started") {
        return current;
      }
      return indeterminate();
    } catch (error) {
      if (unknownOutcome(error)) uncertain = error;
      throw error;
    } finally {
      reconciling = false;
    }
  };
  const effect: ActionEffect = {
    begin: (step, callOptions) =>
      options.track(async (): Promise<ActionEffectBegin> => {
        const active = scope(step, callOptions);
        if (reconciling) {
          refused = true;
          return indeterminate();
        }
        // Never coalesce a fresh begin: at most one caller may receive proceed.
        const begun = await options.client.begin(step, active);
        check(active.signal);
        if (begun.status !== "indeterminate") return begun;
        return await reconcileStep(step, active);
      }),
    inspect: (step, callOptions) =>
      options.track(async () => {
        const active = scope(step, callOptions);
        const state = await options.client.inspect(step, active);
        check(active.signal);
        return state;
      }),
    confirm: bindCapturedConfirmation((step, outcome, callOptions) =>
      options.track(async () => {
        const active = scope(step, callOptions);
        await confirmCapturedEffect(options.client, step, outcome, active);
        check(active.signal);
      })
    ),
    notStarted: (step, evidence, callOptions) =>
      options.track(async () => {
        const active = scope(step, callOptions);
        await options.client.notStarted(step, evidence, active);
        check(active.signal);
      }),
  };
  return {
    effect,
    recover: (step) =>
      options.track(async () => {
        const active = scope(step);
        const current = await options.client.inspect(step, active);
        check(active.signal);
        if (
          current.status === "replay" || current.status === "not_started"
        ) return;
        if (current.status !== "indeterminate") return indeterminate();
        await reconcileStep(step, active);
      }),
  };
}

export function createActionEffectCapability(
  options: ActionEffectControllerOptions,
): ActionEffect {
  return createActionEffectController(options).effect;
}
