/**
 * Every storage operation a plugin can make, as plain data. Executors send
 * them to the owner; the owner performs each against its store. One collection
 * call is one op.
 */
import { type Pipeline, plan } from "./aggregate.ts";
import type {
  Actor,
  Change,
  Doc,
  Edge,
  Filter,
  FindOptions,
  Reader,
  Transaction,
  Update,
} from "./store.ts";

export type ReadOp =
  | { op: "find"; collection: string; filter: Filter; options: FindOptions }
  | { op: "findOne"; collection: string; filter: Filter; options: FindOptions }
  | { op: "count"; collection: string; filter: Filter }
  | { op: "aggregate"; collection: string; pipeline: Pipeline }
  | { op: "edges"; query: { from?: string; type?: string; to?: string } }
  | {
    op: "nearest";
    collection: string;
    /** The vector field; the owner fills it in when the collection has one. */
    field?: string;
    vector: number[];
    options: { filter?: Filter; limit?: number };
  }
  | { op: "outcome"; call: string };

export type WriteOp =
  | {
    op: "insert";
    collection: string;
    docs: Doc[];
    /** Leaves documents whose `_id` exists as they are (records collections). */
    ifAbsent?: boolean;
  }
  | {
    op: "update";
    collection: string;
    filter: Filter;
    update: Update;
    options: { many?: boolean; upsert?: boolean };
  }
  | {
    op: "replace";
    collection: string;
    filter: Filter;
    doc: Omit<Doc, "_id">;
    options: { upsert?: boolean };
  }
  | { op: "delete"; collection: string; filter: Filter; options: { many?: boolean } }
  | { op: "link"; edge: Edge }
  | { op: "unlink"; edge: Omit<Edge, "data"> }
  | {
    op: "emit";
    event: {
      id?: string;
      type: string;
      data: Record<string, unknown>;
      cause?: string;
      actor?: Actor;
    };
  };

/**
 * Timers (see schedules.ts): the owner, whose clock they run on, turns them
 * into writes to `sys.timers` before anything else sees them.
 */
export type TimerOp =
  | {
    op: "schedule";
    timer: string;
    call: string;
    input?: unknown;
    when: { at?: unknown; cron?: unknown; timezone?: unknown; every?: unknown; retries?: unknown };
  }
  | { op: "unschedule"; timer: string };

/** What a store performs: reads and writes. */
export type StoreOp = ReadOp | WriteOp;

/** Stops work the owner sent out: an Action call by id, or what a Processor runs for a key. */
export type CancelOp =
  | { op: "cancel"; call: string }
  | { op: "cancel"; processor: string; key: string };

/** Ends an actor's browsers (see `Owner.disconnect`): a person's, or one key of theirs (`key`). */
export type DisconnectOp = { op: "disconnect"; actor: { kind: string; id: string; key?: string } };

export type Op = StoreOp | TimerOp | CancelOp | DisconnectOp;

const READS = new Set<Op["op"]>([
  "find",
  "findOne",
  "count",
  "aggregate",
  "edges",
  "nearest",
  "outcome",
]);

export const isRead = (op: Op): op is ReadOp => READS.has(op.op);

/** Runs a read against committed state, or inside a transaction against its own writes. */
export function read(reader: Reader, op: ReadOp): Promise<unknown> {
  switch (op.op) {
    case "find":
      return reader.find(op.collection, op.filter, op.options);
    case "findOne":
      return reader.findOne(op.collection, op.filter, op.options);
    case "count":
      return reader.count(op.collection, op.filter);
    case "aggregate":
      return reader.aggregate(op.collection, plan(op.pipeline));
    case "edges":
      return reader.edges(op.query);
    case "nearest":
      return reader.nearest(op.collection, op.field!, op.vector, op.options);
    case "outcome":
      return outcome(reader, op.call);
  }
}

/**
 * What the log knows about an action call: whether it completed (and its
 * result), how many attempts it had, and whether the last one was lost (it
 * started but recorded no outcome). The log is the receipt store.
 */
export type Outcome = {
  completed: boolean;
  result?: unknown;
  attempts: number;
  lost: boolean;
  /** What the call was, from its start: to refuse an id reused for another call. */
  action?: string;
  inputHash?: string;
};

/**
 * Results whose private fields the log leaves out (see `ActionDef.private`),
 * whole, by call id: what a retry of the call answers with.
 */
export const RESULTS = "sys.results";

