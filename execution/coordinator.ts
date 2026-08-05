import type {
  WorkerHostDispatchInput,
  WorkerHostWorkHandle,
} from "@oxian/oxian-js/host";
import type { EventStore } from "@/database/event-store.ts";
import type { EventDelivery } from "@/events/types.ts";
import type { EventBus } from "./event-bus.ts";
import type { SettlementMonitor } from "./settlement.ts";
import {
  COPILOTZ_DELIVERY_WORKLOAD,
  decodeJsonLines,
  type DeliveryOutputFrame,
  type DeliveryWorkRequest,
} from "./protocol.ts";

export interface OxianDispatcher {
  dispatch(input: WorkerHostDispatchInput): Promise<WorkerHostWorkHandle>;
}

export interface DeliveryCoordinatorOptions {
  dispatcher: OxianDispatcher;
  store: EventStore;
  bus: EventBus;
  settlement: SettlementMonitor;
  target?: WorkerHostDispatchInput["target"];
}

interface ActiveDelivery {
  namespace: string;
  correlationId: string;
  handle: WorkerHostWorkHandle;
}

export class DeliveryCoordinator {
  readonly #options: DeliveryCoordinatorOptions;
  readonly #active = new Map<string, ActiveDelivery>();
  #closed = false;
  #recoveryTimer?: ReturnType<typeof setTimeout>;

  constructor(options: DeliveryCoordinatorOptions) {
    this.#options = options;
  }

  async accept(delivery: EventDelivery): Promise<void> {
    if (this.#closed || this.#active.has(delivery.id)) return;
    const event = await this.#options.store.getEvent(delivery.eventId);
    if (!event) {
      throw new Error(`Delivery '${delivery.id}' references a missing event.`);
    }
    const request: DeliveryWorkRequest = {
      protocol: COPILOTZ_DELIVERY_WORKLOAD,
      deliveryId: delivery.id,
      eventId: delivery.eventId,
      consumerId: delivery.consumerId,
      namespace: event.namespace,
      correlationId: event.correlationId,
    };
    const handle = await this.#options.dispatcher.dispatch({
      workload: COPILOTZ_DELIVERY_WORKLOAD,
      ...(this.#options.target ? { target: this.#options.target } : {}),
      metadata: {
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        consumerId: delivery.consumerId,
        namespace: event.namespace,
        correlationId: event.correlationId,
      },
      body: new TextEncoder().encode(JSON.stringify(request)),
    });
    this.#active.set(delivery.id, {
      namespace: event.namespace,
      correlationId: event.correlationId,
      handle,
    });
    void this.#observe(delivery.id, handle);
  }

  async acceptAll(deliveries: readonly EventDelivery[]): Promise<void> {
    await Promise.all(deliveries.map((delivery) => this.accept(delivery)));
  }

  async recover(limit = 100): Promise<number> {
    const deliveries = await this.#options.store.listRecoverable(limit);
    await this.acceptAll(deliveries);
    if (this.#active.size === 0) void this.#scheduleFutureRecovery();
    return deliveries.length;
  }

  /** Wake recovery after another worker reports a newly committed event. */
  notifyCommitted(): void {
    this.#scheduleRecovery(0);
  }

  async cancelCorrelation(
    namespace: string,
    correlationId: string,
    reason?: string,
  ): Promise<void> {
    const matching = [...this.#active.values()].filter((active) =>
      active.namespace === namespace && active.correlationId === correlationId
    );
    await Promise.all(matching.map((active) => active.handle.cancel(reason)));
    this.#options.settlement.wake();
  }

  async close(reason = "copilotz_shutdown"): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    await Promise.all(
      [...this.#active.values()].map((active) => active.handle.cancel(reason)),
    );
    this.#active.clear();
  }

  async #observe(id: string, handle: WorkerHostWorkHandle): Promise<void> {
    try {
      for await (
        const frame of decodeJsonLines<DeliveryOutputFrame>(handle.output)
      ) {
        if (frame.kind === "event") {
          this.#options.bus.publish(frame.event);
          this.#scheduleRecovery(0);
        } else this.#options.settlement.wake();
      }
      await handle.completed;
    } catch {
      // The durable lease remains recoverable if the worker disappeared.
    } finally {
      this.#active.delete(id);
      this.#options.settlement.wake();
      void this.#scheduleFutureRecovery();
    }
  }

  #scheduleRecovery(delayMs: number): void {
    if (this.#closed || this.#recoveryTimer) return;
    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = undefined;
      void this.recover().catch(() => this.#scheduleRecovery(1_000));
    }, delayMs);
  }

  async #scheduleFutureRecovery(): Promise<void> {
    if (this.#closed || this.#recoveryTimer || this.#active.size > 0) return;
    const delay = await this.#options.store.nextRecoveryDelayMs();
    if (delay === null) return;
    this.#scheduleRecovery(
      Math.max(25, Math.min(30_000, Math.ceil(delay) + 10)),
    );
  }
}
