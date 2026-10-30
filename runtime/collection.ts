/**
 * The MongoDB collection API. Every call becomes one op for the owner, which
 * translates it onto the storage adapter. Nothing is filtered here.
 */
import type { Pipeline } from "./aggregate.ts";
import type { Op } from "./ops.ts";
import type { Doc, Filter, FindOptions, Update } from "./store.ts";

export type WithId<T> = T & { _id: string };

export type Cursor<T> = PromiseLike<WithId<T>[]> & {
  sort(sort: Record<string, 1 | -1>): Cursor<T>;
  limit(limit: number): Cursor<T>;
  skip(skip: number): Cursor<T>;
  toArray(): Promise<WithId<T>[]>;
};

export type UpdateResult = {
  acknowledged: true;
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
  upsertedId: string | null;
};

export type DeleteResult = { acknowledged: true; deletedCount: number };

/** What a write with `{ w: 0 }` returns when nobody waited for its answer. */
export type Unacknowledged = { acknowledged: false };

/**
 * `w: 0`, as in MongoDB, asks for no answer. In a transaction the write then
 * goes to the owner with the next op or the commit, and returns at once;
 * outside one there is nothing to batch it with, so it is acknowledged.
 */
export type WriteOptions = { writeConcern?: { w?: number } };
type Unanswered = { writeConcern: { w: 0 } };

export type Collection<T> = {
  insertOne(doc: T & { _id?: string }): Promise<{ acknowledged: true; insertedId: string }>;
  insertMany(docs: (T & { _id?: string })[]): Promise<{
    acknowledged: true;
    insertedCount: number;
    insertedIds: string[];
  }>;
  find(filter?: Filter, options?: FindOptions): Cursor<T>;
  findOne(filter?: Filter, options?: FindOptions): Promise<WithId<T> | null>;
  countDocuments(filter?: Filter): Promise<number>;
  /**
   * Groups and totals documents with a MongoDB pipeline: `$match`, one
   * `$group`, then `$sort`, `$skip`, `$limit` (see runtime/aggregate.ts). The
   * store does the work: only the groups come back.
   */
  aggregate<R = Record<string, unknown>>(pipeline: Pipeline): Promise<R[]>;
  updateOne(
    filter: Filter,
    update: Update,
    options: { upsert?: boolean } & Unanswered,
  ): Promise<UpdateResult | Unacknowledged>;
  updateOne(
    filter: Filter,
    update: Update,
    options?: { upsert?: boolean } & WriteOptions,
  ): Promise<UpdateResult>;
  updateMany(
    filter: Filter,
    update: Update,
    options: { upsert?: boolean } & Unanswered,
  ): Promise<UpdateResult | Unacknowledged>;
  updateMany(
    filter: Filter,
    update: Update,
    options?: { upsert?: boolean } & WriteOptions,
  ): Promise<UpdateResult>;
  replaceOne(
    filter: Filter,
    doc: T,
    options: { upsert?: boolean } & Unanswered,
  ): Promise<UpdateResult | Unacknowledged>;
  replaceOne(
    filter: Filter,
    doc: T,
    options?: { upsert?: boolean } & WriteOptions,
  ): Promise<UpdateResult>;
  deleteOne(filter: Filter, options: Unanswered): Promise<DeleteResult | Unacknowledged>;
  deleteOne(filter: Filter, options?: WriteOptions): Promise<DeleteResult>;
  deleteMany(filter: Filter, options: Unanswered): Promise<DeleteResult | Unacknowledged>;
  deleteMany(filter: Filter, options?: WriteOptions): Promise<DeleteResult>;
  /**
   * The documents whose vector is nearest `vector` (cosine similarity), best
   * first, each with its `_score`; only those matching `filter` take part.
   */
  nearest(
    vector: number[],
    options?: NearestOptions,
  ): Promise<(WithId<T> & { _score: number })[]>;
  /** Runs one of the collection's named queries. */
  query<R = unknown>(name: string, params?: unknown): Promise<R>;
};

/** `field` names the vector field when the collection has several. Ten results by default. */
export type NearestOptions = { filter?: Filter; limit?: number; field?: string };

/**
 * Sends one op to the owner and resolves with its result. With `unanswered`,
 * a transaction may hold it for its next call and resolve with undefined.
 */
export type Run = (op: Op, options?: { unanswered?: boolean }) => Promise<unknown>;

