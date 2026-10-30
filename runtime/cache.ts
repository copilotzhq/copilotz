/**
 * The owner's read cache. The owner is the only writer, so every change
 * passes through it, and what it caches is kept exactly up to date:
 * - documents by `_id`, filled by reads and by every committed write;
 * - query results (`find` with filter, sort and limit, and `count`), updated
 *   from each committed change with the reference semantics (mongo.ts).
 *
 * When a change can't be applied exactly, the query is dropped and the next
 * read fetches it again: a sort key changed, a limited result lost a member,
 * or an existing document newly matched among ties. Queries with `skip`, or
 * that compare whole objects or arrays, are never cached.
 */
import { compareBy, get, matches } from "./mongo.ts";
import { canonical } from "./registry.ts";
import type { Change, Doc, Filter, FindOptions } from "./store.ts";

type Find = { collection: string; filter: Filter; options: FindOptions; docs: Doc[] };
type Count = { collection: string; filter: Filter; count: number };

export type Cache = ReturnType<typeof createCache>;

/** Filters the cache can evaluate exactly like every store does. */
function evaluable(filter: unknown): boolean {
  if (Array.isArray(filter)) return filter.every(evaluable);
  if (filter === null || typeof filter !== "object") return true;
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$in" || key === "$nin") {
      return Array.isArray(value) && value.every((v) => v === null || typeof v !== "object");
    }
    if (key.startsWith("$")) return evaluable(value);
    // A plain object or array compares as a whole, which depends on key order.
    if (value !== null && typeof value === "object") {
      return !Array.isArray(value) && Object.keys(value).every((k) => k.startsWith("$")) &&
        evaluable(value);
    }
    return true;
  });
}

const supported = (filter: Filter) => {
  if (!evaluable(filter)) return false;
  try {
    matches({}, filter);
    return true;
  } catch {
    return false; // An operator the reference does not implement.
  }
};

export function createCache(
  options: {
    documents?: number;
    queries?: number;
    /** Hears each read: answered here (hit) or passed to the store (miss). */
    onRead?: (hit: boolean) => void;
  } = {},
) {
  const maxDocuments = options.documents ?? 10_000;
  const onRead = options.onRead;
  const maxQueries = options.queries ?? 1_000;
  const documents = new Map<string, Doc | null>();
  const finds = new Map<string, Find>();
  const counts = new Map<string, Count>();
  /** Aggregates, kept until their collection changes. */
  const aggregates = new Map<string, { collection: string; docs: Doc[] }>();
  const generations = new Map<string, number>();
  let hits = 0;
  let misses = 0;

  const docKey = (collection: string, id: string) => `${collection}\u0000${id}`;
  // Maps keep insertion order: re-inserting on use makes the first entry the least recent.
  const touch = <V>(map: Map<string, V>, key: string, value: V, max: number) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > max) map.delete(map.keys().next().value!);
  };
  const generation = (collection: string) => generations.get(collection) ?? 0;

  const remember = (collection: string, doc: Doc | null, id: string) =>
    touch(documents, docKey(collection, id), doc, maxDocuments);

  return {
    async find(
      collection: string,
      filter: Filter,
      options: FindOptions,
      load: () => Promise<Doc[]>,
    ): Promise<Doc[]> {
      const id = typeof filter._id === "string" ? filter._id : undefined;
      if (id !== undefined && !options.skip && supported(filter)) {
        const key = docKey(collection, id);
        if (documents.has(key)) {
          hits++;
          onRead?.(true);
          const doc = documents.get(key)!;
          touch(documents, key, doc, maxDocuments);
          return doc && matches(doc, filter) && options.limit !== 0 ? [doc] : [];
        }
      }
      const key = canonical(["find", collection, filter, options]);
      const cached = finds.get(key);
      if (cached) {
        hits++;
        onRead?.(true);
        touch(finds, key, cached, maxQueries);
        return [...cached.docs];
      }
      misses++;
      onRead?.(false);
      const before = generation(collection);
      const docs = await load();
      // A commit landed while this read was in flight: its result may be older.
      if (generation(collection) !== before) return docs;
      for (const doc of docs) remember(collection, doc, doc._id);
      if (id !== undefined && !docs.length && Object.keys(filter).length === 1) {
        remember(collection, null, id);
      }
      if (!options.skip && supported(filter)) {
        touch(finds, key, { collection, filter, options, docs: [...docs] }, maxQueries);
      }
      return docs;
    },

    async count(collection: string, filter: Filter, load: () => Promise<number>) {
      const key = canonical(["count", collection, filter]);
      const cached = counts.get(key);
      if (cached) {
        hits++;
        onRead?.(true);
        touch(counts, key, cached, maxQueries);
        return cached.count;
      }
      misses++;
      onRead?.(false);
      const before = generation(collection);
      const count = await load();
      if (generation(collection) === before && supported(filter)) {
        touch(counts, key, { collection, filter, count }, maxQueries);
      }
      return count;
    },

    async aggregate(collection: string, pipeline: unknown, load: () => Promise<Doc[]>) {
      const key = canonical(["aggregate", collection, pipeline]);
      const cached = aggregates.get(key);
      if (cached) {
        hits++;
        onRead?.(true);
        touch(aggregates, key, cached, maxQueries);
        return cached.docs;
      }
      misses++;
      onRead?.(false);
      const before = generation(collection);
      const docs = await load();
      if (generation(collection) === before) {
        touch(aggregates, key, { collection, docs }, maxQueries);
      }
      return docs;
    },

    /** Applies committed changes to everything cached for the collection. */
    apply(collection: string, changes: Change[]) {
      if (!changes.length) return;
      generations.set(collection, generation(collection) + 1);
      for (const [key, query] of aggregates) {
        if (query.collection === collection) aggregates.delete(key);
      }
      for (const change of changes) remember(collection, change.after, change._id);
      for (const [key, query] of finds) {
        if (query.collection === collection && !update(query, changes)) finds.delete(key);
      }
      for (const query of counts.values()) {
        if (query.collection !== collection) continue;
        for (const { before, after } of changes) {
          query.count += Number(Boolean(after && matches(after, query.filter))) -
            Number(Boolean(before && matches(before, query.filter)));
        }
      }
    },

    stats: () => ({ hits, misses }),
  };
}

/** Applies changes to a cached result; false when it can't be done exactly. */
function update(query: Find, changes: Change[]): boolean {
  const { filter, options } = query;
  const order = compareBy(options.sort);
  const docs = query.docs;
  const sortKeys = (doc: Doc) => canonical(Object.keys(options.sort ?? {}).map((f) => get(doc, f)));
  for (const { _id, before, after } of changes) {
    const at = docs.findIndex((doc) => doc._id === _id);
    const now = Boolean(after && matches(after, filter));
    if (at >= 0 && !now) {
      // With a full page, the next match beyond it is unknown.
      if (options.limit !== undefined && docs.length >= options.limit) return false;
      docs.splice(at, 1);
    } else if (at >= 0 && now) {
      if (sortKeys(docs[at]) !== sortKeys(after!)) return false;
      docs[at] = after!;
    } else if (now) {
      // An existing document's place among ties depends on when it was first written.
      if (before) return false;
      // A new document comes last among equal sort keys, like insertion order in the stores.
      let place = docs.findIndex((doc) => order(doc, after) > 0);
      if (place < 0) place = docs.length;
      if (options.limit !== undefined && place >= options.limit) continue;
      docs.splice(place, 0, after!);
      if (options.limit !== undefined && docs.length > options.limit) docs.pop();
    }
  }
  return true;
}
