/**
 * A map whose entries each last `ms` from when they're set (set again, from
 * then): past it, one is gone to `get` at once, and from memory within a
 * sweep. Every entry lasts as long, so they pass in the order they were set,
 * and a sweep stops at the first that hasn't: it never walks them all. Its
 * timer runs only while anything's kept, never keeps a process alive
 * (unref'd), and stops on `close`.
 *
 * What a host keeps a while: tickets, resume credentials, counts per minute.
 */

export type Expiring<K, V> = {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): void;
  /** How many are kept now, past ones the next sweep drops included. */
  size(): number;
  /** Drops them all, and stops its timer. */
  close(): void;
};

// deno-lint-ignore no-explicit-any
const g = globalThis as any;

/** A timer that never keeps the process alive: Node's and Bun's `unref`, Deno's `unrefTimer`. */
const unref = (timer: ReturnType<typeof setInterval>) => {
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  } else if (typeof timer === "number" && g.Deno?.unrefTimer) g.Deno.unrefTimer(timer);
};

/** Entries kept `ms` each; swept every `every` ms (`ms`, up to a minute, unless said). */
export function expiring<K, V>(ms: number, options: { every?: number } = {}): Expiring<K, V> {
  const kept = new Map<K, { value: V; until: number }>();
  const every = options.every ?? Math.min(ms, 60_000);
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const sweep = () => {
    const now = Date.now();
    for (const [key, entry] of kept) {
      if (entry.until > now) break;
      kept.delete(key);
    }
    if (!kept.size) stop();
  };
  return {
    get(key) {
      const entry = kept.get(key);
      return entry && entry.until > Date.now() ? entry.value : undefined;
    },
    set(key, value) {
      // Set again, it goes last: the order stays the order they pass in.
      kept.delete(key);
      kept.set(key, { value, until: Date.now() + ms });
      if (timer === undefined) unref(timer = setInterval(sweep, every));
    },
    delete(key) {
      kept.delete(key);
      if (!kept.size) stop();
    },
    size: () => kept.size,
    close() {
      kept.clear();
      stop();
    },
  };
}
