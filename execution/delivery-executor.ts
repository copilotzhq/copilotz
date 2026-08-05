import type { EventStore } from "@/database/event-store.ts";
import type { EphemeralEvent, EventDelivery } from "@/events/types.ts";
import type { PluginRegistry } from "@/plugins/registry.ts";
import type { ProcessorContext } from "@/processors/types.ts";
import type {
  CollectionsManager,
  ScopedCollectionsManager,
} from "@/database/collections/types.ts";
import type { CollectionMutationScope } from "@/database/collections/event-manager.ts";
import type { Agent, Tool } from "@/types/resources.ts";
import type { EventBus } from "./event-bus.ts";
import type { SettlementMonitor } from "./settlement.ts";

type EventCollections = CollectionsManager & {
  withMutationScope(
    namespace: string,
    scope: CollectionMutationScope,
  ): ScopedCollectionsManager;
};

export interface DeliveryExecutorOptions {
  store: EventStore;
  registry: PluginRegistry;
  collections: EventCollections;
  bus: EventBus;
  settlement: SettlementMonitor;
  leaseMs?: number;
  heartbeatMs?: number;
  maxBackoffMs?: number;
  createOwnerId?: () => string;
}

export interface DeliveryExecutionResult {
  delivery?: EventDelivery;
  outcome: "succeeded" | "retry_wait" | "dead_letter" | "not_claimed";
}

export class DeliveryExecutor {
  readonly #options:
    & Required<
      Pick<
        DeliveryExecutorOptions,
        "leaseMs" | "heartbeatMs" | "maxBackoffMs" | "createOwnerId"
      >
    >
    & DeliveryExecutorOptions;

  constructor(options: DeliveryExecutorOptions) {
    this.#options = {
      ...options,
      leaseMs: options.leaseMs ?? 120_000,
      heartbeatMs: options.heartbeatMs ?? 30_000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      createOwnerId: options.createOwnerId ?? (() => crypto.randomUUID()),
    };
  }

  async execute(
    deliveryId: string,
    signal: AbortSignal,
    emit: (event: EphemeralEvent) => void = (event) =>
      this.#options.bus.publish(event),
  ): Promise<DeliveryExecutionResult> {
    const owner = this.#options.createOwnerId();
    const delivery = await this.#options.store.claimDelivery({
      id: deliveryId,
      owner,
      leaseMs: this.#options.leaseMs,
    });
    if (!delivery) return { outcome: "not_claimed" };

    const heartbeat = setInterval(() => {
      void this.#options.store.heartbeatDelivery({
        id: delivery.id,
        owner,
        leaseMs: this.#options.leaseMs,
      });
    }, this.#options.heartbeatMs);

    try {
      const event = await this.#options.store.getEvent(delivery.eventId);
      if (!event) {
        throw new Error(
          `Delivery '${delivery.id}' references a missing event.`,
        );
      }
      const processor = this.#options.registry.get(
        "processors",
        delivery.consumerId,
      );
      if (!processor) {
        throw new Error(
          `Delivery '${delivery.id}' references unknown processor '${delivery.consumerId}'.`,
        );
      }
      if (!processor.on.includes(event.type)) {
        throw new Error(
          `Processor '${processor.id}' no longer subscribes to '${event.type}'.`,
        );
      }
      if (signal.aborted) throw signal.reason;

      const collections = this.#options.collections.withMutationScope(
        event.namespace,
        {
          causationId: event.id,
          correlationId: event.correlationId,
          idempotencyKey: delivery.id,
          metadata: { sourceDeliveryId: delivery.id },
        },
      );
      const context: ProcessorContext = {
        event,
        delivery,
        namespace: event.namespace,
        threadId: event.threadId,
        correlationId: event.correlationId,
        idempotencyKey: delivery.id,
        collections,
        agents: this.#options.registry.list("agents") as readonly Agent[],
        tools: this.#options.registry.list("tools") as readonly Tool[],
        signal,
        emit,
      };
      await processor.handle(event, context);
      await this.#options.store.succeedDelivery(delivery.id, owner);
      this.#options.settlement.wake();
      return { delivery, outcome: "succeeded" };
    } catch (error) {
      if (signal.aborted) {
        const current = await this.#options.store.getDelivery(delivery.id);
        if (current?.status !== "cancelled") {
          await this.#options.store.failDelivery({
            id: delivery.id,
            owner,
            error: signal.reason ?? error,
            backoffMs: 0,
          });
        }
        this.#options.settlement.wake();
        throw signal.reason ?? error;
      }
      const exponent = Math.max(0, delivery.attempts - 1);
      const base = Math.min(
        this.#options.maxBackoffMs,
        1_000 * (2 ** exponent),
      );
      const backoffMs = Math.floor(base * (0.5 + Math.random()));
      const failed = await this.#options.store.failDelivery({
        id: delivery.id,
        owner,
        error,
        backoffMs,
      });
      this.#options.settlement.wake();
      return {
        delivery: failed ?? delivery,
        outcome: failed?.status === "dead_letter"
          ? "dead_letter"
          : "retry_wait",
      };
    } finally {
      clearInterval(heartbeat);
    }
  }
}
