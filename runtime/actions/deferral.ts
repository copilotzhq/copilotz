import { durableActionValue } from "./value.ts";

const deferrals = new WeakSet<object>();
declare const actionDeferralBrand: unique symbol;

/** A handoff request, not an Action output. Only the runtime persists it. */
export type ActionDeferral = Readonly<{
  status: "deferred";
  work: unknown;
  readonly [actionDeferralBrand]: true;
}>;

/** Returned to a caller after handoff; the eventual value arrives in a terminal receipt. */
export type DeferredAction = Readonly<
  { status: "deferred"; actionRunId: string }
>;

export function deferredAction(actionRunId: string): DeferredAction {
  return { status: "deferred", actionRunId } as const;
}

/**
 * Return from execute to release the worker while the Action remains open.
 * Consumers of `<actionId>.deferred` start the work; resolve runs after it drains.
 */
export function deferAction(work: unknown): ActionDeferral {
  const value = {
    status: "deferred",
    work: durableActionValue(work),
  } as const;
  deferrals.add(value);
  return value as ActionDeferral;
}

export function isActionDeferral(value: unknown): value is ActionDeferral {
  return !!value && typeof value === "object" && deferrals.has(value);
}

/** Mechanical outcome of drained work; resolve interprets the domain result. */
export type ActionWorkOutcome = "completed" | "failed" | "cancelled";
export type ActionResolution = Readonly<
  {
    work: unknown;
    outcome: ActionWorkOutcome;
    error?: Readonly<{ name: string; message: string }>;
  }
>;
