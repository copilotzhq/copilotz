/**
 * What the rules work out, kept (`ReadContext.kept`). A rule runs on every op
 * an actor's work makes, and much of what it works out (who reaches what)
 * comes from data that changes rarely: memberships, spaces. The owner keeps
 * each answer by its key with what it read (each read's collection and
 * filter), and lets it go when a commit changes a document one of those reads
 * matched, before or after: exactly when it could have changed, as an
 * observed View runs again. So an agent's thousand ops in a turn work out its
 * reach once.
 *
 * - **Nested:** work that asks for another kept answer (an agent's reach asks
 *   for its person's) reads what that one read, kept or not, so a change to
 *   the person's memberships lets both go.
 * - **Followed:** a View observed for an actor reads what the rules read for
 *   it, kept or not, so it follows its reach as it changes.
 * - **Racing a commit:** work that read a collection a commit changed while it
 *   ran answers its caller, but isn't kept. Work asked for again while it runs
 *   is shared.
 * - **Bounded:** the least recently used answers go past `max` (1,000).
 *   Maintenance SQL, which may have changed anything, lets everything go.
 */
import { matches } from "./mongo.ts";
import type { Dep } from "./observe.ts";
import type { Change } from "./store.ts";

type Entry = {
  value: Promise<unknown>;
  /** What the work read, as it reads it. */
  deps: Dep[];
};

/** Whether a change could change what `dep` read: the document matched its filter, before or after. */
const touches = (dep: Dep, changes: Change[]) =>
  !dep.filter || !Object.keys(dep.filter).length ||
  changes.some(({ before, after }) =>
    (before && matches(before, dep.filter)) || (after && matches(after, dep.filter))
  );

export type Kept = ReturnType<typeof createKept>;

export function createKept(options: { max?: number } = {}) {
  const max = options.max ?? 1_000;
  const entries = new Map<string, Entry>();
  /** Keys by the collections their work read. */
  const readers = new Map<string, Set<string>>();
  /** Commits so far, and the last one that changed each collection (or let everything go). */
  let commits = 0;
  let cleared = 0;
  const changedAt = new Map<string, number>();
  let hits = 0;
  let misses = 0;

  const forget = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    for (const dep of entry.deps) readers.get(dep.collection)?.delete(key);
  };

  return {
    /**
     * The answer kept under `key`, or `work`'s, kept: `work` reads through
     * `read`, which hears each of its reads (and passes them to `track`,
     * if given: what's working it out follows them too).
     */
    async get<T>(
      key: string,
      work: (track: (dep: Dep) => void) => Promise<T>,
      track?: (dep: Dep) => void,
    ): Promise<T> {
      const found = entries.get(key);
      if (found) {
        hits++;
        // The most recently used goes last.
        entries.delete(key);
        entries.set(key, found);
        const value = await found.value as T;
        if (track) { for (const dep of found.deps) track(dep); }
        return value;
      }
      misses++;
      const started = commits;
      const deps: Dep[] = [];
      const entry: Entry = { value: Promise.resolve(), deps };
      entries.set(key, entry);
      entry.value = work((dep) => {
        deps.push(dep);
        track?.(dep);
      });
      if (entries.size > max) forget(entries.keys().next().value!);
      let value: T;
      try {
        value = await entry.value as T;
      } catch (error) {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      }
      if (entries.get(key) !== entry) return value;
      // A commit since it began changed something it read: it may be older than that.
      const stale = cleared > started ||
        deps.some((dep) => (changedAt.get(dep.collection) ?? 0) > started);
      if (stale) {
        entries.delete(key);
        return value;
      }
      for (const dep of deps) {
        if (!readers.has(dep.collection)) readers.set(dep.collection, new Set());
        readers.get(dep.collection)!.add(key);
      }
      return value;
    },

    /** A commit's changes, by collection: what read a document they touch goes. */
    changed(seen: [string, Change[]][]) {
      if (!seen.length) return;
      commits++;
      for (const [collection, changes] of seen) {
        if (!changes.length) continue;
        changedAt.set(collection, commits);
        const keys = readers.get(collection);
        if (!keys?.size) continue;
        for (const key of [...keys]) {
          const deps = entries.get(key)?.deps ?? [];
          if (deps.some((dep) => dep.collection === collection && touches(dep, changes))) {
            forget(key);
          }
        }
      }
    },

    /** Anything may have changed (maintenance SQL): everything goes, and work running isn't kept. */
    clear() {
      cleared = ++commits;
      entries.clear();
      readers.clear();
    },

    stats: () => ({ hits, misses, size: entries.size }),
  };
}