export async function outcome(reader: Reader, call: string): Promise<Outcome> {
  const events = await reader.related(call, [
    "action.started",
    "action.retried",
    "action.completed",
    "action.failed",
  ]);
  const count = (type: string) => events.filter((e) => e.type === type).length;
  const done = events.find((e) => e.type === "action.completed");
  const started = events.find((e) => e.id === call);
  const attempts = started ? 1 + count("action.retried") : 0;
  // One with private fields is kept whole apart; erased there, the log's is what's left.
  const result = done?.data.private
    ? (await reader.findOne(RESULTS, { _id: call }))?.result ?? done.data.result
    : done?.data.result;
  return {
    completed: Boolean(done),
    ...(done ? { result } : {}),
    attempts,
    lost: attempts > count("action.failed") + (done ? 1 : 0),
    ...(started
      ? { action: String(started.data.action), inputHash: started.data.inputHash as string }
      : {}),
  };
}

/** Whether two dot paths meet: one is the other, or lies within it. */
const meet = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/** Field references in an expression or a pipeline (`"$total"`, `"$assign.code"`), as paths. */
function refs(value: unknown, into: string[]): string[] {
  if (typeof value === "string") {
    if (/^\$[^$]/.test(value)) into.push(value.slice(1));
  } else if (Array.isArray(value)) { for (const item of value) refs(item, into); }
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) refs(item, into);
  }
  return into;
}

/** The field paths a filter names: its keys, through `$and`, `$or` and `$nor`, and its references. */
function filterPaths(filter: unknown, into: string[] = []): string[] {
  if (!filter || typeof filter !== "object") return into;
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" || key === "$or" || key === "$nor") {
      for (const each of [value].flat()) filterPaths(each, into);
    } else if (key.startsWith("$")) refs(value, into);
    else into.push(key);
  }
  return into;
}

/** Whether a document holds a value at a dot path. */
function holds(doc: unknown, path: string): boolean {
  let at = doc;
  for (const key of path.split(".")) {
    if (!at || typeof at !== "object" || !Object.hasOwn(at, key)) return false;
    at = (at as Record<string, unknown>)[key];
  }
  return true;
}

/**
 * The first of a collection's private fields (dot paths) an op names: in
 * its filter, sort, update or pipeline (filtering by one tells of its
 * value; changing what holds one changes it), or in a document it writes.
 * What an outsider may never do (see `CollectionDef.private`).
 */
export function privateIn(op: StoreOp, fields: string[]): string | undefined {
  if (!fields.length || !("collection" in op)) return undefined;
  const paths: string[] = [];
  const docs: unknown[] = [];
  switch (op.op) {
    case "find":
    case "findOne":
      filterPaths(op.filter, paths);
      paths.push(...Object.keys(op.options?.sort ?? {}));
      break;
    case "count":
    case "delete":
      filterPaths(op.filter, paths);
      break;
    case "aggregate":
      for (const stage of op.pipeline) {
        if ("$match" in stage) filterPaths(stage.$match, paths);
        refs(stage, paths);
      }
      break;
    case "nearest":
      filterPaths(op.options?.filter, paths);
      if (op.field) paths.push(op.field);
      break;
    case "insert":
      docs.push(...op.docs);
      break;
    case "replace":
      filterPaths(op.filter, paths);
      docs.push(op.doc);
      break;
    case "update": {
      filterPaths(op.filter, paths);
      const operators = Object.keys(op.update).some((key) => key.startsWith("$"));
      if (!operators) docs.push(op.update);
      else {
        for (const [operator, fields] of Object.entries(op.update)) {
          if (!fields || typeof fields !== "object") continue;
          paths.push(...Object.keys(fields));
          if (operator === "$rename") paths.push(...Object.values(fields).map(String));
        }
      }
      break;
    }
  }
  return fields.find((field) =>
    paths.some((path) => meet(path, field)) || docs.some((doc) => holds(doc, field))
  );
}

/** What the owner does around each write. */
export type Hooks = {
  /** Checks a document against its collection's schema. */
  validate(collection: string, doc: Record<string, unknown>): void;
  /** Moves large values out to blobs, within the same transaction. */
  offload<T>(value: T): Promise<T>;
  /** Hears which documents a write changed, to record them as events. */
  changed(collection: string, changes: Change[]): void;
  /** A collection's vector fields: kept as the store's vectors, not in documents. */
  vectors(collection: string): string[];
};

const invalidVector = (field: string) =>
  Object.assign(new Error(`"${field}" must be an array of numbers (a vector), or null`), {
    code: "invalid",
  });

/**
 * Takes a collection's vector fields out of a document: what to store as the
 * document, and each field's vector (null to remove it).
 */
function split(doc: Record<string, unknown>, fields: string[]) {
  const rest = { ...doc };
  const vectors: [string, number[] | null][] = [];
  for (const field of fields) {
    if (!(field in rest)) continue;
    const value = rest[field];
    delete rest[field];
    if (value !== null && !(Array.isArray(value) && value.every(Number.isFinite))) {
      throw invalidVector(field);
    }
    vectors.push([field, value as number[] | null]);
  }
  return { rest, vectors };
}

