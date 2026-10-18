import type { RegisteredStreamPort } from "./stream-capability.ts";
import type { OwnerSnapshotPort } from "../owner/connection.ts";
/** Internal placement-neutral invocation data and trusted, prebound calls.
 * A projection is ordinary data, never authority. The placement driver owns
 * admission, private lifetime, cancellation, settlement and receipt recovery. */
import type {
  ActionInvocationMetadata,
  RuntimeContextNamespaces,
  RuntimeIdentity,
} from "../actions/types.ts";
import type {
  OwnerCommand,
  OwnerCommandExecuteOptions,
  OwnerCommandOutcome,
  OwnerJson,
} from "../owner/boundary.ts";
import type { ProcessorEvent } from "../plugins/processor.ts";
import type { RegisteredExecutionRecovery } from "./recovery.ts";
import type { OwnerCollectionReadRequest } from "./collection-read-call.ts";

export type RegisteredExecutionCompletion =
  | Readonly<{ status: "completed"; output: OwnerJson }>
  | Readonly<{ status: "failed" | "cancelled"; code: string }>;
export type RegisteredProcessorCompletion =
  | Readonly<{ status: "succeeded" }>
  | Readonly<{ status: "cancelled"; code: "processor_cancelled" }>
  | Readonly<{ status: "failed"; code: string; retryable: boolean }>;
export type RegisteredActionInvocation = Readonly<{
  actionId: string;
  recovery?: RegisteredExecutionRecovery;
  input: OwnerJson;
  namespace: string;
  databaseSchema: string;
  ownerId: string;
  invocation: Readonly<{
    actionRunId: string;
    rootKey: string;
    operationKey: string;
    parentActionRunId?: string;
    metadata: ActionInvocationMetadata;
    identity?: RuntimeIdentity;
  }>;
}>;
export type RegisteredProcessorInvocation = Readonly<{
  processorId: string;
  ownerId: string;
  namespace: string;
  databaseSchema: string;
  /** Original durable delivery identity, independent of placement or attempt. */
  deliveryId: string;
  event: ProcessorEvent;
  attempts: number;
  maxAttempts: number;
  operationKey: string;
  identity: RuntimeIdentity;
}>;
export type RegisteredContextCapabilities = Readonly<{
  resources: RuntimeContextNamespaces;
  adapters: RuntimeContextNamespaces;
}>;
/** Private callbacks are already bound by the placement driver. */
export type RegisteredInvocationLifetime = Readonly<{
  check(): void;
  isCancelled(): boolean;
  /** Driver-owned fatal invocation failure; content is unavailable without it. */
  fail?(error: unknown): void;
  /** Private cancellation is never exposed to plugin code. */
  commandSignal: AbortSignal;
  exposedSignal: AbortSignal;
}>;
export type RegisteredInvocationCalls = Readonly<{
  streams?: RegisteredStreamPort;
  snapshots?: OwnerSnapshotPort;
  readCollection?(
    request: OwnerCollectionReadRequest,
    options: OwnerCommandExecuteOptions,
  ): Promise<OwnerJson>;
  execute(
    command: OwnerCommand,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerCommandOutcome>;
  /** Optional named preparation, bound to the same real parent. */
  prepareAction?(
    input: Readonly<
      {
        actionAlias: string;
        preparation: string;
        recordId: string;
        mode: string;
        operationKey: string;
      }
    >,
    options: OwnerCommandExecuteOptions,
  ): Promise<OwnerJson>;
  /** Already bound to the real parent. No placement reference crosses here. */
  invokeAction?(
    input: Readonly<{
      actionAlias: string;
      input: OwnerJson;
      operationKey: string;
    }>,
    options: OwnerCommandExecuteOptions,
  ): Promise<OwnerJson>;
}>;

/** Inspect a known error tag without executing arbitrary accessors/coercions. */
export function registeredInvocationErrorCode(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Shared uncertainty classification; effects retain their separate reconciliation rules. */
export function isRegisteredInvocationUnknown(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const fields: Record<string, unknown> = {};
  for (const key of ["code", "indeterminate", "outcome", "execution"]) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(error, key);
    } catch {
      return true;
    }
    // Never invoke user-controlled getters/coercions while deciding whether
    // cleanup is safe. Uninspectable errors are conservatively uncertain.
    if (descriptor && !("value" in descriptor)) return true;
    fields[key] = descriptor?.value;
  }
  return fields.indeterminate === true || fields.outcome === "unknown" ||
    fields.execution === "indeterminate" ||
    (typeof fields.code === "string" &&
      ["owner_commit_unknown", "persistence_indeterminate"].includes(
        fields.code,
      ));
}

/** Fatal work closes invocation admission, never business cancellation or settlement authority. */
export function createRegisteredInvocationFailure(
  command: AbortController,
  exposed: AbortController,
  onUnknown?: (error: unknown) => unknown,
) {
  let failed = false, uncertain = false, notified = false;
  let reason: unknown;
  return Object.freeze({
    get failed() {
      return failed;
    },
    check() {
      if (failed) throw reason;
    },
    fail(error: unknown) {
      // Publish closed admission before inspecting an arbitrary error or
      // notifying a callback that can reenter the driver.
      if (!failed) {
        failed = true;
        reason = error;
      }
      if (isRegisteredInvocationUnknown(error) && !uncertain) {
        uncertain = true;
        reason = error;
      }
      if (uncertain && !notified && onUnknown) {
        notified = true;
        const original = reason;
        try {
          const observed = onUnknown(original);
          if (reason === original && isRegisteredInvocationUnknown(observed)) {
            reason = observed;
          }
        } catch { /* Notification cannot erase the original uncertainty. */ }
      }
      command.abort(reason);
      exposed.abort(reason);
    },
  });
}
