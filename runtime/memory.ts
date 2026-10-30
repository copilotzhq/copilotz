/**
 * In-memory storage adapter. Executes the MongoDB API in JavaScript. Fast and
 * dependency-free for local iteration; nothing survives the process.
 */
import { aggregate } from "./aggregate.ts";
import {
  type Blob,
  type Change,
  cosine,
  type Doc,
  type Edge,
  type Event,
  fenced,
  type Filter,
  type FindOptions,
  type Reader,
  type Store,
  type Transaction,
  type Vector,
} from "./store.ts";
import { applyUpdate, check, matches, seedOf, sortAndPage } from "./mongo.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const edgeKey = (e: { from: string; type: string; to: string }) =>
  `${e.from}\u0000${e.type}\u0000${e.to}`;

const duplicateKey = (collection: string, id: string) =>
  Object.assign(new Error(`Duplicate _id "${id}" in "${collection}"`), { code: "duplicate_key" });

export function memoryStore(): Store {
  const collections = new Map<string, Map<string, Doc>>();
  const edges = new Map<string, Edge>();
  const blobs = new Map<string, Blob>();
  // By collection, document and field.
  const vectors = new Map<string, Vector>();
  const vectorKey = (v: Pick<Vector, "collection" | "doc" | "field">) =>
    JSON.stringify([v.collection, v.doc, v.field]);
  const log: Event[] = [];
  let epoch = 0;
  const positions = new Map<string, number>();
  let queue = Promise.resolve();

  // A layer of pending changes over committed state; `null` marks a deletion.
  type Layer = {
    docs: Map<string, Map<string, Doc | null>>;
    edges: Map<string, Edge | null>;
    blobs: Map<string, Blob>;
    vectors: Map<string, Vector | null>;
    events: Omit<Event, "seq" | "at">[];
  };

  const reader = (layer?: Layer): Reader => {
    const docsOf = (collection: string): Doc[] => {
      const merged = new Map(collections.get(collection) ?? []);
      for (const [id, doc] of layer?.docs.get(collection) ?? []) {
        if (doc) merged.set(id, doc);
        else merged.delete(id);
      }
      return [...merged.values()];
    };
    const find = async (collection: string, filter: Filter = {}, options: FindOptions = {}) => {
      check(filter);
      return await Promise.resolve(
        sortAndPage(docsOf(collection).filter((doc) => matches(doc, filter)), options)
          .map((doc) => structuredClone(doc)),
      );
    };
    const vectorOf = (key: string) =>
      layer?.vectors.has(key) ? layer.vectors.get(key) ?? undefined : vectors.get(key);
    return {
      find,
      async nearest(collection, field, vector, options = {}) {
        const scored = (await find(collection, options.filter ?? {})).flatMap((doc) => {
          const found = vectorOf(vectorKey({ collection, doc: doc._id, field }));
          return found && found.embedding.length === vector.length
            ? [{ ...doc, _score: cosine(found.embedding, vector) }]
            : [];
        });
        // Stable: equal scores keep insertion order.
        return scored.sort((a, b) => b._score - a._score).slice(0, options.limit ?? 10);
      },
      findOne: async (collection, filter, options) =>
        (await find(collection, filter, { ...options, limit: 1 }))[0] ?? null,
      count: async (collection, filter) => (await find(collection, filter)).length,
      // The reference itself, over what the filter finds.
      aggregate: async (collection, plan) => aggregate(await find(collection, plan.match), plan),
      edges: (query) => {
        const merged = new Map(edges);
        for (const [key, edge] of layer?.edges ?? []) {
          if (edge) merged.set(key, edge);
          else merged.delete(key);
        }
        return Promise.resolve(
          [...merged.values()].filter((e) =>
            (!query.from || e.from === query.from) && (!query.type || e.type === query.type) &&
            (!query.to || e.to === query.to)
          ),
        );
      },
      blob: (id) => Promise.resolve(layer?.blobs.get(id) ?? blobs.get(id) ?? null),
      events: (after, limit = 1000) =>
        Promise.resolve(log.filter((e) => e.seq > after).slice(0, limit)),
      related: (id, types) =>
        Promise.resolve(
          log.filter((e) => (e.id === id || e.cause === id) && types.includes(e.type)),
        ),
    };
  };

  const transaction = (layer: Layer): Transaction => {
    const read = reader(layer);
    const staged = (collection: string) => {
      if (!layer.docs.has(collection)) layer.docs.set(collection, new Map());
      return layer.docs.get(collection)!;
    };
    const exists = async (collection: string, id: string) =>
      (await read.findOne(collection, { _id: id })) !== null;
    return {
      ...read,
      async insert(collection, docs, options = {}) {
        const changes: Change[] = [];
        for (const doc of docs) {
          if (await exists(collection, doc._id)) {
            if (options.ifAbsent) continue;
            throw duplicateKey(collection, doc._id);
          }
          staged(collection).set(doc._id, structuredClone(doc));
          changes.push({ _id: doc._id, before: null, after: structuredClone(doc) });
        }
        return { changes };
      },
      async update(collection, filter, update, options = {}) {
        const found = await read.find(collection, filter, options.many ? {} : { limit: 1 });
        const changes: Change[] = [];
        for (const doc of found) {
          const next = applyUpdate(doc, update);
          if (same(next, doc)) continue;
          staged(collection).set(doc._id, next);
          changes.push({ _id: doc._id, before: doc, after: structuredClone(next) });
        }
        if (found.length || !options.upsert) {
          return { matched: found.length, modified: changes.length, changes };
        }
        // Upsert: a new document, never one the filter didn't match.
        const seed = seedOf(filter);
        if (await exists(collection, seed._id)) throw duplicateKey(collection, seed._id);
        const created = applyUpdate(seed, update);
        staged(collection).set(seed._id, created);
        return {
          matched: 0,
          modified: 0,
          upsertedId: seed._id,
          changes: [{ _id: seed._id, before: null, after: structuredClone(created) }],
        };
      },
      async replace(collection, filter, doc, options = {}) {
        const current = await read.findOne(collection, filter);
        if (current) {
          const next = { ...structuredClone(doc), _id: current._id };
          if (same(next, current)) return { matched: 1, changes: [] };
          staged(collection).set(current._id, next);
          return {
            matched: 1,
            changes: [{ _id: current._id, before: current, after: structuredClone(next) }],
          };
        }
        if (!options.upsert) return { matched: 0, changes: [] };
        const id = seedOf(filter)._id;
        if (await exists(collection, id)) throw duplicateKey(collection, id);
        const created = { ...structuredClone(doc), _id: id };
        staged(collection).set(id, created);
        return {
          matched: 0,
          upsertedId: id,
          changes: [{ _id: id, before: null, after: structuredClone(created) }],
        };
      },
      async delete(collection, filter, options = {}) {
        const found = await read.find(collection, filter, options.many ? {} : { limit: 1 });
        for (const doc of found) staged(collection).set(doc._id, null);
        return {
          deleted: found.length,
          changes: found.map((doc) => ({ _id: doc._id, before: doc, after: null })),
        };
      },
      link(edge) {
        layer.edges.set(edgeKey(edge), structuredClone(edge));
        return Promise.resolve();
      },
      unlink(edge) {
        layer.edges.set(edgeKey(edge), null);
        return Promise.resolve();
      },
      putBlob(value) {
        layer.blobs.set(value.id, structuredClone(value));
        return Promise.resolve();
      },
      putVector(value) {
        layer.vectors.set(vectorKey(value), structuredClone(value));
        return Promise.resolve();
      },
      deleteVectors(collection, docs, field) {
        const ids = new Set(docs);
        for (const key of new Set([...vectors.keys(), ...layer.vectors.keys()])) {
          const [c, doc, f] = JSON.parse(key) as string[];
          if (c === collection && ids.has(doc) && (!field || f === field)) {
            layer.vectors.set(key, null);
          }
        }
        return Promise.resolve();
      },
      emit(event) {
        layer.events.push({ ...event, id: event.id ?? crypto.randomUUID() });
      },
    };
  };

  return {
    ...reader(),
    open() {
      epoch += 1;
      return Promise.resolve({ epoch });
    },
    positions: () => Promise.resolve(Object.fromEntries(positions)),
    transaction(owner, work, options = {}) {
      const run = async () => {
        if (owner !== epoch) throw fenced();
        const layer: Layer = {
          docs: new Map(),
          edges: new Map(),
          blobs: new Map(),
          vectors: new Map(),
          events: [],
        };
        const result = await work(transaction(layer));
        if (owner !== epoch) throw fenced();
        for (const [collection, docs] of layer.docs) {
          if (!collections.has(collection)) collections.set(collection, new Map());
          const target = collections.get(collection)!;
          for (const [id, doc] of docs) doc ? target.set(id, doc) : target.delete(id);
        }
        for (const [key, edge] of layer.edges) edge ? edges.set(key, edge) : edges.delete(key);
        for (const [id, value] of layer.blobs) blobs.set(id, value);
        for (const [key, value] of layer.vectors) {
          value ? vectors.set(key, value) : vectors.delete(key);
        }
        for (const [name, seq] of Object.entries(options.positions ?? {})) positions.set(name, seq);
        const at = new Date().toISOString();
        // An event id already in the log was committed by an earlier attempt.
        const committed = layer.events
          .filter((event) => !log.some((e) => e.id === event.id))
          .map((event, index) => ({ ...event, seq: log.length + 1 + index, at }));
        log.push(...committed);
        return { result, events: committed };
      };
      // One writer at a time, like the owner itself.
      const next = queue.then(run, run);
      queue = next.then(() => undefined, () => undefined);
      return next;
    },
    roundTrips: () => 0,
    close: () => Promise.resolve(),
  };
}
