/** Invocation-bound, SQL-free external-effect data capability. */
import { assertJsonValue } from "../json.ts";
import type {
  ActionEffectEvidence,
  ActionEffectOptions,
  ActionEffectOutcome,
  ActionEffectState,
} from "./types.ts";

export const EFFECT_STEP_LIMIT = 100;
/** Reserved owner-only outcome discriminator; never accepted from a caller. */
export const PROTECTED_EFFECT_OUTPUT_SCHEMA =
  "copilotz.action.effect-output.v1" as const;
export function assertPlainEffectOutcome(value: ActionEffectOutcome): void {
  if (!value || typeof value !== "object") return;
  if (
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schema === PROTECTED_EFFECT_OUTPUT_SCHEMA
  ) {
    fail(
      "effect_outcome_invalid",
      "An owner-only effect outcome cannot be supplied by a caller.",
    );
  }
  for (const child of Object.values(value)) assertPlainEffectOutcome(child);
}
export type EffectReference = Readonly<{
  namespace: string;
  actionRunId: string;
  step: string;
}>;
export type EffectInventoryEntry = Readonly<{
  /** Present only for an unresolved descendant, which cannot use this Action's reconciler. */
  actionRunId?: string;
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
  confirm(
    step: string,
    outcome: ActionEffectOutcome,
    options?: ActionEffectOptions,
  ): Promise<void>;
  confirmOutput(
    step: string,
    output: ActionEffectOutcome,
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
export function copy<T>(value: T): T {
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
