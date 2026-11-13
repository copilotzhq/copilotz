/**
 * Calls a minute on a public server, counted in this process's memory, of a
 * size that never grows: by the caller's address, and on the whole server.
 * A public server keeps nothing, its counts included: they're gone on
 * restart, and each runtime keeps its own (behind a directory, an org's).
 *
 * - **By address,** in a count-min sketch: `ROWS` rows of `CELLS` counters,
 *   each address counted in one cell of each row, picked by a hash with keys
 *   this process draws at random (so nobody outside can aim at another's
 *   cells). An address's count is the least of its cells: never less than
 *   the calls it made, more only when others' share every one of its cells.
 *   A cell goes up only when it's that least (a conservative update), so
 *   addresses sharing one count each other's calls as little as can be.
 *   However many addresses call, the memory is the same: `bytes`.
 * - **On the server:** one count.
 * - **Each minute** (the clock's, as every MCP limit) counts from nothing.
 *
 * Only calls taken count: one refused counts nowhere.
 */

/** Rows and cells of the sketch: 2 × 4096 counters, 32 KiB a public server. */
const ROWS = 2;
const CELLS = 4096;

/** How many calls a minute: from one address, and on the server. */
export type PerMinute = { address: number; all: number };

/** A minute's calls on one server. */
export type Minute = {
  /**
   * Takes one call from `address` (undefined when it isn't counted by address: one the front
   * exempts) when it's within both limits; else says which it's past, and counts nothing.
   */
  take(address: string | undefined, most: PerMinute, now?: number): "address" | "all" | undefined;
  /** The bytes it counts with: the same, however many addresses call. */
  readonly bytes: number;
};

/** A new count of a server's calls a minute, `cells` counters a row. */
export function perMinute(cells = CELLS): Minute {
  const counts = new Uint32Array(ROWS * cells);
  const keys = crypto.getRandomValues(new Uint32Array(ROWS));
  let minute = -1;
  let all = 0;
  const cellsOf = (address: string) =>
    Array.from(keys, (key, row) => row * cells + hash(address, key) % cells);
  return {
    bytes: counts.byteLength,
    take(address, most, now = Date.now()) {
      const current = Math.floor(now / 60_000);
      if (current !== minute) {
        minute = current;
        all = 0;
        counts.fill(0);
      }
      const at = address === undefined ? [] : cellsOf(address);
      const least = at.length ? Math.min(...at.map((i) => counts[i])) : 0;
      if (at.length && least >= most.address) return "address";
      if (all >= most.all) return "all";
      for (const i of at) if (counts[i] === least) counts[i] = least + 1;
      all++;
      return undefined;
    },
  };
}

/** A 32-bit hash of `text` under `key`: FNV-1a from the key, then mixed (MurmurHash3's finish). */
function hash(text: string, key: number): number {
  let h = (0x811c9dc5 ^ key) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Each runtime's public servers' minutes, by server: as many as the app declares. */
const minutes = new WeakMap<object, Map<string, Minute>>();

/** The minute of `line`'s calls in `runtime`. */
export function minuteOf(runtime: object, line: string): Minute {
  const lines = minutes.get(runtime) ?? new Map<string, Minute>();
  minutes.set(runtime, lines);
  let found = lines.get(line);
  if (!found) lines.set(line, found = perMinute());
  return found;
}
