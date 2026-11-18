/**
 * Renders Views. A View reads synchronously: each read returns at once, as
 * `{ status: "loading" }` until its data arrives. After a pass the runtime
 * waits for the reads that were pending and runs the View again, until a pass
 * reads nothing new; that pass's output is the result. Repeated reads are
 * answered from this render's own cache (and the owner's), so a pass costs
 * little. Observed (observe.ts), the same Views run again when what they read
 * changes.
 */
import type { Pipeline } from "./aggregate.ts";
import type { DeleteResult, UpdateResult } from "./collection.ts";
import type { WriteOp } from "./ops.ts";
import type { Update } from "./store.ts";
import { canonical, invalid } from "./registry.ts";
import type {
  Read,
  ReadContext,
  Render,
  RenderOptions,
  ViewCollection,
  ViewContext,
  Views,
} from "./define.ts";

/** A View that keeps reading new things after this many passes is a bug, not slow data. */
export const PASSES = 25;

/** A run of a View: its reads by what they ask, and those still loading in this pass. */
/** One pass of a View over its reads; `passing` while its body runs (it doesn't write then). */
export type Pass = { slots: Map<string, Slot>; pending: Promise<void>[]; passing?: boolean };

/** How a View's handlers write a collection: as its viewer, from outside (see `ViewCollection`). */
export type Write = (op: WriteOp) => Promise<unknown>;
/** A read: how to ask it of a source, and where its answer is. */
type Slot = { ask: Ask; read: Read<unknown>; error?: unknown };
type Ask = (source: ReadContext) => Promise<unknown>;

/** Starts a read in `pass`: its slot is loading, and the pass waits for it. */
const load = (pass: Pass, id: string, ask: Ask, source: ReadContext): Slot => {
  const slot: Slot = { ask, read: { status: "loading" } };
  pass.slots.set(id, slot);
  pass.pending.push(
    ask(source).then(
      (value) => void (slot.read = { status: "ready", value }),
      (error) => void (slot.error = error),
    ),
  );
  return slot;
};

/**
 * Asks again, of `source`, what an earlier run read: a View run again finds
 * what it is likely to read already loaded, so it usually takes one pass.
 */
export const reread = (earlier: Pass["slots"], pass: Pass, source: ReadContext): void => {
  for (const [id, slot] of earlier) if (!pass.slots.has(id)) load(pass, id, slot.ask, source);
};

/** The first read that failed in a run, if one did. */
export const failure = (pass: Pass): { error: unknown } | undefined =>
  [...pass.slots.values()].find((slot): slot is Slot & { error: unknown } =>
    slot.error !== undefined
  );

/**
 * A View's collections over `source`: a read asked before in this run is
 * answered from it; a new one starts loading, and the pass waits for it.
 */
export function viewCollections(
  source: ReadContext,
  pass: Pass,
  write?: Write,
): ViewContext["db"] {
  // Handlers write; a View's body, or one rendered once (no handlers run), doesn't.
  const writing = (op: WriteOp) =>
    !write
      ? Promise.reject(invalid("Only a View being observed writes, from its handlers."))
      : pass.passing
      ? Promise.reject(invalid("A View writes from its handlers, never while it renders."))
      : write(op);
  const read = <T>(key: unknown[], ask: Ask): Read<T> => {
    const id = canonical(key);
    return (pass.slots.get(id) ?? load(pass, id, ask, source)).read as Read<T>;
  };
  const collection = <T>(name: string): ViewCollection<T> => {
    const from = (source: ReadContext) => source.db.collection<T>(name);
    return {
      find: (filter = {}, options = {}) =>
        read([name, "find", filter, options], (s) => from(s).find(filter, options).toArray()),
      findOne: (filter = {}, options = {}) =>
        read([name, "findOne", filter, options], (s) => from(s).findOne(filter, options)),
      countDocuments: (filter = {}) =>
        read([name, "count", filter], (s) => from(s).countDocuments(filter)),
      aggregate: <R>(pipeline: Pipeline) =>
        read([name, "aggregate", pipeline], (s) => from(s).aggregate<R>(pipeline)),
      nearest: (vector, options = {}) =>
        read([name, "nearest", vector, options], (s) => from(s).nearest(vector, options)),
      query: <R>(query: string, params?: unknown) =>
        read([name, "query", query, params ?? null], (s) => from(s).query<R>(query, params)),
      insertOne: (doc) =>
        writing({ op: "insert", collection: name, docs: [doc as never] }) as Promise<
          { acknowledged: true; insertedId: string }
        >,
      updateOne: (filter, update, { upsert } = {}) =>
        writing({
          op: "update",
          collection: name,
          filter,
          update: update as Update,
          options: upsert ? { upsert } : {},
        }) as Promise<UpdateResult>,
      replaceOne: (filter, doc, { upsert } = {}) =>
        writing({
          op: "replace",
          collection: name,
          filter,
          doc: doc as never,
          options: upsert ? { upsert } : {},
        }) as Promise<UpdateResult>,
      deleteOne: (filter) =>
        writing({ op: "delete", collection: name, filter, options: {} }) as Promise<
          DeleteResult
        >,
    };
  };
  return { collection };
}

/** Rendered once, a View has no handlers that could run: it calls nothing. */
const once = () =>
  Promise.reject(invalid("Only a View being observed calls Actions, from its handlers."));

/** A Render over `views`, loading data through `reads` (a read-only context). */
export function presenter(views: Views, reads: () => ReadContext): Render {
  return async (name, item, options: RenderOptions = {}) => {
    const view = views[name];
    if (!view) return undefined;
    const source = reads();
    const pass: Pass = { slots: new Map(), pending: [] };
    const db = viewCollections(source, pass);

    const context = (name: string, hints: Record<string, unknown>): ViewContext => ({
      db,
      resources: source.resources,
      describe: source.describe,
      name,
      ...(options.viewer ? { viewer: options.viewer } : {}),
      ...(source.actor ? { actor: source.actor } : {}),
      ...(source.in !== undefined ? { in: source.in } : {}),
      hints,
      show: (name, item, hints = {}) => views[name]?.(item, context(name, hints)),
      call: once,
      emit: once,
    });

    for (let round = 1;; round++) {
      pass.pending = [];
      const output = view(item, context(name, options.hints ?? {}));
      if (!pass.pending.length) {
        const failed = failure(pass);
        if (failed) throw failed.error;
        return output;
      }
      if (round === PASSES) {
        throw invalid(`The View "${name}" kept making new reads.`);
      }
      await Promise.all(pass.pending);
    }
  };
}
