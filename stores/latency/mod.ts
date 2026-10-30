/**
 * Wraps any store with a simulated database round trip, to see what a turn
 * costs at production latency. Every read is one round trip, and so is every
 * transaction commit (one statement), plus each read inside it.
 */
import type { Reader, Store } from "../../runtime/store.ts";

export function withLatency(store: Store, ms: number): Store {
  let trips = 0;
  const trip = async () => {
    trips++;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  };
  const reads = <R extends Reader>(reader: R): R => ({
    ...reader,
    find: async (...args) => (await trip(), reader.find(...args)),
    findOne: async (...args) => (await trip(), reader.findOne(...args)),
    count: async (...args) => (await trip(), reader.count(...args)),
    aggregate: async (...args) => (await trip(), reader.aggregate(...args)),
    edges: async (...args) => (await trip(), reader.edges(...args)),
    blob: async (...args) => (await trip(), reader.blob(...args)),
    events: async (...args) => (await trip(), reader.events(...args)),
    related: async (...args) => (await trip(), reader.related(...args)),
  });
  return {
    ...reads(store),
    open: async () => (await trip(), store.open()),
    transaction: (epoch, work, options) =>
      store.transaction(epoch, async (tx) => {
        const result = await work(reads(tx));
        await trip();
        return result;
      }, options),
    positions: async () => (await trip(), store.positions()),
    ...(store.command
      ? {
        command: (epoch: number, command: Parameters<NonNullable<Store["command"]>>[1]) => {
          const run = store.command!(epoch, command);
          return run && trip().then(() => run);
        },
      }
      : {}),
    describe: store.describe?.bind(store),
    index: store.index?.bind(store),
    ...("inspect" in store ? { inspect: (store as { inspect: unknown }).inspect } : {}),
    roundTrips: () => trips,
    close: () => store.close(),
  };
}
