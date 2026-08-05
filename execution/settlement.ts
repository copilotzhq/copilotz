import type { EventStore } from "@/database/event-store.ts";

export class DeadLetterError extends Error {
  override name = "DeadLetterError";
  constructor(readonly correlationId: string) {
    super(`Correlation '${correlationId}' contains dead-lettered work.`);
  }
}

export class DeliveryCancelledError extends Error {
  override name = "DeliveryCancelledError";
  constructor(readonly correlationId: string) {
    super(`Correlation '${correlationId}' was cancelled.`);
  }
}

export class SettlementMonitor {
  readonly #store: EventStore;
  #generation = 0;
  #waiters = new Set<() => void>();

  constructor(store: EventStore) {
    this.#store = store;
  }

  wake(): void {
    this.#generation++;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  async wait(
    namespace: string,
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const generation = this.#generation;
      const settlement = await this.#store.correlationSettlement(
        namespace,
        correlationId,
      );
      if (settlement.deadLetters > 0) throw new DeadLetterError(correlationId);
      if (settlement.cancelled > 0) {
        throw new DeliveryCancelledError(correlationId);
      }
      if (settlement.unsettled === 0) return;
      if (generation !== this.#generation) continue;
      await this.#nextWake(signal);
    }
  }

  #nextWake(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.#waiters.delete(wake);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const aborted = () => {
        cleanup();
        reject(signal?.reason);
      };
      this.#waiters.add(wake);
      signal?.addEventListener("abort", aborted, { once: true });
      // Database changes made by a remote worker may not share this monitor.
      const timer = setTimeout(wake, 250);
    });
  }
}
