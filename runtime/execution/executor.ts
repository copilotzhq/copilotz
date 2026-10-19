import { readSchemaReceipt } from "../engine/commands.ts";
import { recoverOwnerReceipt } from "./owner-receipt.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";
import type {
  DurableEvent,
  EventDelivery,
  EventStore,
} from "../events/index.ts";
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
import { createOwnerCapabilityHost } from "./owner-capabilities.ts";
import { createOwnerWorkerWorkloads } from "./owner-capability-worker.ts";
import { relayCopilotzWorkHandle } from "./protocol.ts";
import { reportDeliveryDiagnostic } from "./diagnostics.ts";
import { isStreamOutputDescriptor } from "../streams/index.ts";

const PLACEMENT_FAILURE_DIAGNOSTIC_INTERVAL_MS = 1_000;
const MAX_PLACEMENT_FAILURE_DIAGNOSTICS = 10_000;

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

/** Registration is inert and detached before any asynchronous placement. */
function captureRegistration<T extends object>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Execution registration must be a data record.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
    if (!("value" in descriptor)) {
      throw new TypeError(
        "Execution registration must contain data properties.",
      );
    }
  }
  return Object.freeze(Object.defineProperties({}, descriptors)) as T;
}
function captureTarget(
  value: ExecutionWorkTarget | undefined,
): ExecutionWorkTarget | undefined {
  if (value === undefined) return undefined;
  const captured = captureRegistration(value);
  if (
    Reflect.ownKeys(captured).length !== 1 ||
    typeof captured.workerId !== "string" || !captured.workerId.trim()
  ) {
    throw new TypeError("Execution target requires only a workerId.");
  }
  return Object.freeze({ workerId: captured.workerId });
}

