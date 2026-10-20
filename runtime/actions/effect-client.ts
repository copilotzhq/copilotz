/** Invocation-bound, SQL-free external-effect data capability. */
import { assertJsonValue } from "../json.ts";
import type {
  ActionEffectEvidence,
  ActionEffectOptions,
  ActionEffectOutcome,
  ActionEffectState,
} from "./types.ts";

export type EffectReference = Readonly<{
  namespace: string;
  actionRunId: string;
  step: string;
}>;
export type EffectInventoryEntry = Readonly<{
  step: string;
  status: "begun" | "confirmed" | "not_started";
}>;
export type ActionEffectClient = Readonly<{
  begin(step: string, options?: ActionEffectOptions): Promise<
    Exclude<ActionEffectState, { status: "none" }> | { status: "proceed" }
  >;
  inspect(
    step: string,
    options?: ActionEffectOptions,
  ): Promise<ActionEffectState>;
  /** Capture caller-owned data synchronously, before asynchronous admission. */
  confirm(
    step: string,
    outcome: ActionEffectOutcome,
    options?: ActionEffectOptions,
  ): Promise<void>;
  notStarted(
    step: string,
    evidence: ActionEffectEvidence,
    options?: ActionEffectOptions,
  ): Promise<void>;
  inventory(
    options?: ActionEffectOptions,
  ): Promise<readonly EffectInventoryEntry[]>;
}>;
type Confirm = ActionEffectClient["confirm"];
const capturedConfirmations = new WeakMap<Confirm, Confirm>();
/** Private owned-value port. Public callers still synchronously capture their data. */
export function bindCapturedConfirmation(captured: Confirm): Confirm {
  const confirm: Confirm = (step, value, options) =>
    captured(step, copy(value), options);
  capturedConfirmations.set(confirm, captured);
  return confirm;
}
/** Preserve admission/secret guards when binding the owned-value port. */
export function wrapEffectConfirmation(
  confirm: Confirm,
  wrap: (confirm: Confirm) => Confirm,
): Confirm {
  const bound = wrap(confirm);
  const captured = capturedConfirmations.get(confirm);
  if (captured) capturedConfirmations.set(bound, wrap(captured));
  return bound;
}
export function confirmCapturedEffect(
  client: Pick<ActionEffectClient, "confirm">,
  ...args: Parameters<Confirm>
): Promise<void> {
  const captured = capturedConfirmations.get(client.confirm);
  return captured ? captured(...args) : client.confirm(...args);
}
export function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), {
    name: "ActionEffectError",
    code,
    retryable: false,
  });
}
export function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) {
    fail(
      "effect_data_invalid",
      "Effect identity must be a bounded nonempty string.",
    );
  }
}
export function validateEffectData(value: unknown): void {
  assertJsonValue(value, {
    label: "Effect data",
    maxDepth: 64,
    maxNodes: 100_000,
    rejectNegativeZero: true,
  });
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024
  ) {
    fail("effect_data_invalid", "Effect data exceeds its byte limit.");
  }
}
export function copy<T>(value: T): T {
  validateEffectData(value);
  return structuredClone(value);
}
export function evidence(value: ActionEffectEvidence): ActionEffectEvidence {
  const result = copy(value);
  if (
    !result || typeof result !== "object" ||
    Object.keys(result).sort().join(",") !== "reference,source"
  ) {
    fail("effect_data_invalid", "Invalid effect evidence.");
  }
  text(result.source);
  text(result.reference);
  return result;
}
/** Receipt identity is logical, separate from the current attempt's authority. */
export function effectKey(ref: EffectReference, operation: string): string {
  text(ref.namespace);
  text(ref.actionRunId);
  text(ref.step);
  return JSON.stringify([
    "effect",
    ref.namespace,
    ref.actionRunId,
    ref.step,
    operation,
  ]);
}
