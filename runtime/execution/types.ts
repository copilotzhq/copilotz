import type { Hypervisor } from "../../dependencies/oxian-hypervisor.ts";
import type {
  Dispatcher,
  WorkHandle,
  WorkInput,
} from "../../dependencies/oxian-work.ts";
import type {
  Worker,
  WorkerOptions,
  WorkerWorkHandler,
} from "../../dependencies/oxian-worker.ts";
import type {
  CopilotzEvent,
  DurableEvent,
  EventDelivery,
  EventStore,
} from "../events/index.ts";
import type { PluginRegistry, ProcessorContext } from "../plugins/index.ts";

export const COPILOTZ_DELIVERY_WORKLOAD = "copilotz.delivery.v1";

export type DeliveryDispatchMetadata = Readonly<{
  schema: "copilotz.delivery.dispatch.v1";
  databaseSchema: string;
  deliveryId: string;
  eventId: string;
  consumerId: string;
  namespace: string;
  dispatchAttemptId: string;
  idempotencyKey: string;
}>;

export type DeliveryDispatcher = Dispatcher;
export type DeliveryHypervisor = Hypervisor;
export type DeliveryInProcessTransport = Extract<
  WorkerOptions["transport"],
  { type: "in-process" }
>;
export type DeliveryWorkload = WorkerWorkHandler;
export type ExecutionWorkInput = WorkInput;
export type ExecutionWorkHandle = WorkHandle;
export type ExecutionWorkTarget = NonNullable<
  WorkInput["target"]
>;

export type LocalWorkloadWorkerOptions = Readonly<{
  workerId?: string;
  capacity?: number;
}>;

export type DeliveryContextBase = Readonly<{
  databaseSchema: string;
  event: DurableEvent;
  delivery: EventDelivery;
  settlementScopeId: string;
  signal: AbortSignal;
  idempotencyKey: string;
  dispatchAttemptId: string;
  createMutationIdentity: CreateDeliveryMutationIdentity;
}>;

export type DeliveryMutationIdentity = Readonly<{
  causationId: string;
  correlationId: string;
  deduplicationId: string;
  settlementScopeId: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type CreateDeliveryMutationIdentity = (
  operationKey: string,
  metadata?: Record<string, unknown>,
) => DeliveryMutationIdentity;

export type DeliveryContextFactory = (
  base: DeliveryContextBase,
) => ProcessorContext | Promise<ProcessorContext>;

export type DeliveryWorkloadScheduler = Readonly<{
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}>;

export type CreateDeliveryWorkloadOptions = Readonly<{
  store?: EventStore;
  resolveStore?: (databaseSchema: string) => EventStore | Promise<EventStore>;
  registry: PluginRegistry;
  createContext: DeliveryContextFactory;
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
  store?: EventStore;
  resolveStore?: (databaseSchema: string) => EventStore | Promise<EventStore>;
  defaultDatabaseSchema?: string;
  registry: PluginRegistry;
  createContext: DeliveryContextFactory;
  /** Dispatch to an externally hosted workload. The executor never closes it. */
  dispatcher?: DeliveryDispatcher;
  /** Bind Copilotz Workers to an application-owned in-process Hypervisor. */
  hypervisor?: DeliveryHypervisor;
  /**
   * In-process event-fabric rendezvous shared by Copilotz Workers and their
   * Hypervisor. Required with an injected Hypervisor; optional for a private
   * Hypervisor, which otherwise receives a unique topic.
   */
  transport?: DeliveryInProcessTransport;
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
  /** Relays semantic events framed by a remote Copilotz Worker. */
  onOutputEvent?: (
    event: CopilotzEvent,
    context: Readonly<{
      databaseSchema: string;
      settlementScopeId?: string;
    }>,
  ) => void | Promise<void>;
}>;

export type DeliveryExecutorOwnership =
  | "private_hypervisor"
  | "shared_hypervisor"
  | "injected_dispatcher";

export type DeliveryExecutor = Readonly<{
  ownership: DeliveryExecutorOwnership;
  workload: string;
  /** Worker-local handlers for embedded or outbound Oxian registration. */
  workloads: Readonly<Record<string, DeliveryWorkload>>;
  /** Queues post-commit placement without waiting for a worker slot. */
  scheduleDelivery(delivery: string | EventDelivery): void;
  /** Dispatches a non-delivery workload through the same owned target. */
  dispatchWork(input: ExecutionWorkInput): Promise<ExecutionWorkHandle>;
  dispatchDelivery(
    delivery: string | EventDelivery,
    options?: { databaseSchema?: string },
  ): Promise<DeliveryExecutionHandle>;
  dispatchRecoverable(options?: {
    databaseSchema?: string;
    namespace?: string;
    consumerIds?: readonly string[];
    limit?: number;
  }): Promise<DeliveryRecoveryDispatch>;
  /** Waits until relayed output for currently active correlated work settles. */
  settleOutputs(scope: {
    databaseSchema?: string;
    namespace: string;
    settlementScopeId: string;
  }): Promise<void>;
  shutdown(reason?: string): Promise<void>;
}>;

export type DeliveryExecutorInternals = Readonly<{
  dispatcher: DeliveryDispatcher;
  attachedWorkers?: readonly Worker[];
  createHandle(
    delivery: EventDelivery,
    event: DurableEvent,
    attemptId: string,
    work: WorkHandle,
  ): DeliveryExecutionHandle;
}>;
