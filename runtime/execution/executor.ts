import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";
import type { DurableEvent, EventDelivery } from "../events/index.ts";
import {
  COPILOTZ_DELIVERY_WORKLOAD,
  type CreateDeliveryExecutorOptions,
  type DeliveryDispatcher,
  type DeliveryDispatchMetadata,
  type DeliveryExecutionHandle,
  type DeliveryExecutor,
  type DeliveryExecutorOwnership,
  type DeliveryInProcessTransport,
  type DeliveryRecoveryDispatch,
  type DeliveryWorkload,
  type ExecutionWorkTarget,
} from "./types.ts";
import { createDeliveryWorkload } from "./workload.ts";
import { relayCopilotzWorkHandle } from "./protocol.ts";

const RECOVERY_MINIMUM_DELAY_MS = 1_000;

function positiveCapacity(value: number | undefined): number {
  const capacity = value ?? 8;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new TypeError("Delivery worker capacity must be a positive integer.");
  }
  return capacity;
}

function assertWorkload(value: string): string {
  const workload = value.trim();
  if (!workload) throw new TypeError("Delivery workload must be non-empty.");
  return workload;
}

/** Creates the Copilotz delivery dispatcher and optional embedded Oxian worker. */
export function createDeliveryExecutor(
  options: CreateDeliveryExecutorOptions,
): DeliveryExecutor {
  if (!options.store && !options.resolveStore) {
    throw new TypeError("Delivery executor requires a store resolver.");
  }
  if (options.dispatcher && options.hypervisor) {
    throw new TypeError(
      "Configure either a delivery dispatcher or Hypervisor, not both.",
    );
  }
  if (options.dispatcher && options.transport) {
    throw new TypeError(
      "An injected dispatcher already owns Worker placement and cannot receive a local transport.",
    );
  }
  if (options.hypervisor && !options.transport) {
    throw new TypeError(
      "An injected Hypervisor requires its declared in-process transport.",
    );
  }
  const workload = assertWorkload(
    options.workload ?? COPILOTZ_DELIVERY_WORKLOAD,
  );
  const createAttemptId = options.createDispatchAttemptId ??
    (() => crypto.randomUUID());
  const workerId = options.workerId ??
    `copilotz-delivery-${crypto.randomUUID()}`;
  const defaultDatabaseSchema = options.defaultDatabaseSchema?.trim() ||
    options.store?.databaseSchema || "public";
  const resolveStore = async (databaseSchema: string) => {
    const requested = databaseSchema.trim();
    if (!requested) throw new TypeError("Database schema must be non-empty.");
    const store = options.resolveStore
      ? await options.resolveStore(requested)
      : options.store!;
    if (store.databaseSchema !== requested) {
      throw new TypeError(
        `Resolved store '${store.databaseSchema}' does not match '${requested}'.`,
      );
    }
    return store;
  };
  const handler = createDeliveryWorkload({
    store: options.store,
    resolveStore: options.resolveStore,
    registry: options.registry,
    createContext: options.createContext,
    leaseMs: options.leaseMs,
    heartbeatMs: options.heartbeatMs,
    scheduler: options.scheduler,
  });
  if (Object.prototype.hasOwnProperty.call(options.workloads ?? {}, workload)) {
    throw new TypeError(
      `Additional workload '${workload}' conflicts with durable deliveries.`,
    );
  }
  const additionalWorkloads = options.workloads ?? {};
  const localWorkloadWorkers = options.localWorkloadWorkers ?? {};
  if (options.dispatcher && Object.keys(localWorkloadWorkers).length > 0) {
    throw new TypeError(
      "Local workload workers cannot be attached to an injected dispatcher.",
    );
  }
  for (const name of Object.keys(localWorkloadWorkers)) {
    if (!Object.prototype.hasOwnProperty.call(additionalWorkloads, name)) {
      throw new TypeError(
        `Local workload worker '${name}' has no registered workload.`,
      );
    }
  }
  const primaryAdditional = Object.fromEntries(
    Object.entries(additionalWorkloads).filter(([name]) =>
      !Object.prototype.hasOwnProperty.call(localWorkloadWorkers, name)
    ),
  );
  const hostedWorkloads = Object.freeze({
    ...primaryAdditional,
    [workload]: handler,
  });

  let dispatcher: DeliveryDispatcher;
  let ownership: DeliveryExecutorOwnership;
  const attachedWorkers: ReturnType<typeof createWorker>[] = [];
  let privateHypervisor: ReturnType<typeof createHypervisor> | undefined;
  let target = options.target;
  const workloadTargets = new Map<string, ExecutionWorkTarget>(
    Object.entries(options.workloadTargets ?? {}),
  );
  let localCapacity: number | undefined;
  const transport: DeliveryInProcessTransport | undefined = options.dispatcher
    ? undefined
    : options.transport ?? Object.freeze({
      type: "in-process" as const,
      config: Object.freeze({
        topic: `copilotz.execution.${crypto.randomUUID()}`,
      }),
    });

  const startWorker = (
    config: Readonly<{
      id: string;
      capacity: number;
      workloads: Readonly<Record<string, DeliveryWorkload>>;
    }>,
  ): void => {
    const worker = createWorker({
      id: config.id,
      transport: transport!,
      capacity: config.capacity,
      workloads: config.workloads,
    });
    attachedWorkers.push(worker);
    void worker.closed.catch(() => undefined);
  };

  const attachLocalWorkers = (): void => {
    startWorker({
      id: workerId,
      capacity: localCapacity!,
      workloads: hostedWorkloads,
    });
    target = { workerId };
    const workerIds = new Set([workerId]);
    let index = 0;
    for (const [name, config] of Object.entries(localWorkloadWorkers)) {
      if (workloadTargets.has(name)) {
        throw new TypeError(
          `Workload '${name}' cannot configure both a target and local worker.`,
        );
      }
      const isolatedWorkerId = config.workerId?.trim() ||
        `${workerId}-workload-${++index}`;
      if (workerIds.has(isolatedWorkerId)) {
        throw new TypeError(
          `Execution worker ID '${isolatedWorkerId}' is duplicated.`,
        );
      }
      workerIds.add(isolatedWorkerId);
      startWorker({
        id: isolatedWorkerId,
        capacity: positiveCapacity(config.capacity),
        workloads: { [name]: additionalWorkloads[name] },
      });
      workloadTargets.set(name, { workerId: isolatedWorkerId });
    }
  };

  if (options.dispatcher) {
    dispatcher = options.dispatcher;
    ownership = "injected_dispatcher";
  } else if (options.hypervisor) {
    localCapacity = positiveCapacity(options.capacity);
    attachLocalWorkers();
    dispatcher = options.hypervisor;
    ownership = "shared_hypervisor";
  } else {
    localCapacity = positiveCapacity(options.capacity);
    privateHypervisor = createHypervisor({
      transports: [transport!],
    });
    attachLocalWorkers();
    dispatcher = privateHypervisor;
    ownership = "private_hypervisor";
  }
  const ready = Promise.all(
    attachedWorkers.map((worker) => worker.ready),
  ).then(() => undefined);
  void ready.catch(() => {});

  const retryScheduler = options.scheduler ?? Object.freeze({
    schedule(callback: () => void, delayMs: number): unknown {
      return setTimeout(callback, delayMs);
    },
    cancel(handle: unknown): void {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });

  let closed = false;
  const active = new Map<string, DeliveryExecutionHandle>();
  const activeOutputScopes = new Map<string, Set<Promise<unknown>>>();
  const dispatchTasks = new Map<string, Promise<DeliveryExecutionHandle>>();
  const scheduled = new Map<string, string | EventDelivery>();
  const retryTimers = new Map<
    string,
    Readonly<{ handle: unknown; dueAtMs: number }>
  >();
  const recoveryTimers = new Map<
    string,
    Readonly<{ handle: unknown; dueAtMs: number }>
  >();
  const continuousRecoverySchemas = new Set<string>();
  let scheduling = false;
  let scheduleTimer: ReturnType<typeof setTimeout> | undefined;
  const deliveryKey = (
    delivery: string | EventDelivery,
    databaseSchema = defaultDatabaseSchema,
  ): string =>
    `${
      typeof delivery === "string" ? databaseSchema : delivery.databaseSchema
    }\u0000${typeof delivery === "string" ? delivery : delivery.id}`;
  const outputScopeKey = (
    databaseSchema: string,
    namespace: string,
    settlementScopeId: string,
  ): string => `${databaseSchema}\u0000${namespace}\u0000${settlementScopeId}`;
  const trackOutputScope = (
    delivery: EventDelivery,
    event: DurableEvent,
    task: Promise<unknown>,
  ): void => {
    const key = outputScopeKey(
      delivery.databaseSchema,
      event.namespace,
      delivery.settlementScopeId,
    );
    const tasks = activeOutputScopes.get(key) ?? new Set<Promise<unknown>>();
    tasks.add(task);
    activeOutputScopes.set(key, tasks);
    void task.finally(() => {
      tasks.delete(task);
      if (tasks.size === 0) activeOutputScopes.delete(key);
    }).catch(() => undefined);
  };
  const schedulePump = (delayMs = 0): void => {
    if (closed || scheduling || scheduleTimer !== undefined) return;
    scheduleTimer = setTimeout(() => {
      scheduleTimer = undefined;
      void pumpScheduled();
    }, delayMs);
  };
  const pumpScheduled = async (): Promise<void> => {
    if (closed || scheduling) return;
    scheduling = true;
    try {
      for (const [id, delivery] of scheduled) {
        if (
          localCapacity !== undefined &&
          active.size + dispatchTasks.size >= localCapacity
        ) break;
        try {
          const handle = await dispatchDelivery(delivery);
          scheduled.delete(id);
          void handle.done.finally(() => schedulePump()).catch(() => undefined);
        } catch {
          // Placement does not claim the durable delivery. Keep it queued and
          // retry after another operation can release worker capacity.
          break;
        }
      }
    } finally {
      scheduling = false;
      if (!closed && scheduled.size > 0) schedulePump(10);
    }
  };

  const cancelRetryTimer = (key: string): void => {
    const timer = retryTimers.get(key);
    if (!timer) return;
    retryTimers.delete(key);
    retryScheduler.cancel(timer.handle);
  };

  const scheduleRetry = (delivery: EventDelivery): void => {
    if (closed || delivery.status !== "retry_wait") return;
    const key = deliveryKey(delivery);
    const parsed = Date.parse(delivery.availableAt);
    const dueAtMs = Number.isFinite(parsed) ? parsed : Date.now();
    const existing = retryTimers.get(key);
    if (existing && existing.dueAtMs <= dueAtMs) return;
    if (existing) retryScheduler.cancel(existing.handle);
    const handle = retryScheduler.schedule(() => {
      retryTimers.delete(key);
      if (closed || active.has(key) || dispatchTasks.has(key)) return;
      scheduled.set(key, delivery);
      schedulePump();
    }, Math.max(0, dueAtMs - Date.now()));
    retryTimers.set(key, Object.freeze({ handle, dueAtMs }));
  };

  const cancelRecoveryTimer = (databaseSchema: string): void => {
    const timer = recoveryTimers.get(databaseSchema);
    if (!timer) return;
    recoveryTimers.delete(databaseSchema);
    retryScheduler.cancel(timer.handle);
  };

  const createHandle = (
    delivery: EventDelivery,
    event: DurableEvent,
    store: Awaited<ReturnType<typeof resolveStore>>,
    attemptId: string,
    work: Awaited<ReturnType<DeliveryDispatcher["dispatch"]>>,
  ): DeliveryExecutionHandle => {
    const output = work.output.pipeTo(new WritableStream<Uint8Array>());
    output.catch(() => undefined);
    work.metadata.catch(() => undefined);

    const done = (async () => {
      const terminal = await work.completed;
      await output.catch(() => undefined);
      if (terminal.status !== "completed") {
        await store.failDelivery({
          id: delivery.id,
          owner: attemptId,
          error: new Error(
            terminal.terminal?.message ??
              `Oxian operation ended as '${terminal.status}'.`,
          ),
        });
      }
      const current = await store.getDelivery(delivery.id);
      if (!current) {
        throw new Error(
          `Delivery '${delivery.id}' disappeared after execution.`,
        );
      }
      scheduleRetry(current);
      return Object.freeze({
        event,
        delivery: current,
        operationStatus: terminal.status,
      });
    })();
    trackOutputScope(delivery, event, done);

    return Object.freeze({
      deliveryId: delivery.id,
      eventId: event.id,
      operationId: work.operationId,
      streamId: work.streamId,
      started: work.started,
      done,
      async cancel(reason?: string) {
        await work.cancel(reason);
        await done;
      },
    });
  };

  const dispatchDelivery = async (
    deliveryInput: string | EventDelivery,
    dispatchOptions: { databaseSchema?: string } = {},
  ): Promise<DeliveryExecutionHandle> => {
    if (closed) throw new Error("Delivery executor is shut down.");
    const requestedSchema = typeof deliveryInput === "string"
      ? dispatchOptions.databaseSchema?.trim() || defaultDatabaseSchema
      : deliveryInput.databaseSchema;
    const store = await resolveStore(requestedSchema);
    const delivery = typeof deliveryInput === "string"
      ? await store.getDelivery(deliveryInput)
      : deliveryInput;
    if (!delivery) {
      throw new Error(`Delivery '${deliveryInput}' was not found.`);
    }
    const key = deliveryKey(delivery);
    cancelRetryTimer(key);
    const existing = active.get(key);
    if (existing) return existing;
    const dispatching = dispatchTasks.get(key);
    if (dispatching) return await dispatching;

    const task = (async () => {
      await ready;
      const event = await store.getEvent(delivery.eventId);
      if (!event) throw new Error(`Event '${delivery.eventId}' was not found.`);
      const attemptId = createAttemptId();
      if (!attemptId.trim()) {
        throw new TypeError("Delivery dispatch attempt IDs must be non-empty.");
      }
      const metadata: DeliveryDispatchMetadata = Object.freeze({
        schema: "copilotz.delivery.dispatch.v1",
        databaseSchema: delivery.databaseSchema,
        deliveryId: delivery.id,
        eventId: event.id,
        consumerId: delivery.consumerId,
        namespace: event.namespace,
        dispatchAttemptId: attemptId,
        idempotencyKey: delivery.id,
      });
      const dispatched = await dispatcher.dispatch({
        workload,
        ...(target ? { target } : {}),
        metadata,
      });
      const work = relayCopilotzWorkHandle(dispatched, {
        onOutput: options.onOutput
          ? (output) =>
            options.onOutput!(output, {
              databaseSchema: delivery.databaseSchema,
              settlementScopeId: delivery.settlementScopeId,
            })
          : undefined,
      });
      const handle = createHandle(delivery, event, store, attemptId, work);
      active.set(key, handle);
      if (continuousRecoverySchemas.has(delivery.databaseSchema)) {
        refreshRecoverySchedule(delivery.databaseSchema);
      }
      // Register first, then attach cleanup. A fast embedded operation may
      // already be settled when createHandle returns.
      void handle.done.finally(() => {
        if (active.get(key)?.operationId === work.operationId) {
          active.delete(key);
        }
        schedulePump();
      }).catch(() => undefined);
      return handle;
    })();
    dispatchTasks.set(key, task);
    try {
      return await task;
    } finally {
      if (dispatchTasks.get(key) === task) {
        dispatchTasks.delete(key);
      }
    }
  };

  const dispatchRecoverable = async (
    listOptions: Parameters<DeliveryExecutor["dispatchRecoverable"]>[0] = {},
  ): Promise<DeliveryRecoveryDispatch> => {
    const databaseSchema = listOptions.databaseSchema?.trim() ||
      defaultDatabaseSchema;
    const continuous = listOptions.namespace === undefined &&
      listOptions.consumerIds === undefined;
    if (options.continuousRecovery === true && continuous) {
      continuousRecoverySchemas.add(databaseSchema);
    }
    try {
      const store = await resolveStore(databaseSchema);
      const { databaseSchema: _databaseSchema, ...filters } = listOptions;
      const deliveries = await store.listRecoverable(filters);
      const settled = await Promise.allSettled(
        deliveries.map((delivery) =>
          dispatchDelivery(delivery, { databaseSchema })
        ),
      );
      const handles: DeliveryExecutionHandle[] = [];
      const failures: Array<{ deliveryId: string; error: unknown }> = [];
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") handles.push(result.value);
        else {
          failures.push({
            deliveryId: deliveries[index].id,
            error: result.reason,
          });
        }
      });
      return Object.freeze({
        handles: Object.freeze(handles),
        failures: Object.freeze(failures),
      });
    } finally {
      if (continuous) refreshRecoverySchedule(databaseSchema);
    }
  };

  function refreshRecoverySchedule(requestedDatabaseSchema: string): void {
    const databaseSchema = requestedDatabaseSchema.trim();
    if (closed || !continuousRecoverySchemas.has(databaseSchema)) return;
    void resolveStore(databaseSchema).then((store) =>
      store.nextRecoveryDelayMs()
    ).then((delay) => {
      if (closed) return;
      if (delay === null) {
        cancelRecoveryTimer(databaseSchema);
        return;
      }
      const dueAtMs = Date.now() + Math.max(RECOVERY_MINIMUM_DELAY_MS, delay);
      const existing = recoveryTimers.get(databaseSchema);
      if (existing && existing.dueAtMs <= dueAtMs) return;
      if (existing) retryScheduler.cancel(existing.handle);
      const handle = retryScheduler.schedule(() => {
        recoveryTimers.delete(databaseSchema);
        if (closed) return;
        // dispatchRecoverable rearms the schema in its own finally block.
        void dispatchRecoverable({ databaseSchema }).catch(() => undefined);
      }, Math.max(0, dueAtMs - Date.now()));
      recoveryTimers.set(databaseSchema, Object.freeze({ handle, dueAtMs }));
    }).catch(() => undefined);
  }

  return Object.freeze({
    ownership,
    workload,
    workloads: hostedWorkloads,
    scheduleDelivery(delivery) {
      if (closed) throw new Error("Delivery executor is shut down.");
      const id = deliveryKey(delivery);
      if (active.has(id) || dispatchTasks.has(id) || scheduled.has(id)) return;
      cancelRetryTimer(id);
      scheduled.set(id, delivery);
      if (
        continuousRecoverySchemas.has(
          typeof delivery === "string"
            ? defaultDatabaseSchema
            : delivery.databaseSchema,
        )
      ) {
        refreshRecoverySchedule(
          typeof delivery === "string"
            ? defaultDatabaseSchema
            : delivery.databaseSchema,
        );
      }
      schedulePump();
    },
    async dispatchWork(input) {
      if (closed) {
        throw new Error("Delivery executor is shut down.");
      }
      await ready;
      const workloadTarget = workloadTargets.get(input.workload);
      const dispatched = await dispatcher.dispatch({
        ...input,
        ...(input.target
          ? {}
          : workloadTarget
          ? { target: workloadTarget }
          : target
          ? { target }
          : {}),
      });
      const databaseSchema = typeof input.metadata?.databaseSchema === "string"
        ? input.metadata.databaseSchema.trim() || defaultDatabaseSchema
        : defaultDatabaseSchema;
      return relayCopilotzWorkHandle(dispatched, {
        onOutput: options.onOutput
          ? (output) => options.onOutput!(output, { databaseSchema })
          : undefined,
      });
    },
    dispatchDelivery,
    dispatchRecoverable,
    async settleOutputs(scope) {
      const key = outputScopeKey(
        scope.databaseSchema?.trim() || defaultDatabaseSchema,
        scope.namespace,
        scope.settlementScopeId,
      );
      while (true) {
        const tasks = [...(activeOutputScopes.get(key) ?? [])];
        if (tasks.length === 0) return;
        await Promise.allSettled(tasks);
      }
    },
    async shutdown(reason = "copilotz_delivery_executor_shutdown") {
      if (closed) return;
      closed = true;
      if (scheduleTimer !== undefined) clearTimeout(scheduleTimer);
      scheduleTimer = undefined;
      for (const timer of retryTimers.values()) {
        retryScheduler.cancel(timer.handle);
      }
      retryTimers.clear();
      for (const timer of recoveryTimers.values()) {
        retryScheduler.cancel(timer.handle);
      }
      recoveryTimers.clear();
      scheduled.clear();
      const pending = await Promise.allSettled([...dispatchTasks.values()]);
      const handles = new Map(active);
      for (const result of pending) {
        if (result.status === "fulfilled") {
          handles.set(result.value.deliveryId, result.value);
        }
      }
      const cancellations = [...handles.values()].map((handle) =>
        handle.cancel(reason).catch(() => undefined)
      );
      await Promise.all(cancellations);
      await Promise.all(
        attachedWorkers.map((worker) =>
          worker.stop(reason).catch(() => undefined)
        ),
      );
      await Promise.allSettled(
        attachedWorkers.map((worker) => worker.closed),
      );
      await privateHypervisor?.shutdown(reason);
    },
  });
}
