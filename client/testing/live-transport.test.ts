import type { SubscriptionTransport } from "../live-query.ts";
import type { CollectionRecord } from "../../runtime/collections/types.ts";
import type { SubscriptionFrame } from "../../runtime/subscriptions/types.ts";
import { SubscriptionQueue } from "../../runtime/subscriptions/device.ts";
import { readKey, type ReadRequest } from "../web/reads.ts";
export const tick = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
export const record = (
  row: { id: string; [key: string]: unknown },
): CollectionRecord => ({
  namespace: "main",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  ...row,
});
/** Test transport supplies owner frames, never another live-read reducer. */
export class MemorySubscriptions implements SubscriptionTransport {
  private listeners = new Map<
    string,
    Set<SubscriptionQueue<SubscriptionFrame>>
  >();
  private snapshots = new Map<string, SubscriptionFrame>();
  private key(read: ReadRequest) {
    return readKey({
      collection: read.collection,
      ...(read.progressOnly ? { progressOnly: true } : {}),
      query: read.id === undefined
        ? read.query ?? {}
        : { where: { id: read.id }, limit: 1 },
    });
  }
  async observe(
    collection: string,
    query: Parameters<SubscriptionTransport["observe"]>[1],
    options: Parameters<SubscriptionTransport["observe"]>[2],
  ) {
    await Promise.resolve();
    const key = this.key({
      collection,
      query,
      progressOnly: options.progressOnly,
    });
    const queue = new SubscriptionQueue<SubscriptionFrame>();
    const listeners = this.listeners.get(key) ?? new Set();
    this.listeners.set(key, listeners);
    listeners.add(queue);
    const snapshot = this.snapshots.get(key);
    if (snapshot) queue.push(structuredClone(snapshot));
    const detach = () => {
      listeners.delete(queue);
      queue.end();
      options.signal?.removeEventListener("abort", detach);
    };
    options.signal?.addEventListener("abort", detach, { once: true });
    return { frames: queue, detach };
  }
  async publish(read: ReadRequest, frame: SubscriptionFrame) {
    const key = this.key(read);
    if (frame.t === "snapshot") this.snapshots.set(key, structuredClone(frame));
    else this.snapshots.delete(key);
    for (const queue of this.listeners.get(key) ?? []) {
      queue.push(structuredClone(frame));
    }
    await tick();
  }
  async fail(read: ReadRequest) {
    for (const queue of this.listeners.get(this.key(read)) ?? []) {
      queue.end(new Error("Disconnected"));
    }
    await tick();
  }
  get subscriptions() {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}
