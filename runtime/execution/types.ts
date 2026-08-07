import type {
  InProcessWorker,
  InProcessWorkerOptions,
  WorkerHost,
  WorkerHostDispatchInput,
  WorkerHostWorkHandle,
} from "../../dependencies/oxian-host.ts";
import type {
  DurableEvent,
  EventDelivery,
  EventStore,
} from "../events/index.ts";
import type { PluginRegistry, ProcessorContext } from "../plugins/index.ts";

export const COPILOTZ_DELIVERY_WORKLOAD = "copilotz.delivery.v1";

export type DeliveryDispatchMetadata = Readonly<{
  schema: "copilotz.delivery.dispatch.v1";
  deliveryId: string;
  eventId: string;
  consumerId: string;
  namespace: string;
  dispatchAttemptId: string;
  idempotencyKey: string;
}>;

export type DeliveryDispatcher = Pick<WorkerHost, "dispatch">;

export type DeliveryWorkerHost = Pick<
  WorkerHost,
  "dispatch" | "attachInProcessWorker"
>;

export type DeliveryWorkload = InProcessWorkerOptions["workloads"][string];
export type ExecutionWorkInput = WorkerHostDispatchInput;
export type ExecutionWorkHandle = WorkerHostWorkHandle;
export type ExecutionWorkTarget = NonNullable<
  WorkerHostDispatchInput["target"]
>;

export type LocalWorkloadWorkerOptions = Readonly<{
  workerId?: string;
  capacity?: number;
}>;

export type DeliveryContextBase = Readonly<{
  event: DurableEvent;
  delivery: EventDelivery;
  signal: AbortSignal;
  idempotencyKey: string;
  dispatchAttemptId: string;
  createMutationIdentity: CreateDeliveryMutationIdentity;
}>;

export type DeliveryMutationIdentity = Readonly<{
  causationId: string;
  correlationId: string;
  deduplicationId: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type CreateDeliveryMutationIdentity = (
  operationKey: string,
  metadata?: Record<string, unknown>,
) => DeliveryMutationIdentity;

export type DeliveryContextFactory = (
  base: DeliveryContextBase,
) => ProcessorContext | void | Promise<ProcessorContext | void>;

export type DeliveryWorkloadScheduler = Readonly<{
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}>;

export type CreateDeliveryWorkloadOptions = Readonly<{
  store: EventStore;
  registry: PluginRegistry;
  createContext?: DeliveryContextFactory;
  leaseMs?: number;
  heartbeatMs?: number;
  scheduler?: DeliveryWorkloadScheduler;
}>;

export type DeliveryExecutionResult = Readonly<{
  event: DurableEvent;
  delivery: EventDelivery;
  operationStatus: string;
}>;

export type DeliveryExecutionHandle = Readonly<{
  deliveryId: string;
  eventId: string;
  operationId: string;
  streamId: string;
  started: Promise<void>;
  done: Promise<DeliveryExecutionResult>;
  cancel(reason?: string): Promise<void>;
}>;

export type DeliveryDispatchFailure = Readonly<{
  deliveryId: string;
  error: unknown;
}>;

export type DeliveryRecoveryDispatch = Readonly<{
  handles: readonly DeliveryExecutionHandle[];
  failures: readonly DeliveryDispatchFailure[];
}>;

export type CreateDeliveryExecutorOptions = Readonly<{
  store: EventStore;
  registry: PluginRegistry;
  createContext?: DeliveryContextFactory;
  /** Dispatch to an externally hosted workload. The executor never closes it. */
  dispatcher?: DeliveryDispatcher;
  /** Attach one Copilotz worker to an application-owned embedded host. */
  host?: DeliveryWorkerHost;
  target?: Readonly<{ workerId: string }>;
  workload?: string;
  /** Additional application/runtime workloads hosted beside deliveries. */
  workloads?: Readonly<Record<string, DeliveryWorkload>>;
  /** Additional workloads that should not consume durable-delivery slots. */
  localWorkloadWorkers?: Readonly<
    Record<string, LocalWorkloadWorkerOptions>
  >;
  /** Per-workload routing used with an injected dispatcher/hypervisor. */
  workloadTargets?: Readonly<Record<string, ExecutionWorkTarget>>;
  workerId?: string;
  capacity?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  scheduler?: DeliveryWorkloadScheduler;
  createDispatchAttemptId?: () => string;
}>;

export type DeliveryExecutorOwnership =
  | "private_host"
  | "shared_host"
  | "injected_dispatcher";

export type DeliveryExecutor = Readonly<{
  ownership: DeliveryExecutorOwnership;
  workload: string;
  /** Queues post-commit placement without waiting for a worker slot. */
  scheduleDelivery(delivery: string | EventDelivery): void;
  /** Dispatches a non-delivery workload through the same owned target. */
  dispatchWork(input: ExecutionWorkInput): Promise<ExecutionWorkHandle>;
  dispatchDelivery(
    delivery: string | EventDelivery,
  ): Promise<DeliveryExecutionHandle>;
  dispatchRecoverable(options?: {
    namespace?: string;
    consumerIds?: readonly string[];
    limit?: number;
  }): Promise<DeliveryRecoveryDispatch>;
  shutdown(reason?: string): Promise<void>;
}>;

export type DeliveryExecutorInternals = Readonly<{
  dispatcher: DeliveryDispatcher;
  attachedWorkers?: readonly InProcessWorker[];
  createHandle(
    delivery: EventDelivery,
    event: DurableEvent,
    attemptId: string,
    work: WorkerHostWorkHandle,
  ): DeliveryExecutionHandle;
}>;