/** Creates the Copilotz delivery dispatcher and optional embedded Oxian worker. */
export function createDeliveryExecutor(
  options: CreateDeliveryExecutorOptions,
): DeliveryExecutor {
  options = captureRegistration(options);
  const capturedTarget = captureTarget(options.target);
  const capturedTargets = Object.entries(
    captureRegistration(options.workloadTargets ?? {}),
  )
    .map(([name, value]) => [name, captureTarget(value)!] as const);
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
  const knownStores = new Map<string, EventStore>();
  if (options.store) {
    knownStores.set(options.store.databaseSchema, options.store);
  }
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
    knownStores.set(requested, store);
    return store;
  };
  if (Object.prototype.hasOwnProperty.call(options.workloads ?? {}, workload)) {
    throw new TypeError(
      `Additional workload '${workload}' conflicts with durable deliveries.`,
    );
  }
  const additionalWorkloads = captureRegistration(options.workloads ?? {});
  const localWorkloadWorkers = Object.fromEntries(
    Object.entries(captureRegistration(options.localWorkloadWorkers ?? {})).map(
      ([name, configuration]) => [name, captureRegistration(configuration)],
    ),
  );
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
  const ownerCapabilities = options.dispatcher
    ? undefined
    : createOwnerCapabilityHost({
      registry: options.registry,
      localExecution: true,
      lookupReceipt: async (identity, input) => {
        const schema = String(
          (input as { databaseSchema?: unknown })?.databaseSchema ?? "",
        );
        const store = knownStores.get(schema);
        if (!store) return false;
        return await readSchemaReceipt(
          store.session,
          schema,
          `worker:${identity.workerId}`,
          input,
        );
      },
      resolveAuthority: async (schema) =>
        await (await resolveStore(schema)).executionAuthority(),
      createWorkloads: options.createWorkerWorkloads ?? ((execution) => ({
        ...additionalWorkloads,
        [workload]: createDeliveryWorkload({
          ...options,
          registry: execution.registry,
          workerId: execution.workerId,
          localExecution: true,
        }),
      })),
    });

  let dispatcher: DeliveryDispatcher;
  let ownership: DeliveryExecutorOwnership;
  const attachedWorkers: ReturnType<typeof createWorker>[] = [];
  let privateHypervisor: ReturnType<typeof createHypervisor> | undefined;
  let target = capturedTarget;
  const workloadTargets = new Map<string, ExecutionWorkTarget>(
    capturedTargets,
  );
  let localCapacity: number | undefined;
  const transport: DeliveryInProcessTransport | undefined = options.dispatcher
    ? undefined
    : options.transport ?? ({
      type: "in-process" as const,
      config: {
        topic: `copilotz.execution.${crypto.randomUUID()}`,
      } as const,
    } as const);

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
      workloads: createOwnerWorkerWorkloads({
        registry: options.registry,
        workloads: Object.keys(config.workloads),
        onDiagnostic: options.onDiagnostic,
        recoverReceipt: (receipt) => recoverOwnerReceipt(worker, receipt),
      }),
      hostCalls: { maxConcurrent: 128 },
    });
    attachedWorkers.push(worker);
    void worker.closed.catch(() => undefined);
  };

  const attachLocalWorkers = (): void => {
    startWorker({
      id: workerId,
      capacity: localCapacity!,
      workloads: {
        ...Object.fromEntries(
          Object.entries(additionalWorkloads).filter(([name]) =>
            !Object.hasOwn(localWorkloadWorkers, name)
          ),
        ),
        [workload]: undefined!,
      },
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
    if (!options.bindOwnerCapabilities) {
      throw new TypeError(
        "An injected Hypervisor requires an owner-capability admission binding.",
      );
    }
    options.bindOwnerCapabilities(ownerCapabilities!);
    attachLocalWorkers();
    dispatcher = options.hypervisor;
    ownership = "shared_hypervisor";
  } else {
    localCapacity = positiveCapacity(options.capacity);
    privateHypervisor = createHypervisor({
      transports: [transport!],
      workerCalls: ownerCapabilities!.workerCalls,
    }, {
      ...ownerCapabilities!.lifecycle,
      onReady(event) {
        if (!event.workerCalls) {
          throw new Error(
            "Copilotz workers require negotiated owner capabilities.",
          );
        }
      },
    });
    attachLocalWorkers();
    dispatcher = privateHypervisor;
    ownership = "private_hypervisor";
  }
  const ready = Promise.all(
    attachedWorkers.map((worker) => worker.ready),
  ).then(() => undefined);
  void ready.catch(() => {});

  let closed = false;
  let shutdownPromise: Promise<void> | undefined;
  // Delivery/recovery producers only; non-delivery WorkHandles and external
  // settleOutputs calls retain their existing lifetimes.
  const admittedTasks = new Set<Promise<unknown>>();
  const settlementTasks = new Set<Promise<unknown>>();
  const trackTask = <T>(
    tasks: Set<Promise<unknown>>,
    task: Promise<T>,
  ): Promise<T> => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => undefined);
    return task;
  };
  const admitTask = <T>(run: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(new Error("Delivery executor is shut down."));
    }
    // Register the whole call before its first await, including store lookup.
    return trackTask(admittedTasks, run());
  };
  const active = new Map<string, DeliveryExecutionHandle>();
  const activeOutputScopes = new Map<
    string,
    Map<Promise<unknown>, EventDelivery>
  >();
  const dispatchTasks = new Map<string, Promise<DeliveryExecutionHandle>>();
  const scheduled = new Map<string, string | EventDelivery>();
  const lastPlacementFailureDiagnosticAt = new Map<string, number>();
  let scheduling = false;
  let capacityBlocked = false;
  let pumpQueued = false;
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
  const shouldReportPlacementAttempt = (
    key: string,
    nowMs: number,
  ): boolean => {
    const previous = lastPlacementFailureDiagnosticAt.get(key);
    return previous === undefined ||
      nowMs - previous >= PLACEMENT_FAILURE_DIAGNOSTIC_INTERVAL_MS;
  };
  const recordPlacementFailureDiagnostic = (
    key: string,
    nowMs: number,
  ): void => {
    if (
      !lastPlacementFailureDiagnosticAt.has(key) &&
      lastPlacementFailureDiagnosticAt.size >= MAX_PLACEMENT_FAILURE_DIAGNOSTICS
    ) {
      const oldest = lastPlacementFailureDiagnosticAt.keys().next().value;
      if (oldest) lastPlacementFailureDiagnosticAt.delete(oldest);
    }
    lastPlacementFailureDiagnosticAt.set(key, nowMs);
  };
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
    const tasks = activeOutputScopes.get(key) ??
      new Map<Promise<unknown>, EventDelivery>();
    tasks.set(task, delivery);
    activeOutputScopes.set(key, tasks);
    void task.finally(() => {
      tasks.delete(task);
      if (tasks.size === 0) activeOutputScopes.delete(key);
    }).catch(() => undefined);
  };
  const schedulePump = (): void => {
    if (closed || pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(() => {
      pumpQueued = false;
      void trackTask(admittedTasks, pumpScheduled()).catch(() => undefined);
    });
  };
  const pumpScheduled = async (): Promise<void> => {
    if (closed || scheduling) return;
    scheduling = true;
    try {
      for (const [id, delivery] of scheduled) {
        // An alarm may commit/consume the next retry while the previous Work
        // handle is still draining. Retain the wake until completion re-pumps.
        if (active.has(id) || dispatchTasks.has(id)) continue;
        if (
          localCapacity !== undefined &&
          active.size + dispatchTasks.size >= localCapacity
        ) {
          if (!capacityBlocked) {
            capacityBlocked = true;
            const queued = typeof delivery === "string" ? undefined : delivery;
            const queuedId = typeof delivery === "string"
              ? delivery
              : undefined;
            reportDeliveryDiagnostic(options.onDiagnostic, {
              phase: "capacity_blocked",
              timestampMs: Date.now(),
              workerId,
              ...(queued ? {} : {
                deliveryId: queuedId,
                databaseSchema: defaultDatabaseSchema,
              }),
              ...(queued
                ? {
                  eventId: queued.eventId,
                  deliveryId: queued.id,
                  consumerId: queued.consumerId,
                  databaseSchema: queued.databaseSchema,
                }
                : {}),
              capacity: localCapacity,
              activeCount: active.size + dispatchTasks.size,
              queuedCount: scheduled.size,
            });
          }
          break;
        }
        if (capacityBlocked) {
          capacityBlocked = false;
          const queued = typeof delivery === "string" ? undefined : delivery;
          const queuedId = typeof delivery === "string" ? delivery : undefined;
          reportDeliveryDiagnostic(options.onDiagnostic, {
            phase: "capacity_unblocked",
            timestampMs: Date.now(),
            workerId,
            ...(queued ? {} : {
              deliveryId: queuedId,
              databaseSchema: defaultDatabaseSchema,
            }),
            ...(queued
              ? {
                eventId: queued.eventId,
                deliveryId: queued.id,
                consumerId: queued.consumerId,
                databaseSchema: queued.databaseSchema,
              }
              : {}),
            capacity: localCapacity,
            activeCount: active.size + dispatchTasks.size,
            queuedCount: scheduled.size,
          });
        }
        // Consume only this selected queue entry before awaiting placement. A
        // later alarm for the same key owns a new entry and must survive it.
        scheduled.delete(id);
        try {
          const handle = await dispatchDelivery(delivery, {
            origin: "scheduled",
          });
          void handle.done.finally(() => schedulePump()).catch(() => undefined);
        } catch {
          // A placement failure is durable owner work, never a second timer.
          const schema = typeof delivery === "string"
            ? defaultDatabaseSchema
            : delivery.databaseSchema;
          const deliveryId = typeof delivery === "string"
            ? delivery
            : delivery.id;
          if (!closed) {
            await trackTask(
              admittedTasks,
              resolveStore(schema).then((store) =>
                store.deferDeliveryPlacement(deliveryId, 1000)
              ),
            );
          }
        }
      }
    } finally {
      scheduling = false;
    }
  };

  /**
   * A delivery a worker settled reports the row it settled into, which saves
   * a read. Anything else, including a failed run, is read back.
   */
  const settledDelivery = (
    claimed: EventDelivery,
    result: Readonly<Record<string, unknown>> | undefined,
  ): EventDelivery | undefined => {
    const reported = result?.delivery as Partial<EventDelivery> | undefined;
    return result?.schema === "copilotz.delivery.result.v1" &&
        result.deliveryId === claimed.id && reported?.id === claimed.id &&
        reported.databaseSchema === claimed.databaseSchema &&
        reported.status === "succeeded"
      ? reported as EventDelivery
      : undefined;
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
      // `completed` follows the output relay, so the result metadata has
      // arrived if it ever will. Peek at it: a cancelled run never sends it.
      // (Race the promise itself: a derived one settles a tick too late.)
      const reported = await Promise.race([
        work.metadata,
        Promise.resolve(undefined),
      ]).catch(() => undefined);
      const current = settledDelivery(delivery, reported) ??
        await store.getDelivery(delivery.id);
      if (!current) {
        throw new Error(
          `Delivery '${delivery.id}' disappeared after execution.`,
        );
      }
      return ({
        event,
        delivery: current,
        operationStatus: terminal.status,
      } as const);
    })();
    trackOutputScope(delivery, event, done);
    // Do not include this callback in `done`: settlement drains that promise.
    // Shutdown owns a separate drain; the callback must not await shutdown.
    // Maintenance retries missed wakes after a crash or temporary failure.
    trackTask(
      settlementTasks,
      done.then((result) => options.onDeliverySettled?.(result)),
    );

    return ({
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
    } as const);
  };

  type DispatchOptions = Readonly<{
    databaseSchema?: string;
    origin?: "direct" | "scheduled" | "recovery";
  }>;
  const dispatchAdmittedDelivery = async (
    deliveryInput: string | EventDelivery,
    dispatchOptions: DispatchOptions = {},
  ): Promise<DeliveryExecutionHandle> => {
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
      const authority = await store.executionAuthority();
      authority.signal.throwIfAborted();
      const metadata: DeliveryDispatchMetadata = {
        schema: "copilotz.delivery.dispatch.v1",
        ownerEpoch: authority.epoch,
        databaseSchema: delivery.databaseSchema,
        deliveryId: delivery.id,
        eventId: event.id,
        consumerId: delivery.consumerId,
        namespace: event.namespace,
        dispatchAttemptId: attemptId,
        idempotencyKey: delivery.id,
      } as const;
      const placementNowMs = Date.now();
      const reportPlacement = options.onDiagnostic !== undefined &&
        shouldReportPlacementAttempt(key, placementNowMs);
      if (reportPlacement) {
        reportDeliveryDiagnostic(options.onDiagnostic, {
          phase: "placement_requested",
          timestampMs: placementNowMs,
          eventId: event.id,
          deliveryId: delivery.id,
          consumerId: delivery.consumerId,
          dispatchAttemptId: attemptId,
          workerId: target?.workerId ?? workerId,
          databaseSchema: delivery.databaseSchema,
          namespace: event.namespace,
          capacity: localCapacity,
          activeCount: active.size + dispatchTasks.size,
          queuedCount: scheduled.size,
          origin: dispatchOptions.origin ?? "direct",
        });
      }
      let dispatched: Awaited<ReturnType<DeliveryDispatcher["dispatch"]>>;
      try {
        dispatched = await dispatcher.dispatch({
          workload,
          ...(target ? { target } : {}),
          metadata,
        });
      } catch (error) {
        if (reportPlacement) {
          reportDeliveryDiagnostic(options.onDiagnostic, {
            phase: "placement_failed",
            timestampMs: Date.now(),
            eventId: event.id,
            deliveryId: delivery.id,
            consumerId: delivery.consumerId,
            dispatchAttemptId: attemptId,
            workerId: target?.workerId ?? workerId,
            databaseSchema: delivery.databaseSchema,
            namespace: event.namespace,
            status: "rejected",
            capacity: localCapacity,
            activeCount: active.size + dispatchTasks.size,
            queuedCount: scheduled.size,
            origin: dispatchOptions.origin ?? "direct",
          });
          recordPlacementFailureDiagnostic(key, placementNowMs);
        }
        throw error;
      }
      lastPlacementFailureDiagnosticAt.delete(key);
      reportDeliveryDiagnostic(options.onDiagnostic, {
        phase: "placement_accepted",
        timestampMs: Date.now(),
        eventId: event.id,
        deliveryId: delivery.id,
        consumerId: delivery.consumerId,
        dispatchAttemptId: attemptId,
        operationId: dispatched.operationId,
        workerId: target?.workerId ?? workerId,
        databaseSchema: delivery.databaseSchema,
        namespace: event.namespace,
        capacity: localCapacity,
        activeCount: active.size + dispatchTasks.size,
        queuedCount: scheduled.size,
        origin: dispatchOptions.origin ?? "direct",
      });
      const work = relayCopilotzWorkHandle(dispatched, {
        onEventFrame: (output) => {
          if (isStreamOutputDescriptor(output)) return;
          reportDeliveryDiagnostic(options.onDiagnostic, {
            phase: "gateway_event_frame_received",
            timestampMs: Date.now(),
            ...(output.durable ? { eventId: output.id } : {}),
            deliveryId: delivery.id,
            consumerId: delivery.consumerId,
            dispatchAttemptId: attemptId,
            operationId: dispatched.operationId,
            workerId: target?.workerId ?? workerId,
            databaseSchema: delivery.databaseSchema,
            namespace: output.namespace,
          });
        },
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
        // A consumed wake may also be waiting on a placement that rejected
        // before producing an active handle. Admission/authority checks still
        // run through the ordinary dispatcher path.
        schedulePump();
      }
    }
  };

  const dispatchDelivery = (
    deliveryInput: string | EventDelivery,
    dispatchOptions: DispatchOptions = {},
  ): Promise<DeliveryExecutionHandle> =>
    admitTask(() => dispatchAdmittedDelivery(deliveryInput, dispatchOptions));

  const dispatchAdmittedRecoverable = async (
    listOptions: Parameters<DeliveryExecutor["dispatchRecoverable"]>[0] = {},
  ): Promise<DeliveryRecoveryDispatch> => {
    const databaseSchema = listOptions.databaseSchema?.trim() ||
      defaultDatabaseSchema;
    {
      const store = await resolveStore(databaseSchema);
      const { databaseSchema: _databaseSchema, ...filters } = listOptions;
      await store.recoverExpiredDeliveries({
        namespace: filters.namespace,
        limit: filters.limit,
      });
      const deliveries = await store.listRecoverable(filters);
      for (const delivery of deliveries) {
        reportDeliveryDiagnostic(options.onDiagnostic, {
          phase: "recovery_selected",
          timestampMs: Date.now(),
          eventId: delivery.eventId,
          deliveryId: delivery.id,
          consumerId: delivery.consumerId,
          databaseSchema: delivery.databaseSchema,
          status: delivery.status,
          origin: "recovery",
        });
      }
      const settled = await Promise.allSettled(
        deliveries.map((delivery) =>
          dispatchDelivery(delivery, { databaseSchema, origin: "recovery" })
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
      return ({
        handles: handles,
        failures: failures,
      } as const);
    }
  };

  const dispatchRecoverable = (
    listOptions: Parameters<DeliveryExecutor["dispatchRecoverable"]>[0] = {},
  ): Promise<DeliveryRecoveryDispatch> =>
    admitTask(() => dispatchAdmittedRecoverable(listOptions));

  return ({
    ownership,
    workload,
    workloads: createOwnerWorkerWorkloads({
      registry: options.registry,
      workloads: [workload, ...Object.keys(additionalWorkloads)],
    }),
    scheduleDelivery(delivery) {
      if (closed) throw new Error("Delivery executor is shut down.");
      const id = deliveryKey(delivery);
      if (!scheduled.has(id)) scheduled.set(id, delivery);
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
      const databaseSchema = scope.databaseSchema?.trim() ||
        defaultDatabaseSchema;
      const key = outputScopeKey(
        databaseSchema,
        scope.namespace,
        scope.settlementScopeId,
      );
      const tasks = [...(activeOutputScopes.get(key) ?? [])];
      if (tasks.length === 0) return;
      const store = await resolveStore(databaseSchema);
      const deliveries = await store.listDeliveries({
        ids: tasks.map(([, delivery]) => delivery.id),
        limit: tasks.length,
      });
      const current = new Map(
        deliveries.map((delivery) => [delivery.id, delivery]),
      );
      // Only the successful attempt can still have final output to relay. A
      // cancelled or expired worker may never return; it no longer owns work
      // and must not prevent settlement. The catalog rechecks durable work
      // under the admission lock after this drain.
      await Promise.allSettled(
        tasks.filter(([, original]) => {
          const delivery = current.get(original.id);
          return delivery?.status === "succeeded" &&
            delivery.attempts === original.attempts + 1;
        }).map(([task]) => task),
      );
    },
    awaitScopeProgress(scope, signal) {
      const tasks = activeOutputScopes.get(outputScopeKey(
        scope.databaseSchema?.trim() || defaultDatabaseSchema,
        scope.namespace,
        scope.settlementScopeId,
      ));
      if (!tasks?.size || signal?.aborted) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const finish = () => {
          signal?.removeEventListener("abort", finish);
          resolve(true);
        };
        signal?.addEventListener("abort", finish, { once: true });
        for (const task of tasks.keys()) void task.then(finish, finish);
      });
    },
    shutdown(reason = "copilotz_delivery_executor_shutdown") {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      // Share the complete drain with every caller, including callers arriving
      // during cleanup. Defer cleanup until the shared promise is installed.
      shutdownPromise = Promise.resolve().then(async () => {
        const cleanupErrors: unknown[] = [];
        const cleanUp = async (run: () => unknown): Promise<void> => {
          try {
            await run();
          } catch (error) {
            cleanupErrors.push(error);
          }
        };
        scheduled.clear();
        // Admission is closed. These producers finish at handle creation or the
        // end of a recovery read, never at handle.done or callback completion.
        await Promise.allSettled([...admittedTasks]);
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
          attachedWorkers.map(async (worker) => {
            try {
              await worker.stop(reason);
            } catch {
              // Preserve the existing best-effort worker stop behavior.
            }
          }),
        );
        await Promise.allSettled(
          attachedWorkers.map((worker) => worker.closed),
        );
        await cleanUp(() => ownerCapabilities?.close(reason));
        await cleanUp(() => privateHypervisor?.shutdown(reason));
        // Timer/resource errors must not skip cancellation: a delivery may need
        // it to finish. Only then drain the callbacks, independently of done.
        await Promise.allSettled([...settlementTasks]);
        if (cleanupErrors.length > 0) throw cleanupErrors[0];
      });
      return shutdownPromise;
    },
  } as const);
}