function cursor<T>(
  load: (options: FindOptions) => Promise<unknown>,
  options: FindOptions,
): Cursor<T> {
  const toArray = () => load(options) as Promise<WithId<T>[]>;
  return {
    sort: (sort) => cursor(load, { ...options, sort }),
    limit: (limit) => cursor(load, { ...options, limit }),
    skip: (skip) => cursor(load, { ...options, skip }),
    toArray,
    then: (resolve, reject) => toArray().then(resolve, reject),
  };
}

const updated = (
  result: { matched: number; modified?: number; upsertedId?: string },
): UpdateResult => ({
  acknowledged: true,
  matchedCount: result.matched,
  modifiedCount: result.modified ?? result.matched,
  upsertedCount: result.upsertedId ? 1 : 0,
  upsertedId: result.upsertedId ?? null,
});

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Runs a collection's named query; the executor supplies it. */
export type Query = (collection: string, name: string, params: unknown) => Promise<unknown>;

export function collection<T>(name: string, run: Run, query?: Query): Collection<T> {
  const prepare = (doc: Record<string, unknown>): Doc => {
    const { _id, ...fields } = plain(doc);
    return { ...fields, _id: typeof _id === "string" ? _id : crypto.randomUUID() };
  };
  /** Runs a write; undefined means it was held without an answer (`w: 0` in a transaction). */
  const write = (op: Op, options: WriteOptions = {}) =>
    run(op, options.writeConcern?.w === 0 ? { unanswered: true } : undefined);
  const unacknowledged: Unacknowledged = { acknowledged: false };
  const update = (many: boolean) =>
  async (
    filter: Filter,
    change: Update,
    { writeConcern, ...options }: { upsert?: boolean } & WriteOptions = {},
  ) => {
    const result = await write({
      op: "update",
      collection: name,
      filter,
      update: change,
      options: { ...options, many },
    }, { writeConcern });
    return result === undefined
      ? unacknowledged
      : updated(result as { matched: number; modified: number; upsertedId?: string });
  };
  const remove = (many: boolean) => async (filter: Filter, options: WriteOptions = {}) => {
    const deleted = await write(
      { op: "delete", collection: name, filter, options: { many } },
      options,
    );
    return deleted === undefined
      ? unacknowledged
      : { acknowledged: true as const, deletedCount: deleted as number };
  };
  return {
    async insertOne(doc) {
      const ready = prepare(doc as Record<string, unknown>);
      await run({ op: "insert", collection: name, docs: [ready] });
      return { acknowledged: true, insertedId: ready._id };
    },
    async insertMany(docs) {
      const ready = docs.map((doc) => prepare(doc as Record<string, unknown>));
      await run({ op: "insert", collection: name, docs: ready });
      return {
        acknowledged: true,
        insertedCount: ready.length,
        insertedIds: ready.map((doc) => doc._id),
      };
    },
    find: (filter = {}, options = {}) =>
      cursor<T>((final) => run({ op: "find", collection: name, filter, options: final }), options),
    findOne: (filter = {}, options = {}) =>
      run({ op: "findOne", collection: name, filter, options }) as Promise<WithId<T> | null>,
    countDocuments: (filter = {}) =>
      run({ op: "count", collection: name, filter }) as Promise<number>,
    aggregate: <R>(pipeline: Pipeline) =>
      run({ op: "aggregate", collection: name, pipeline }) as Promise<R[]>,
    nearest: (vector: number[], { field, ...options }: NearestOptions = {}) =>
      run({
        op: "nearest",
        collection: name,
        ...(field ? { field } : {}),
        vector,
        options,
      }) as Promise<(WithId<T> & { _score: number })[]>,
    updateOne: update(false),
    updateMany: update(true),
    async replaceOne(
      filter: Filter,
      doc: T,
      { writeConcern, ...options }: { upsert?: boolean } & WriteOptions = {},
    ) {
      const result = await write({
        op: "replace",
        collection: name,
        filter,
        doc: plain(doc) as Omit<Doc, "_id">,
        options,
      }, { writeConcern });
      return result === undefined
        ? unacknowledged
        : updated(result as { matched: number; upsertedId?: string });
    },
    deleteOne: remove(false),
    deleteMany: remove(true),
    query: (queryName: string, params?: unknown) =>
      query
        ? query(name, queryName, params)
        : Promise.reject(new Error(`Queries can't run here (${name}.${queryName})`)),
  } as Collection<T>;
}
