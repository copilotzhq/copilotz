/**
 * The storage port. The runtime persists exactly five things, events, nodes
 * (documents), edges, vectors and blobs, and speaks MongoDB's API to the
 * adapter. Each adapter executes it natively: JavaScript in memory, SQL over
 * jsonb in PostgreSQL, JSON functions in SQLite.
 */

import type { Plan } from "./aggregate.ts";
import type { JSONSchema } from "json-schema-to-ts";
import type { WriteOp } from "./ops.ts";

/** A document of a collection. `_id` is its node id. */
export type Doc = { _id: string; [field: string]: unknown };

/** A MongoDB filter: field paths (dot notation) to values or `$` operators. */
export type Filter = Record<string, unknown>;

/** A MongoDB update: `$set`, `$unset`, `$inc`, `$push`, `$pull`, `$addToSet`. */
export type Update = Record<string, Record<string, unknown>>;

export type FindOptions = {
  /** `{ field: 1 }` ascending, `{ field: -1 }` descending. */
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
};

/** An immutable fact. `seq` is its position in the owner's log. */
/**
 * Who acts: bound once by an outside call (a person, a key, a device, a
 * channel), carried by everything it causes. The runtime gives it no meaning
 * beyond `kind` and `id`; plugins (access) do. None: the system.
 */
export type Actor = { kind: string; id: string; [more: string]: unknown };

export type Event = {
  seq: number;
  id: string;
  type: string;
  data: Record<string, unknown>;
  /** The event that caused this one. */
  cause?: string;
  /** Who did it: the log is the audit trail. None: the system. */
  actor?: Actor;
  at: string;
};

/** A directed relation between two documents. */
export type Edge = { from: string; type: string; to: string; data?: Record<string, unknown> };

/** Content stored by its hash (`sha256-…`): the same content is stored once. */
export type Blob = { id: string; data: Uint8Array; type?: string };

/** One document a write changed: `before` is null when created, `after` when deleted. */
export type Change = { _id: string; before: Doc | null; after: Doc | null };

/** The embedding held in one vector field of one document. */
export type Vector = { collection: string; doc: string; field: string; embedding: number[] };

/** A document `nearest` found, with its cosine similarity to the query (-1 to 1). */
export type Scored = Doc & { _score: number };

/** Reads, available inside and outside a transaction. */
export type Reader = {
  find(collection: string, filter?: Filter, options?: FindOptions): Promise<Doc[]>;
  /**
   * The documents matching `filter` whose `field` vector is nearest `vector`
   * (cosine similarity), best first; ties keep insertion order. Vectors of
   * another length don't take part.
   */
  nearest(
    collection: string,
    field: string,
    vector: number[],
    options?: { filter?: Filter; limit?: number },
  ): Promise<Scored[]>;
  findOne(collection: string, filter?: Filter, options?: FindOptions): Promise<Doc | null>;
  count(collection: string, filter?: Filter): Promise<number>;
  /** Groups and totals matching documents (see aggregate.ts); the plan is already checked. */
  aggregate(collection: string, plan: Plan): Promise<Doc[]>;
  edges(query: { from?: string; type?: string; to?: string }): Promise<Edge[]>;
  blob(id: string): Promise<Blob | null>;
  events(after: number, limit?: number): Promise<Event[]>;
  /** The event with this id and the events it caused, of these types, in log order. */
  related(id: string, types: string[]): Promise<Event[]>;
};

/**
 * One owner command. Writes are visible to its own reads and commit atomically.
 * Each write reports the documents it actually changed; a write that leaves a
 * document as it was reports nothing for it.
 */
