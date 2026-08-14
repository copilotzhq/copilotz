import {
  createWorker,
  type Worker,
  type WorkerLifecycleCallbacks,
  type WorkerOptions,
  type WorkerResult,
} from "../../dependencies/oxian-worker.ts";
import type {
  DeliveryDispatcher,
  ExecutionWorkHandle,
  ExecutionWorkInput,
} from "../execution/index.ts";
import {
  COPILOTZ_DELIVERY_WORKLOAD,
  createCopilotzWorkOutputRelay,
} from "../execution/index.ts";
import {
  createCopilotzApplication,
  observeApplicationPersistence,
} from "./application.ts";
import type { CreateCopilotzApplicationOptions } from "./types.ts";
import {
  type CopilotzPersistenceOptions,
  openCopilotzPersistence,
} from "./persistence.ts";

type WorkerEngineOptions = Omit<
  NonNullable<CreateCopilotzApplicationOptions["engine"]>,
  "eventHub" | "execution" | "publish"
>;

export type CreateCopilotzWorkerOptions =
  & Omit<
    CreateCopilotzApplicationOptions,
    "database" | "engine"
  >
  & CopilotzPersistenceOptions
  & Omit<WorkerOptions, "workloads">
  & Readonly<{ engine?: WorkerEngineOptions }>;

export type CopilotzWorker =
  & Omit<Worker, "closed" | "stop">
  & Readonly<{
    role: "worker";
    closed: Promise<WorkerResult>;
    stop(reason?: string): Promise<void>;
  }>;

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * Worker-side mutations leave their delivery rows pending. Their framed events
 * prompt the Gateway to place those rows, while recovery covers a lost frame.
 */
function createDeferredDeliveryDispatcher(): DeliveryDispatcher {
  return Object.freeze({
    dispatch(input: ExecutionWorkInput): Promise<ExecutionWorkHandle> {
      if (input.workload !== COPILOTZ_DELIVERY_WORKLOAD) {
        throw new Error(
          `Worker runtime cannot originate root workload '${input.workload}'.`,
        );
      }
      const now = Date.now();
      const operationId = crypto.randomUUID();
      const streamId = crypto.randomUUID();
      const terminal = Object.freeze({
        operationId,
        workload: input.workload,
        ...(input.target ? { target: input.target } : {}),
        metadata: input.metadata ?? {},
        ...(input.deadlineAtMs ? { deadlineAtMs: input.deadlineAtMs } : {}),
        status: "completed" as const,
        deliveryCount: 0,
        openedAtMs: now,
        updatedAtMs: now,
      });
      return Promise.resolve(Object.freeze({
        operationId,
        streamId,
        metadata: Promise.resolve(Object.freeze({
          schema: "copilotz.delivery.deferred.v1",
        })),
        output: emptyStream(),
        started: Promise.resolve(),
        completed: Promise.resolve(terminal),
        cancel: () => Promise.resolve(terminal),
      }));
    },
  });
}

/** Creates an outbound Copilotz execution role without a private Hypervisor. */
export async function createCopilotzWorker(
  options: CreateCopilotzWorkerOptions,
  lifecycle: WorkerLifecycleCallbacks = {},
): Promise<CopilotzWorker> {
  const persistence = await openCopilotzPersistence(options);
  const relay = createCopilotzWorkOutputRelay();
  let application;
  try {
    application = await createCopilotzApplication({
      namespace: options.namespace,
      databaseSchema: options.databaseSchema,
      core: options.core,
      plugins: options.plugins,
      resources: options.resources,
      pluginResolver: options.pluginResolver,
      toolCatalog: options.toolCatalog,
      database: persistence.database,
      engine: {
        ...(options.engine ?? {}),
        publish: relay.publish,
        execution: {
          dispatcher: createDeferredDeliveryDispatcher(),
        },
      },
    });
  } catch (error) {
    await persistence.close("copilotz_worker_initialization_failed").catch(
      () => undefined,
    );
    throw error;
  }

  let worker: Worker;
  try {
    worker = createWorker({
      id: options.id,
      transport: options.transport,
      activate: options.activate,
      register: options.register,
      handshake: options.handshake,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      readyTimeoutMs: options.readyTimeoutMs,
      resumeExpirySkewMs: options.resumeExpirySkewMs,
      inputBufferBytes: options.inputBufferBytes,
      createHeartbeatMetadata: options.createHeartbeatMetadata,
      reconnectDelay: options.reconnectDelay,
      maxReconnectDelayMs: options.maxReconnectDelayMs,
      createHandshakeId: options.createHandshakeId,
      now: options.now,
      capacity: options.capacity,
      signal: options.signal,
      workloads: relay.wrap(application.execution.workloads),
    }, lifecycle);
  } catch (error) {
    await application.shutdown("copilotz_worker_creation_failed").catch(
      () => undefined,
    );
    await persistence.close("copilotz_worker_creation_failed").catch(
      () => undefined,
    );
    throw error;
  }

  const stopObservingPersistence = observeApplicationPersistence(
    persistence,
    application,
    { recoverDurable: false },
  );

  let cleanupTask: Promise<void> | undefined;
  const cleanup = (reason: string): Promise<void> => {
    if (cleanupTask) return cleanupTask;
    stopObservingPersistence();
    cleanupTask = Promise.allSettled([
      application.shutdown(reason),
      persistence.close(reason),
    ]).then((settled) => {
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Copilotz Worker cleanup failed.");
      }
    });
    cleanupTask.catch(() => undefined);
    return cleanupTask;
  };

  const closed = worker.closed.then(async (result) => {
    await cleanup("copilotz_worker_closed");
    return result;
  });
  closed.catch(() => undefined);

  return Object.freeze({
    role: "worker",
    ready: worker.ready,
    closed,
    events: worker.events,
    snapshot: worker.snapshot,
    async stop(reason = "copilotz_worker_stopped") {
      await worker.stop(reason);
      await closed;
    },
  });
}
