/**
 * Runtimes by id, each opened on its first use and closed once it's idle:
 * what an app serving many runtimes behind one address keeps (a directory's
 * orgs, see plugins/access/directory). The app says how to open one
 * (`open(id)`: its store, its plugins; undefined when there's no such one),
 * and the pool does the rest:
 *
 * - `get(id)` opens it the first time, and hands the same one after (a
 *   failed opening is tried again on the next `get`);
 * - one with no browsers and nothing pending for `idleMs` since its last
 *   `get` (30 minutes unless said) closes, and opens again on its next use;
 * - `close(id)` closes one now (staff moving its rows), and `close()` all of
 *   them, for good. A `get` while one closes opens it again only once it has
 *   closed: two runtimes of one id never run at once, so its store has one
 *   writer.
 *
 * ```ts
 * const orgs = runtimes(async (id) => {
 *   const org = await dir.query("org.info", { org: id });
 *   return org ? await createRuntime({ store: await storeOf(org), plugins: [...app, member(dir, org)] }) : undefined;
 * }, { idleMs: 30 * 60_000 });
 * ```
 */
import type { Runtime } from "./runtime.ts";

/** Runtimes by id, opened when first used and closed when idle. */
export type Runtimes = {
  /** The runtime of `id`, opened if it isn't; undefined when `open` says there's none. */
  get(id: string): Promise<Runtime | undefined>;
  /** The runtime of `id` if it's open now: never opens it (or counts as its use). */
  peek(id: string): Runtime | undefined;
  /** Every runtime open now, by id. */
  entries(): [string, Runtime][];
  /**
   * Closes the runtime of `id` (each giving its running work `drain` ms, see
   * `Runtime.close`); without an id, every one, and the pool opens no more.
   */
  close(id?: string, options?: { drain?: number }): Promise<void>;
};

/** How long a runtime nobody uses stays open, unless said: 30 minutes. */
const IDLE_MS = 30 * 60_000;

export function runtimes(
  open: (id: string) => Promise<Runtime | undefined>,
  options: { idleMs?: number } = {},
): Runtimes {
  const idleMs = options.idleMs ?? IDLE_MS;
  if (!(typeof idleMs === "number" && idleMs > 0)) {
    throw new Error("runtimes: idleMs is a number of milliseconds over 0");
  }
  /** Each one opening or open, by id. */
  const cells = new Map<string, Promise<Runtime | undefined>>();
  /** Each one open now, and when it was last used. */
  const live = new Map<string, { runtime: Runtime; last: number }>();
  /** Each one closing, by id: a `get` waits for it before opening another. */
  const closing = new Map<string, Promise<void>>();
  let stopped = false;

  const closeOne = (id: string, drain?: { drain?: number }): Promise<void> => {
    const cell = cells.get(id);
    if (!cell) return closing.get(id) ?? Promise.resolve();
    cells.delete(id);
    // Closing, it's no longer anyone's to use.
    live.delete(id);
    const done = (async () => {
      const runtime = await cell.catch(() => undefined);
      await runtime?.close(drain).catch(() => {});
    })();
    closing.set(id, done);
    return done.finally(() => {
      if (closing.get(id) === done) closing.delete(id);
    });
  };

  // Closes what's idle: unused for `idleMs`, no browsers, nothing pending. It never keeps the
  // process alive by itself.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, { runtime, last }] of live) {
      if (now - last <= idleMs) continue;
      const { browsers, pending } = runtime.stats();
      if (browsers === 0 && pending === 0) void closeOne(id);
    }
  }, Math.max(10, Math.min(idleMs, 60_000)));
  (sweep as { unref?: () => void }).unref?.();

  return {
    get(id) {
      if (stopped) return Promise.reject(new Error("runtimes: closed"));
      const kept = live.get(id);
      if (kept) kept.last = Date.now();
      let cell = cells.get(id);
      if (!cell) {
        const made: Promise<Runtime | undefined> = (closing.get(id) ?? Promise.resolve())
          .then(() => open(id))
          .then((runtime) => {
            // Closed while it opened: `close` closes it once it's here.
            if (cells.get(id) !== made) return runtime;
            if (runtime) live.set(id, { runtime, last: Date.now() });
            else cells.delete(id);
            return runtime;
          });
        cell = made;
        cells.set(id, cell);
        cell.catch(() => {
          if (cells.get(id) === made) cells.delete(id);
        });
      }
      return cell;
    },
    peek: (id) => live.get(id)?.runtime,
    entries: () => [...live].map(([id, { runtime }]) => [id, runtime]),
    async close(id, drain) {
      if (id !== undefined) return await closeOne(id, drain);
      stopped = true;
      clearInterval(sweep);
      await Promise.all([...cells.keys()].map((one) => closeOne(one, drain)));
      await Promise.all([...closing.values()]);
    },
  };
}