export type Transaction = Reader & {
  /**
   * Inserts documents; an `_id` that exists fails the transaction, or with
   * `ifAbsent` is left as it is (and reports no change).
   */
  insert(
    collection: string,
    docs: Doc[],
    options?: { ifAbsent?: boolean },
  ): Promise<{ changes: Change[] }>;
  update(
    collection: string,
    filter: Filter,
    update: Update,
    options?: { many?: boolean; upsert?: boolean },
  ): Promise<{ matched: number; modified: number; upsertedId?: string; changes: Change[] }>;
  replace(
    collection: string,
    filter: Filter,
    doc: Omit<Doc, "_id">,
    options?: { upsert?: boolean },
  ): Promise<{ matched: number; upsertedId?: string; changes: Change[] }>;
  delete(
    collection: string,
    filter: Filter,
    options?: { many?: boolean },
  ): Promise<{ deleted: number; changes: Change[] }>;
  link(edge: Edge): Promise<void>;
  unlink(edge: Omit<Edge, "data">): Promise<void>;
  /** Idempotent: the id is the content's hash. */
  putBlob(blob: Blob): Promise<void>;
  /** Sets (or replaces) a document's vector for one field. */
  putVector(vector: Vector): Promise<void>;
  /** Removes these documents' vectors: every field's, or one field's. */
  deleteVectors(collection: string, docs: string[], field?: string): Promise<void>;
  /** Appends an event; it gets its `seq` when the transaction commits. */
  emit(event: Emitted): void;
};

/** A declared index: its fields, each a scalar of one type. */
export type IndexSpec = { fields: { path: string; type: ScalarType }[] };
export type ScalarType = "string" | "number" | "boolean";

/** An event to record, as a write or an emit asks for it. */
export type Emitted = {
  id?: string;
  type: string;
  data: Record<string, unknown>;
  cause?: string;
  actor?: Actor;
};

/**
 * Writes and events, in order, which a store may run as a single atomic
 * command instead of a transaction (see `Store.command`).
 */
export type Command = {
  /**
   * Each write is validated, with large values already offloaded to `blobs`.
   * With `record`, it records `<collection>.created/updated/deleted` for each
   * document it changes, right after it: `{ _id, doc }`, plus `changed` and
   * `removed` (sorted) for updates.
   */
  steps: ({ write: WriteOp; record: boolean } | { emit: Emitted })[];
  cause?: string;
  /** Who the recorded events' writes were done by. */
  actor?: Actor;
  /** Blobs the writes refer to; ids already in the store are skipped. */
  blobs: Blob[];
  positions?: Record<string, number>;
};

export type Store = Reader & {
  /** Claims ownership: bumps the fencing epoch. A previous owner can no longer commit. */
  open(): Promise<{ epoch: number }>;
  /**
   * Runs `work` as one atomic, fenced transaction and returns its result with
   * the committed events. Throws `fenced` if another owner claimed the store.
   * `positions` (Processor positions) are saved with the commit.
   */
  transaction<T>(
    epoch: number,
    work: (tx: Transaction) => Promise<T>,
    options?: { positions?: Record<string, number> },
  ): Promise<{ result: T; events: Event[] }>;
  /** Each Processor's saved position: the last event it has finished with. */
  positions(): Promise<Record<string, number>>;
  /**
   * Optional: runs writes with their events as a single fenced, atomic
   * command. Returns what the collection API reports for each write, the
   * committed events and, for each write, the documents it changed (so the
   * owner's cache can follow them). Returns undefined when it can't run these
   * writes that way; the owner then uses a transaction.
   */
  command?(
    epoch: number,
    command: Command,
  ): Promise<{ results: unknown[]; events: Event[]; changes: Change[][] }> | undefined;
  /** Optional: lets an adapter present each collection natively, for example as a SQL view. */
  describe?(collections: Record<string, JSONSchema>): void | Promise<void>;
  /**
   * Makes the declared indexes (and drops ones no longer declared). A field's
   * type is what its schema guarantees, so a filter on it may compare it as
   * that type alone.
   */
  index?(collections: Record<string, IndexSpec[]>): void | Promise<void>;
  /** Round trips to the backing database (0 for memory), for measurement. */
  roundTrips(): number;
  close(): Promise<void>;
};

/** Cosine similarity; 0 when either vector has no length. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Raised when another owner claimed the store; this owner must stop writing. */
export function fenced(): Error {
  return Object.assign(new Error("This owner was fenced: another owner holds the store."), {
    code: "fenced",
  });
}
