import type {
  CollectionsManager,
  ScopedCollectionsManager,
} from "@/database/collections/types.ts";
import type { CollectionMutationScope } from "@/database/collections/event-manager.ts";
import type { CopilotzEvent, EphemeralEvent } from "@/events/types.ts";
import type { PluginRegistry } from "@/plugins/registry.ts";
import type { Agent, Tool } from "@/types/resources.ts";
import type { EventBus } from "./event-bus.ts";

type EventCollections = CollectionsManager & {
  withMutationScope(
    namespace: string,
    scope: CollectionMutationScope,
  ): ScopedCollectionsManager;
};

export interface LiveProcessorExecutorOptions {
  bus: EventBus;
  registry: PluginRegistry;
  collections: EventCollections;
}

/** Executes non-durable subscriptions locally without creating delivery rows. */
export class LiveProcessorExecutor {
  readonly #options: LiveProcessorExecutorOptions;
  readonly #controller = new AbortController();
  readonly #active = new Set<Promise<void>>();
  readonly #stop: () => void;
  #sequence = 0;

  constructor(options: LiveProcessorExecutorOptions) {
    this.#options = options;
    this.#stop = options.bus.observe((event) => {
      const task = this.#dispatch(event);
      this.#active.add(task);
      void task.finally(() => this.#active.delete(task));
    });
  }

  async close(reason = "copilotz_shutdown"): Promise<void> {
    this.#stop();
    this.#controller.abort(reason);
    await Promise.allSettled(this.#active);
  }

  async #dispatch(event: CopilotzEvent): Promise<void> {
    const processors = this.#options.registry.matchLive(event);
    await Promise.all(processors.map(async (processor) => {
      const suffix = event.durable
        ? event.id
        : `${event.streamId ?? event.type}:${
          event.sequence ?? this.#sequence++
        }`;
      const idempotencyKey = `${event.correlationId}:${suffix}:${processor.id}`;
      const collections = this.#options.collections.withMutationScope(
        event.namespace,
        {
          causationId: event.durable ? event.id : event.causationId,
          correlationId: event.correlationId,
          idempotencyKey,
          metadata: { sourceProcessorId: processor.id, live: true },
        },
      );
      try {
        await processor.handle(event, {
          event,
          namespace: event.namespace,
          threadId: event.threadId,
          correlationId: event.correlationId,
          idempotencyKey,
          collections,
          agents: this.#options.registry.list("agents") as readonly Agent[],
          tools: this.#options.registry.list("tools") as readonly Tool[],
          signal: this.#controller.signal,
          emit: (emitted) => this.#options.bus.publish(emitted),
        });
      } catch (error) {
        if (this.#controller.signal.aborted) return;
        const failed: EphemeralEvent = {
          durable: false,
          type: "processor.failed",
          namespace: event.namespace,
          ...(event.threadId ? { threadId: event.threadId } : {}),
          payload: {
            processorId: processor.id,
            sourceType: event.type,
            error: error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: "Error", message: String(error) },
          },
          routing: {},
          visibility: { kind: "internal" },
          metadata: {},
          ...(event.durable ? { causationId: event.id } : {}),
          correlationId: event.correlationId,
          createdAt: new Date().toISOString(),
        };
        this.#options.bus.publish(failed);
      }
    }));
  }
}
