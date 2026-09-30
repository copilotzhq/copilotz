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
  DurableEvent,
  EventDelivery,
  EventStore,
} from "../events/index.ts";
import type { PluginRegistry, ProcessorContext } from "../plugins/index.ts";
import type { RuntimeOutputDescriptor } from "../streams/index.ts";

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

/**
 * Why a delivery's handler failed, safe to log: the error's name and a message
 * of at most 500 characters with common credential shapes masked. It never
 * carries a stack, a cause, or the Event being handled.
 */
export type DeliveryDiagnosticError = Readonly<{
  name: string;
  message: string;
}>;

/** Opt-in, process-local delivery timing observation. Never persisted. */
export type DeliveryDiagnostic = Readonly<{
  phase:
    | "child_delivery_scheduled"
    | "placement_requested"
    | "placement_accepted"
    | "placement_failed"
    | "capacity_blocked"
    | "capacity_unblocked"
    | "worker_claimed"
    | "worker_claim_skipped"
    | "worker_handler_started"
    | "worker_handler_settled"
    | "gateway_event_frame_received"
    | "recovery_selected";
  timestampMs: number;
  eventId?: string;
  deliveryId?: string;
  consumerId?: string;
  dispatchAttemptId?: string;
  operationId?: string;
  workerId?: string;
  databaseSchema?: string;
  namespace?: string;
  status?: string;
  /**
   * Present on a `worker_handler_settled` diagnostic when the handler threw.
   * `status` then says what became of the delivery: `retry_wait` or
   * `dead_letter`.
   */
  error?: DeliveryDiagnosticError;
  origin?: "direct" | "scheduled" | "recovery";
  capacity?: number;
  activeCount?: number;
  queuedCount?: number;
}>;

/** Diagnostic sinks are isolated from delivery behavior, including rejections. */
export type DeliveryDiagnosticSink = (
  diagnostic: DeliveryDiagnostic,
) => void | Promise<void>;

export type CreateDeliveryWorkloadOptions = Readonly<{
  store?: EventStore;
  resolveStore?: (databaseSchema: string) => EventStore | Promise<EventStore>;
  registry: PluginRegistry;
  createContext: DeliveryContextFactory;
  leaseMs?: number;
  heartbeatMs?: number;
  scheduler?: DeliveryWorkloadScheduler;
  workerId?: string;
  onDiagnostic?: DeliveryDiagnosticSink;
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
  /** Enables Gateway-owned continuous recovery after an unfiltered sweep. */
  continuousRecovery?: boolean;
  scheduler?: DeliveryWorkloadScheduler;
  createDispatchAttemptId?: () => string;
  /** Disabled by default; receives allowlisted process-local delivery timing. */
  onDiagnostic?: DeliveryDiagnosticSink;
  /** Relays generic event and stream descriptors from a remote Worker. */
  onOutput?: (
    output: RuntimeOutputDescriptor,
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
  /**
   * Waits until some work this executor is running for the scope finishes.
   * Resolves `false` at once when it runs none, since progress then happens
   * elsewhere.
   */
  awaitScopeProgress(scope: {
    databaseSchema?: string;
    namespace: string;
    settlementScopeId: string;
  }, signal?: AbortSignal): Promise<boolean>;
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
