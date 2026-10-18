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
  /** Private cancellation is never exposed to plugin code. */
  commandSignal: AbortSignal;
  exposedSignal: AbortSignal;
}>;
export type RegisteredInvocationCalls = Readonly<{
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
