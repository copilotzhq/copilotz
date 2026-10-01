import { createAsyncContextStorage } from "../../dependencies/async-hooks.ts";

/**
 * What one handler invocation (a "hop") has already learned about the rows it
 * reads, so it does not ask the database the same thing again.
 *
 * A hop is one delivery, or one live processor call, and everything it awaits.
 * It sees the state its reads first found, refreshed by this process's own
 * writes. Another process's write is seen by the next hop, or after
 * `READ_VIEW_TTL_MS`, whichever comes first. Writes stay compare-and-set, so a
 * stale view can never overwrite a newer row: the write is refused and the
 * retry reads again.
 */
export const READ_VIEW_TTL_MS = 2_000;
const MAX_TRACKED_KEYS = 10_000;

type Entry = { version: number; at: number; value: unknown };
type View = Map<string, Entry>;

/** What a reader needs of the current hop's view. */
export interface ReadMemo {
  /** The remembered value, still current, or undefined. `null` is a value. */
  recall<T>(key: string): { value: T } | undefined;
  /** Captures the write versions to compare against when the read returns. */
  begin(keys: readonly string[]): ReadTicket;
}

/** Proof of when a read started; a write since then voids what it found. */
export interface ReadTicket {
  remember(key: string, value: unknown): void;
}

export interface ReadViews {
  /** Runs one hop with a view of its own. */
  run<T>(operation: () => Promise<T>): Promise<T>;
  /** The current hop's view, or undefined outside a hop. */
  memo(): ReadMemo | undefined;
  /** This process changed the row; hops must read it again. */
  invalidate(key: string): void;
  /** This process changed rows it cannot enumerate; hops must read again. */
  invalidateAll(): void;
}

export function createReadViews(
  options: { ttlMs?: number; now?: () => number } = {},
): ReadViews {
  const ttlMs = options.ttlMs ?? READ_VIEW_TTL_MS;
  const now = options.now ?? (() => performance.now());
  const storage = createAsyncContextStorage<View>();
  const versions = new Map<string, number>();
  let floor = 0;
  let sequence = 0;
  const versionOf = (key: string) => Math.max(versions.get(key) ?? 0, floor);

  const memo = (): ReadMemo | undefined => {
    const view = storage.getStore();
    if (!view) return undefined;
    return {
      recall<T>(key: string) {
        const entry = view.get(key);
        if (!entry) return undefined;
        if (
          entry.version !== versionOf(key) ||
          now() - entry.at > ttlMs
        ) {
          view.delete(key);
          return undefined;
        }
        return { value: structuredClone(entry.value) as T };
      },
      begin(keys) {
        const started = now();
        const seen = new Map(keys.map((key) => [key, versionOf(key)]));
        return {
          remember(key, value) {
            const version = seen.get(key);
            if (version === undefined || version !== versionOf(key)) return;
            view.set(key, {
              version,
              at: started,
              value: structuredClone(value),
            });
          },
        };
      },
    };
  };

  const invalidateAll = () => {
    floor = ++sequence;
    versions.clear();
  };

  return {
    run: (operation) => storage.run(new Map(), operation),
    memo,
    invalidate(key) {
      versions.set(key, ++sequence);
      if (versions.size > MAX_TRACKED_KEYS) invalidateAll();
    },
    invalidateAll,
  };
}

/** One per process: a write anywhere in it is seen by every hop in it. */
export const readViews: ReadViews = createReadViews();

/** A row's identity across schemas, namespaces and collections. */
export function readViewKey(...parts: readonly string[]): string {
  return parts.join("\u0000");
}
