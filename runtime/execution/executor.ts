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
  type DeliveryHypervisor,
  type DeliveryRecoveryDispatch,
  type DeliveryWorkload,
  type ExecutionWorkTarget,
} from "./types.ts";
import { createDeliveryWorkload } from "./workload.ts";

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
  if (options.dispatcher && options.hypervisor) {
    throw new TypeError(
      "Configure either a delivery dispatcher or Hypervisor, not both.",
    );
  }
  const workload = assertWorkload(
    options.workload ?? COPILOTZ_DELIVERY_WORKLOAD,
  );
  const createAttemptId = options.createDispatchAttemptId ??
    (() => crypto.randomUUID());
  const workerId = options.workerId ??
    `copilotz-delivery-${crypto.randomUUID()}`;
  const handler = createDeliveryWorkload({
    store: options.store,
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
  const workerRuns: Promise<unknown>[] = [];
  let privateHypervisor: ReturnType<typeof createHypervisor> | undefined;
  let target = options.target;
  const workloadTargets = new Map<string, ExecutionWorkTarget>(
    Object.entries(options.workloadTargets ?? {}),
  );
  let localCapacity: number | undefined;

  const startWorker = (
    hypervisor: DeliveryHypervisor,
    config: Readonly<{
      id: string;
      capacity: number;
      workloads: Readonly<Record<string, DeliveryWorkload>>;
    }>,
  ): void => {
    const worker = createWorker({
      id: config.id,
      transport: { type: "in-process", hypervisor },
      capacity: config.capacity,
      workloads: config.workloads,
    });
    attachedWorkers.push(worker);
    const running = worker.run();
    void running.catch(() => {});
    workerRuns.push(running);
  };

  const attachLocalWorkers = (hypervisor: DeliveryHypervisor): void => {
    startWorker(hypervisor, {
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
      startWorker(hypervisor, {
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
    attachLocalWorkers(options.hypervisor);
    dispatcher = options.hypervisor;
    ownership = "shared_hypervisor";
  } else {
    localCapacity = positiveCapacity(options.capacity);
    privateHypervisor = createHypervisor({
      // Copilotz claims its durable delivery inside the workload before effects.
      persistAcceptance: () => Promise.resolve(),
    });
    attachLocalWorkers(privateHypervisor);
    dispatcher = privateHypervisor;
    ownership = "private_hypervisor";
  }
  const ready = Promise.all(
    attachedWorkers.map((worker) => worker.whenReady()),
  ).then(() => undefined);
  void ready.catch(() => {});

  let closed = false;
  const active = new Map<string, DeliveryExecutionHandle>();
  const dispatchTasks = new Map<string, Promise<DeliveryExecutionHandle>>();
  const scheduled = new Map<string, string | EventDelivery>();
  let scheduling = false;
  let scheduleTimer: ReturnType<typeof setTimeout> | undefined;
  const deliveryKey = (delivery: string | EventDelivery): string =>
    typeof delivery === "string" ? delivery : delivery.id;
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

  const createHandle = (
    delivery: EventDelivery,
    event: DurableEvent,
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
        await options.store.failDelivery({
          id: delivery.id,
          owner: attemptId,
          error: new Error(
            terminal.terminal?.message ??
              `Oxian operation ended as '${terminal.status}'.`,
          ),
        });
      }
      const current = await options.store.getDelivery(delivery.id);
      if (!current) {
        throw new Error(
          `Delivery '${delivery.id}' disappeared after execution.`,
        );
      }
      return Object.freeze({
        event,
        delivery: current,
        operationStatus: terminal.status,
      });
    })();

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
  ): Promise<DeliveryExecutionHandle> => {
    if (closed) throw new Error("Delivery executor is shut down.");
    const delivery = typeof deliveryInput === "string"
      ? await options.store.getDelivery(deliveryInput)
      : deliveryInput;
    if (!delivery) {
      throw new Error(`Delivery '${deliveryInput}' was not found.`);
    }
    const existing = active.get(delivery.id);
    if (existing) return existing;
    const dispatching = dispatchTasks.get(delivery.id);
    if (dispatching) return await dispatching;

    const task = (async () => {
      await ready;
      const event = await options.store.getEvent(delivery.eventId);
      if (!event) throw new Error(`Event '${delivery.eventId}' was not found.`);
      const attemptId = createAttemptId();
      if (!attemptId.trim()) {
        throw new TypeError("Delivery dispatch attempt IDs must be non-empty.");
      }
      const metadata: DeliveryDispatchMetadata = Object.freeze({
        schema: "copilotz.delivery.dispatch.v1",
        deliveryId: delivery.id,
        eventId: event.id,
        consumerId: delivery.consumerId,
        namespace: event.namespace,
        dispatchAttemptId: attemptId,
        idempotencyKey: delivery.id,
      });
      const work = await dispatcher.dispatch({
        workload,
        ...(target ? { target } : {}),
        metadata,
      });
      const handle = createHandle(delivery, event, attemptId, work);
      active.set(delivery.id, handle);
      // Register first, then attach cleanup. A fast embedded operation may
      // already be settled when createHandle returns.
      void handle.done.finally(() => {
        if (active.get(delivery.id)?.operationId === work.operationId) {
          active.delete(delivery.id);
        }
        schedulePump();
      }).catch(() => undefined);
      return handle;
    })();
    dispatchTasks.set(delivery.id, task);
    try {
      return await task;
    } finally {
      if (dispatchTasks.get(delivery.id) === task) {
        dispatchTasks.delete(delivery.id);
      }
    }
  };

  return Object.freeze({
    ownership,
    workload,
    workloads: hostedWorkloads,
    scheduleDelivery(delivery) {
      if (closed) throw new Error("Delivery executor is shut down.");
      const id = deliveryKey(delivery);
      if (active.has(id) || dispatchTasks.has(id) || scheduled.has(id)) return;
      scheduled.set(id, delivery);
      schedulePump();
    },
    async dispatchWork(input) {
      if (closed) {
        throw new Error("Delivery executor is shut down.");
      }
      await ready;
      const workloadTarget = workloadTargets.get(input.workload);
      return await dispatcher.dispatch({
        ...input,
        ...(input.target
          ? {}
          : workloadTarget
          ? { target: workloadTarget }
          : target
          ? { target }
          : {}),
      });
    },
    dispatchDelivery,
    async dispatchRecoverable(
      listOptions = {},
    ): Promise<DeliveryRecoveryDispatch> {
      const deliveries = await options.store.listRecoverable(listOptions);
      const settled = await Promise.allSettled(
        deliveries.map((delivery) => dispatchDelivery(delivery)),
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
    },
    async shutdown(reason = "copilotz_delivery_executor_shutdown") {
      if (closed) return;
      closed = true;
      if (scheduleTimer !== undefined) clearTimeout(scheduleTimer);
      scheduleTimer = undefined;
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
      await Promise.allSettled(workerRuns);
      await privateHypervisor?.shutdown(reason);
    },
  });
}
