/**
 * A runtime is one owner and its executors, composed with Oxian. By default
 * they share this process over Oxian's in-process transport. The same owner
 * and executors run in separate processes over its WebSocket transport.
 */
import { createExecutor } from "./executor.ts";
import { createOwner, type Owner, type Transport } from "./owner.ts";
import type { Blobs } from "./blobs.ts";
import type { Plugins } from "./define.ts";
import type { Actor, Store } from "./store.ts";
import type { Metrics } from "./metrics.ts";
import type { Clock } from "./schedules.ts";
import { merge } from "./registry.ts";

export type Runtime = Owner;

export async function createRuntime(
  options: {
    store: Store;
    plugins: Plugins;
    /** Executors in this process (default 1). */
    executors?: number;
    /** More ways for executors to connect, for example Oxian's WebSocket transport. */
    transports?: Transport[];
    /** The key remote executors must present. */
    key?: string;
    /** Where large values live; by default, in the store itself. */
    blobs?: Blobs;
    /** Strings over this many bytes become blobs (default 16 KiB). */
    blobThreshold?: number;
    /** The owner's read cache size, or false to read the store every time. */
    cache?: { documents?: number; queries?: number } | false;
    /** Where the owner and these executors record metrics (`createMetrics`). */
    metrics?: Metrics;
    /** What timers run on: the system's by default, `manualClock` in tests. */
    clock?: Clock;
    /**
     * Who a browser is, from what it presents when it connects (a one-time
     * ticket the host issued); undefined refuses it. Without it, no browsers.
     */
    admit?(secret: string): Actor | undefined | Promise<Actor | undefined>;
  },
): Promise<Runtime> {
  const transport = {
    type: "in-process",
    config: { topic: `copilotz.${crypto.randomUUID()}` },
  } as const;
  // With browsers or a plugin's workers admitted, everyone shows something: these executors, the key.
  const others = !!options.admit || Object.keys(merge(options.plugins).workers).length > 0;
  const key = options.key ?? (others ? crypto.randomUUID() : undefined);
  const owner = await createOwner({
    store: options.store,
    plugins: options.plugins,
    transports: [transport, ...options.transports ?? []],
    key,
    ...(options.admit ? { admit: options.admit } : {}),
    blobs: options.blobs,
    blobThreshold: options.blobThreshold,
    cache: options.cache,
    metrics: options.metrics,
    clock: options.clock,
  });
  const executors = Array.from(
    { length: options.executors ?? 1 },
    (_, i) =>
      createExecutor({
        plugins: options.plugins,
        transport,
        id: `executor-${i}`,
        metrics: options.metrics,
        ...(others ? { key } : {}),
      }),
  );
  await Promise.all(executors.map((executor) => executor.ready));
  return {
    ...owner,
    async close() {
      await owner.close();
      await Promise.all(executors.map((executor) => executor.stop()));
    },
  };
}
