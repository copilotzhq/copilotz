/** Pure live-attempt orchestration. Durable state and authorization belong to
 * the owner client, never this map. Only reconciliation, not begin, coalesces. */
import type { createOwnerEffectClient } from "../owner/effects-client.ts";
import { copy, fail, text } from "../owner/effects-client.ts";
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
  client: ReturnType<typeof createOwnerEffectClient>;
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
  const reconciliations = new Map<string, Promise<void>>();
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
    ancestors: ReadonlySet<string>,
    onRecursive: () => void,
  ): Promise<
    Exclude<ActionEffectBegin, { status: "proceed" | "not_started" }> | {
      status: "not_started";
    }
  > => {
    if (!reconcile) return indeterminate();
    let pending = reconciliations.get(step);
    // Two concurrent hooks must not wait on each other's recovery. Only
    // ordinary execution callers may join an existing reconciliation.
    if (pending && ancestors.size) {
      onRecursive();
      return indeterminate();
    }
    if (!pending) {
      // Publish before invoking any application callback, including sync hooks.
      pending = Promise.resolve().then(async () => {
        check(active.signal);
        const current = await options.client.inspect(step, active);
        check(active.signal);
        if (
          current.status === "replay" || current.status === "not_started"
        ) {
          return;
        }
        if (current.status !== "indeterminate") return indeterminate();
        let recursive = false;
        const effect = create(new Set([...ancestors, step]), () => {
          recursive = true;
          onRecursive();
        });
        const context = { ...options.context(), effect };
        let result: ActionReconcileResult;
        try {
          result = copy(await reconcile(step, context));
        } catch (error) {
          // Transport ambiguity from nested owner calls must stay unknown.
          if (unknownOutcome(error)) throw error;
          return indeterminate();
        }
        check(active.signal);
        if (recursive || !result || typeof result !== "object") {
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
      });
      reconciliations.set(step, pending);
    }
    await pending;
    check(active.signal);
    // No cached outcome hydration: every recipient uses current authorization.
    const current = await options.client.inspect(step, active);
    check(active.signal);
    if (current.status === "replay" || current.status === "not_started") {
      return current;
    }
    return indeterminate();
  };
  const create = (
    ancestors: ReadonlySet<string>,
    onRecursive: () => void,
  ): ActionEffect => ({
    begin: (step, callOptions) =>
      options.track(async (): Promise<ActionEffectBegin> => {
        const active = scope(step, callOptions);
        if (ancestors.has(step)) {
          onRecursive();
          return indeterminate();
        }
        // Never coalesce a fresh begin: at most one caller may receive proceed.
        const begun = await options.client.begin(step, active);
        check(active.signal);
        if (begun.status !== "indeterminate") return begun;
        return await reconcileStep(step, active, ancestors, onRecursive);
      }),
    inspect: (step, callOptions) =>
      options.track(async () => {
        const active = scope(step, callOptions);
        const state = await options.client.inspect(step, active);
        check(active.signal);
        return state;
      }),
    confirm: (step, outcome, callOptions) =>
      options.track(async () => {
        const active = scope(step, callOptions);
        await options.client.confirm(step, outcome, active);
        check(active.signal);
      }),
    notStarted: (step, evidence, callOptions) =>
      options.track(async () => {
        const active = scope(step, callOptions);
        await options.client.notStarted(step, evidence, active);
        check(active.signal);
      }),
  });
  return {
    effect: create(new Set(), () => {}),
    recover: (step) =>
      options.track(async () => {
        const active = scope(step);
        const current = await options.client.inspect(step, active);
        check(active.signal);
        if (
          current.status === "replay" || current.status === "not_started"
        ) return;
        if (current.status !== "indeterminate") return indeterminate();
        await reconcileStep(step, active, new Set(), () => {});
      }),
  };
}

export function createActionEffectCapability(
  options: ActionEffectControllerOptions,
): ActionEffect {
  return createActionEffectController(options).effect;
}
