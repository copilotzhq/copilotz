import { assertJsonValue } from "../json.ts";
import { durableActionMetadata, durableActionValue } from "./value.ts";

export type OperationStatus = "completed" | "failed" | "cancelled";
export type OperationOutcome = Readonly<
  {
    operationId: string;
    status: OperationStatus;
    error?: Readonly<{ name?: string; message?: string }>;
  }
>;
/** A durable invocation; the operation identity is stable across retries. */
export type OperationStart = Readonly<{
  action: string;
  input: unknown;
  operationId?: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;
export type AwaitOperationInput = Readonly<
  { start: OperationStart; handoff: unknown }
>;
declare const continuationBrand: unique symbol;
export type ActionContinuation =
  & AwaitOperationInput
  & Readonly<{ [continuationBrand]: true }>;
export type AwaitingAction = Readonly<
  { status: "awaiting"; actionRunId: string }
>;
const continuations = new WeakSet<object>();
export function awaitOperation(input: AwaitOperationInput): ActionContinuation {
  if (
    !input?.start || typeof input.start.action !== "string" ||
    !input.start.action.trim()
  ) {
    throw new TypeError("An awaited operation requires an Action invocation.");
  }
  assertJsonValue(input.handoff);
  if (
    input.start.operationId !== undefined &&
    (typeof input.start.operationId !== "string" ||
      !input.start.operationId.trim() ||
      input.start.operationId !== input.start.operationId.trim())
  ) {
    throw new TypeError(
      "An awaited operation identity must be non-empty text without surrounding whitespace.",
    );
  }
  if (input.start.metadata !== undefined) {
    durableActionMetadata(input.start.metadata);
  }
  const value = durableActionValue(input) as ActionContinuation;
  continuations.add(value);
  return value;
}
export function isActionContinuation(
  value: unknown,
): value is ActionContinuation {
  return !!value && typeof value === "object" && continuations.has(value);
}
export function awaitingAction(actionRunId: string): AwaitingAction {
  return { status: "awaiting", actionRunId };
}