/** Writes or removes a document's vectors, as `split` found them. */
async function store(
  tx: Transaction,
  collection: string,
  doc: string,
  vectors: [string, number[] | null][],
) {
  for (const [field, embedding] of vectors) {
    if (embedding) await tx.putVector({ collection, doc, field, embedding });
    else await tx.deleteVectors(collection, [doc], field);
  }
}

/** Runs any op inside a transaction; writes return what the collection API reports. */
export async function perform(tx: Transaction, op: StoreOp, hooks: Hooks): Promise<unknown> {
  switch (op.op) {
    case "insert": {
      const fields = hooks.vectors(op.collection);
      const parts = op.docs.map((doc) => split(doc, fields));
      const docs = parts.map(({ rest }) => rest as Doc);
      for (const { _id: _, ...rest } of docs) hooks.validate(op.collection, rest);
      const { changes } = await tx.insert(
        op.collection,
        await hooks.offload(docs),
        op.ifAbsent ? { ifAbsent: true } : undefined,
      );
      for (const [i, { vectors }] of parts.entries()) {
        await store(tx, op.collection, docs[i]._id, vectors.filter(([, v]) => v));
      }
      hooks.changed(op.collection, changes);
      return undefined;
    }
    case "update": {
      const fields = hooks.vectors(op.collection);
      const replacing = !Object.keys(op.update).some((key) => key.startsWith("$"));
      const set = replacing ? op.update : op.update.$set ?? {};
      const unset = replacing ? {} : op.update.$unset ?? {};
      const touched = fields.filter((field) => field in set || field in unset);
      if (!touched.length) {
        const { changes, ...result } = await tx.update(
          op.collection,
          op.filter,
          await hooks.offload(op.update),
          op.options,
        );
        hooks.changed(op.collection, changes);
        return result;
      }
      // The documents to give vectors: those matching before the update changes them.
      const targets = (await tx.find(op.collection, op.filter, op.options.many ? {} : { limit: 1 }))
        .map((doc) => doc._id);
      // What $set gives, then what $unset removes.
      const vectors: [string, number[] | null][] = [
        ...split(set, touched.filter((field) => !(field in unset))).vectors,
        ...touched.filter((field) => field in unset).map((field): [string, null] => [field, null]),
      ];
      const update = replacing ? split(op.update, touched).rest : Object.fromEntries(
        Object.entries({
          ...op.update,
          $set: Object.fromEntries(Object.entries(set).filter(([k]) => !touched.includes(k))),
          $unset: Object.fromEntries(Object.entries(unset).filter(([k]) => !touched.includes(k))),
        }).filter(([, value]) => Object.keys(value as object).length),
      );
      let result: { matched: number; modified: number; upsertedId?: string } = {
        matched: targets.length,
        modified: targets.length,
      };
      if (replacing || Object.keys(update).length) {
        const { changes, ...done } = await tx.update(
          op.collection,
          op.filter,
          await hooks.offload(update as Update),
          op.options,
        );
        hooks.changed(op.collection, changes);
        result = { ...done, modified: Math.max(done.modified, targets.length) };
      } else if (!targets.length && op.options.upsert) {
        const { changes, ...done } = await tx.update(op.collection, op.filter, {}, op.options);
        hooks.changed(op.collection, changes);
        result = done;
      }
      for (const doc of result.upsertedId ? [result.upsertedId] : targets) {
        await store(tx, op.collection, doc, vectors);
      }
      return result;
    }
    case "replace": {
      const fields = hooks.vectors(op.collection);
      const { rest, vectors } = split(op.doc, fields);
      hooks.validate(op.collection, rest);
      const { changes, ...result } = await tx.replace(
        op.collection,
        op.filter,
        await hooks.offload(rest),
        op.options,
      );
      hooks.changed(op.collection, changes);
      if (fields.length) {
        const doc = result.upsertedId ?? changes[0]?._id ??
          (await tx.findOne(op.collection, op.filter))?._id;
        // A replacement holds only the vectors it gives.
        if (doc) {
          await tx.deleteVectors(op.collection, [doc]);
          await store(tx, op.collection, doc, vectors.filter(([, v]) => v));
        }
      }
      return result;
    }
    case "delete": {
      const { deleted, changes } = await tx.delete(op.collection, op.filter, op.options);
      // A deleted document takes its vectors with it.
      if (changes.length && hooks.vectors(op.collection).length) {
        await tx.deleteVectors(op.collection, changes.map((change) => change._id));
      }
      hooks.changed(op.collection, changes);
      return deleted;
    }
    case "link":
      return tx.link(await hooks.offload(op.edge));
    case "unlink":
      return tx.unlink(op.edge);
    case "emit":
      tx.emit({ ...op.event, data: await hooks.offload(op.event.data) });
      return undefined;
    default:
      return read(tx, op);
  }
}
