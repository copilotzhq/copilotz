import type { CopilotzEvent } from "@/events/types.ts";
import {
  AsyncBroadcast,
  type StreamSubscription,
} from "@/runtime/async-queue.ts";

/** Process-local live projection of durable events and ephemeral stream frames. */
export class EventBus {
  readonly #broadcast = new AsyncBroadcast<CopilotzEvent>();
  readonly #durableIds = new Set<string>();
  readonly #durableOrder: string[] = [];
  readonly #observers = new Set<(event: CopilotzEvent) => void>();

  subscribe(
    filter?: (event: CopilotzEvent) => boolean,
  ): StreamSubscription<CopilotzEvent> {
    return this.#broadcast.subscribe(filter);
  }

  publish(event: CopilotzEvent): void {
    if (event.durable) {
      if (this.#durableIds.has(event.id)) return;
      this.#durableIds.add(event.id);
      this.#durableOrder.push(event.id);
      if (this.#durableOrder.length > 10_000) {
        this.#durableIds.delete(this.#durableOrder.shift()!);
      }
    }
    this.#broadcast.publish(event);
    for (const observer of this.#observers) observer(event);
  }

  observe(observer: (event: CopilotzEvent) => void): () => void {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  close(): void {
    this.#broadcast.close();
    this.#observers.clear();
  }
}
