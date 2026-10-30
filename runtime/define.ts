/**
 * What a plugin declares. Everything here is plain data; the runtime gives it
 * meaning only as primitives. It never knows what a plugin is for.
 */
import type { FromSchema, JSONSchema } from "json-schema-to-ts";
import type { Pipeline } from "./aggregate.ts";
import type { Metrics } from "./metrics.ts";
import type { Scheduled, ScheduleDef, ScheduleOptions, SchedulePatch } from "./schedules.ts";
import type { Collection, NearestOptions, WithId } from "./collection.ts";
import type { Actor, Edge, Event, Filter, FindOptions } from "./store.ts";

/** The TypeScript type a JSON Schema describes. Deferred so generics stay cheap. */
export type Infer<S> = S extends JSONSchema ? FromSchema<S> : never;
export type { JSONSchema };

/**
 * A named kind of declaration (agents, tools, …) mapped by name. Opaque to the
 * runtime. A later plugin patches an earlier one's entries: objects merge field
 * by field, `null` removes, anything else replaces.
 */
export type Resources = Record<string, Record<string, unknown>>;
/** Implementations of a port (llm, …) mapped by name; a later plugin's replaces. Opaque to the runtime. */
export type Adapters = Record<string, Record<string, unknown>>;

export type Graph = {
  link(from: string, type: string, to: string, data?: Record<string, unknown>): Promise<void>;
  unlink(from: string, type: string, to: string): Promise<void>;
  edges(query: { from?: string; type?: string; to?: string }): Promise<Edge[]>;
};

/**
 * Multi-operation atomic work, like MongoDB's `session.withTransaction`.
 * Inserts, links, unlinks, emits and writes with `{ writeConcern: { w: 0 } }`
 * are sent with the next op or the commit, so an error from one surfaces
 * there (it still aborts the whole transaction). Work made only of them is
 * one call, which a store may run as a single statement.
 */
export type TransactionScope = {
  db: { collection<T = Record<string, unknown>>(name: string): Collection<T> };
  graph: Omit<Graph, "edges">;
  emit(type: string, data?: Record<string, unknown>, options?: { id?: string }): void;
  /** Sets a timer with the transaction's writes, and returns its id (see `Context.schedule`). */
  schedule(action: string, input: unknown, when: ScheduleOptions): string;
  /** Removes a timer with the transaction's writes. */
  unschedule(id: string): void;
};

export type Context = {
  /** MongoDB-style collections. Each write commits on its own. */
  db: { collection<T = Record<string, unknown>>(name: string): Collection<T> };
  graph: Graph;
  /** Commits an event. Inside `transaction`, events commit with the writes. */
  emit(type: string, data?: Record<string, unknown>, options?: { id?: string }): Promise<void>;
  transaction<R>(work: (tx: TransactionScope) => Promise<R>): Promise<R>;
  /** Live, non-durable frames for subscribers (for example tokens being generated). */
  stream(channel: string): { write(data: unknown): void };
  call<R = unknown>(action: string, input?: unknown): Promise<R>;
  /**
   * This context, with the calls and timers it starts numbered apart, under
   * `key`. For work run concurrently (each of a step's tool calls): a retry
   * finds each branch's calls again, whatever order they start in. Writes
   * still answer to the same cause.
   */
  branch(key: string): Context;
  /**
   * Has time call an Action with `input`: once (`at`), by a cron expression
   * (`cron`, in a `timezone`), or every so long (`every`: "15m", 60000…).
   * Returns the timer's id; scheduling an id again replaces its timer. Each
   * time it comes due, the call has an id of its own (`<timer>@<time>`), and a
   * failed one is tried again (`retries`, 2) after 10 s, 30 s, 90 s…
   */
  schedule(action: string, input: unknown, when: ScheduleOptions): Promise<string>;
  /** Removes a timer; false when there was none. */
  unschedule(id: string): Promise<boolean>;
  /**
   * Stops work that's running: an Action call by id (one a client or a timer
   * started), or what a Processor is doing for a key. It ends as failed with
   * code `cancelled`, and a stopped delivery isn't retried. False when nothing
   * was running.
   */
  cancel(target: { call: string } | { processor: string; key: string }): Promise<boolean>;
  /** Renders `item` through the View registered for its kind and the renderer (see Views). */
  render: Render;
  /**
   * Appends a document to a records collection, and returns its `_id`. It
   * goes with this job's next write, or when the job ends (even failing), so
   * it costs no round trip of its own and is kept whatever the job does next.
   */
  record(collection: string, doc: Record<string, unknown>): string;
  /** Counters, histograms and gauges (see runtime/metrics.ts); they do nothing unless configured. */
  metrics: Metrics;
  resources: Resources;
  adapters: Adapters;
  /** Workers of the kinds plugins declare (a computer…), sent jobs by kind and id. */
  workers: Workers;
  /**
   * Who this runs for: the actor of the outside call, the event or the timer
   * that started it, carried into everything it causes. None: the system.
   */
  actor?: Actor;
  /**
   * This context acting as someone else: a person (a webhook mapping a number
   * to its person), or the system (no argument), which no rule restricts.
   * Trusted code only; what it does records the actor it acts as, `via` its
   * own.
   */
  as(actor?: Actor): Context;
  /** The event a Processor is handling. */
  event?: Event;
  /**
   * When time called this Action (see `schedule`): its timer, and the time
   * this occurrence was due, which a retry keeps. Absent for other callers.
   */
  scheduled?: Scheduled;
  /** This call or delivery ran before: some of its work may already be committed. */
  retry: boolean;
  signal: AbortSignal;
};

/** What a query (and, read-only, anything rendering) can reach: reads, never writes. */
export type ReadContext = {
  db: { collection<T = Record<string, unknown>>(name: string): ReadCollection<T> };
  graph: Pick<Graph, "edges">;
  render: Render;
  /** Records what a read used (an embedding's tokens…): the only write a read makes. */
  record: Context["record"];
  metrics: Metrics;
  resources: Resources;
  /** Ports a read may use, such as an embedder; the store stays read-only. */
  adapters: Adapters;
  /** Who is reading; what they don't reach, the rules keep out already. */
  actor?: Actor;
  /**
   * Calls an unrecorded Action (`record: false`), another plugin's or this
   * one's, with a read-only context: it reads, and records what it used,
   * but anything it writes fails. How a query or View uses what another
   * plugin does (an embedding) without importing its code.
   */
  call<R = unknown>(action: string, input?: unknown): Promise<R>;
};

/** What a plugin's startup check reaches: the merged configuration, and unrecorded Actions to ask. */
export type Merged = {
  resources: Resources;
  adapters: Adapters;
  /** Calls an unrecorded Action, as a read does (another plugin's check: `models.check`). */
  call<R = unknown>(action: string, input?: unknown): Promise<R>;
};

/**
 * Views present data to a medium. A plugin registers them by kind (a
 * collection's name, `tool:<name>`, a named datum) and renderer (a medium:
 * `llm`, later `react`). The runtime gives neither name a meaning; for a kind
 * and renderer, the last plugin's View wins.
 */
export type Views = Record<string, Record<string, ViewDef>>;

/** A View: an item, for a medium. Its context says what showing another View returns there. */
// deno-lint-ignore no-explicit-any
export type ViewDef = (item: any, ctx: ViewContext<any>) => unknown;

/**
 * Who looks: a View renders relative to it (your own messages, your bubbles).
 * `name` is who they are (a person's id); `label` what they're shown as, when
 * it isn't that (a person's own name, as they signed in).
 */
export type Viewer = { name: string; kind?: string; label?: string };

export type RenderOptions = { viewer?: Viewer; hints?: Record<string, unknown> };

/** Renders through the View for a kind and renderer; undefined when there is none. */
export type Render = (
  renderer: string,
  kind: string,
  item: unknown,
  options?: RenderOptions,
) => Promise<unknown>;

/**
 * A read inside a View: it returns at once. While `loading`, the renderer
 * waits for it and runs the View again, until a pass reads nothing new.
 */
export type Read<T> =
  | { status: "loading"; value?: undefined }
  | { status: "ready"; value: T };

/** A collection's reads inside a View: the same reads, answered as `Read`s. */
export type ViewCollection<T> = {
  find(filter?: Filter, options?: FindOptions): Read<WithId<T>[]>;
  findOne(filter?: Filter, options?: FindOptions): Read<WithId<T> | null>;
  countDocuments(filter?: Filter): Read<number>;
  aggregate<R = Record<string, unknown>>(pipeline: Pipeline): Read<R[]>;
  nearest(vector: number[], options?: NearestOptions): Read<(WithId<T> & { _score: number })[]>;
  query<R = unknown>(name: string, params?: unknown): Read<R>;
};

/** What a View gets. `Shown` is what showing another View returns in its medium (text, an element). */
export type ViewContext<Shown = unknown> = {
  db: { collection<T = Record<string, unknown>>(name: string): ViewCollection<T> };
  resources: Resources;
  /** The medium being rendered. */
  renderer: string;
  /** The kind being rendered: a medium's default View (kind `"*"`) renders any kind. */
  kind: string;
  viewer?: Viewer;
  /** Who it renders as; what they don't reach, the rules keep out already. */
  actor?: Actor;
  /** What the caller asked for (`mode`: a density, …). Open-ended. */
  hints: Record<string, unknown>;
  /**
   * Renders `item` through its kind's View in this renderer; undefined when
   * there is none. Observed, the shown View is a part of its own: it runs
   * again on its own when what it read changes (see `Owner.observe`).
   */
  show(kind: string, item: unknown, hints?: Record<string, unknown>): Shown;
  /**
   * Calls an Action, from a handler in what the View returns (a key, a
   * click). A View being observed can; one rendered once has no handlers.
   */
  call<R = unknown>(action: string, input?: unknown): Promise<R>;
  /** Commits an event, from a handler, as `call` does: for Processors to react to. */
  emit(type: string, data?: Record<string, unknown>): Promise<void>;
};

/** A collection's reads, with its named queries. */
export type ReadCollection<T> = Pick<
  Collection<T>,
  "find" | "findOne" | "countDocuments" | "aggregate" | "nearest" | "query"
>;

/** A named read: its collection, its params, and other reads. */
// deno-lint-ignore no-explicit-any
export type QueryFn<T = any> = (
  collection: ReadCollection<T>,
  // deno-lint-ignore no-explicit-any
  params: any,
  ctx: ReadContext,
) => unknown;

/**
 * A named read declared on a collection. Plugin code runs any of them (as
 * whom it acts for, under the rules). From outside (a host acting for a
 * person, a browser), an actor runs only one that lets them (`allow`), as
 * with Actions: a bare function is the system's.
 */
// deno-lint-ignore no-explicit-any
export type QueryDef<T = any> = QueryFn<T> | {
  // deno-lint-ignore no-explicit-any
  allow(actor: Actor, params: any): boolean;
  run: QueryFn<T>;
};

export type CollectionDef = {
  schema: JSONSchema;
  /** Record `<name>.created/updated/deleted` events for its writes (default true). */
  events?: boolean;
  /**
   * A ledger: documents are appended (`ctx.record`, or inserts), never
   * changed or deleted, and are their own record (no lifecycle events). An
   * `_id` sent again is the record already kept, so sending twice is safe.
   */
  records?: boolean;
  /**
   * `false`: kept in the owner's memory, never in the store. Its writes record
   * no events and are gone when the owner restarts: for state that is only
   * live, like a reply being written. In a transaction its writes apply when
   * the transaction commits, after its other writes, and answer nothing.
   */
  durable?: false;
  /**
   * Indexes, each a list of fields (`[["at"], ["tags.tenant", "at"]]`), for
   * the stores to serve filters on them without reading every document. A
   * field must be a scalar its schema types (string, number, integer or
   * boolean): every write is checked against it, so it never holds an array.
   */
  indexes?: string[][];
  /**
   * Fields only trusted code reads (tokens, keys): what an actor's queries
   * and Views read comes without them. Actions and Processors acting for
   * them still read them; what they return is theirs to decide.
   */
  private?: string[];
  /** Named reads: `runtime.query("<collection>.<name>", params)`, or `collection.query(name, params)`. */
  queries?: Record<string, QueryDef>;
  /**
   * Fields holding vectors (embeddings). Written like any field, kept as the
   * store's vectors rather than in the document, and searched with
   * `collection.nearest(vector, …)`. A deleted document takes its vectors.
   */
  vectors?: string[];
};

export type ActionDef = {
  /**
   * Who may call it from outside: an actor's call runs only if this says
   * yes. Without it, actors can't call it (the system and plugin code can).
   * Which documents a call reaches is the rules' business, not this.
   */
  allow?(actor: Actor, input: unknown): boolean;
  /** What it does, for people and tools that list Actions. */
  description?: string;
  input?: JSONSchema;
  /**
   * Record `action.started/completed/failed` events for its calls (default
   * true). An unrecorded one runs inline in its caller's job: no events, no
   * commit of its own, and it may hand back anything (a stream) to a caller
   * in the same process; queries, Views and startup checks may call it too,
   * read-only.
   */
  record?: boolean;
  // deno-lint-ignore no-explicit-any
  run(ctx: Context, input: any): unknown;
};

export type ProcessorDef = {
  /** Event types handled, or "*". */
  on: string | string[];
  /** Only events whose data matches this MongoDB filter. The owner skips the rest. */
  where?: Filter;
  /** Events with the same key run in order; different keys run concurrently. */
  key?(event: Event): string;
  run(ctx: Context, event: Event): unknown;
};

/**
 * An event a plugin emits, beyond the runtime's own (a collection's changes,
 * an Action's lifecycle): what its data holds. Emitting a type nobody
 * declared fails, so every event is in some plugin's contract. Every event
 * is durable: written in the emitting job's commit, then handled by
 * Processors in jobs of their own.
 */
export type EventDef = {
  description?: string;
  schema: JSONSchema;
  /** Who may emit it from outside (a host, a View's handler); nobody but the system without it. */
  allow?(actor: Actor): boolean;
};

/**
 * A later plugin's addition to a collection another declared: more indexes,
 * for what it reads that collection by (`{ usage: { indexes: [["tags.tenant", "at"]] } }`).
 */
export type CollectionPatch = { indexes: string[][] };

/**
 * A kind of worker a plugin declares: a program that isn't plugin code but
 * does its work (a computer running commands), connecting to the owner over
 * Oxian as executors do. It presents `<kind>:<secret>`. `admit` is an Action
 * (run as the system) that says who it is, `{ id }`, or refuses it (null);
 * `ready` and `gone`, Actions too, hear it connect and leave (`{ id }`).
 * Plugin code sends it jobs by kind and id (`ctx.workers`); it's sent only
 * its `workloads`, and asks the owner for nothing.
 */
export type WorkerKind = {
  admit: string;
  ready?: string;
  gone?: string;
  workloads: string[];
};

/** A job a worker is doing: its output as it comes, and when it's done. */
export type WorkerJob = { output: ReadableStream<Uint8Array>; done: Promise<void> };

/** Workers of the kinds plugins declare, by kind and id (see `WorkerKind`). */
export type Workers = {
  /**
   * Sends one a job: `workload`, with `input` (JSON). Fails with code
   * `offline` when none with that id is connected; the job stops with
   * `signal`, or the work that sent it.
   */
  dispatch(
    kind: string,
    id: string,
    workload: string,
    input?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<WorkerJob>;
  /** A job whose output is one JSON value: that value. */
  call<R = unknown>(
    kind: string,
    id: string,
    workload: string,
    input?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<R>;
};

export type Plugin = {
  name: string;
  /**
   * The plugins it builds on, by name: their contracts are what it imports,
   * their Actions, collections and events what it uses. The runtime doesn't
   * start without them.
   */
  requires?: string[];
  /** Its own collections, and indexes it adds to others' (a patch: no schema). */
  collections?: Record<string, CollectionDef | CollectionPatch>;
  actions?: Record<string, ActionDef>;
  /** The events it emits, beyond its collections' changes and its Actions' lifecycle. */
  events?: Record<string, EventDef>;
  processors?: Record<string, ProcessorDef>;
  /** `null` removes an earlier plugin's View. */
  views?: Record<string, Record<string, ViewDef | null>>;
  resources?: Resources;
  adapters?: Adapters;
  /**
   * Actions time calls, by name: by a cron expression (in a timezone) or
   * every so long. Like resources, a later plugin patches an entry (or
   * removes it with `null`), and the owner keeps the timers as declared.
   */
  schedules?: Record<string, ScheduleDef | SchedulePatch | null>;
  /**
   * Checks the configuration it understands once every plugin is merged (an
   * agent's model, a context's View…) and throws what's wrong, so a mistake
   * stops the runtime from starting rather than failing its first call. It
   * may ask other plugins, through their unrecorded Actions (`merged.call`).
   */
  check?(merged: Merged): void | Promise<void>;
  /**
   * Who reaches what (see `Guard`). One plugin, the access plugin, usually
   * declares it; several restrict together.
   */
  guard?: Guard;
  /** What reads reveal, carried to what the same job writes (see `Labels`). */
  labels?: Labels;
  /** Kinds of worker it declares, by name (see `WorkerKind`). */
  workers?: Record<string, WorkerKind>;
};

/**
 * Labels: the owner keeps, for each job an actor's work runs, the labels of
 * what it read (`read`: a document's space, its sources), and hands them to
 * each document the job then inserts or replaces (`write`), which returns it
 * as written: carrying the labels its readers might not all reach, say, or
 * refused. One plugin, the access plugin, declares them.
 */
export type Labels = {
  read(collection: string, docs: Record<string, unknown>[], ctx: ReadContext): string[];
  write(
    actor: Actor,
    collection: string,
    doc: Record<string, unknown>,
    labels: string[],
    ctx: ReadContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
};

/**
 * A rule: for an actor and an operation on a collection, the filter its
 * documents must match. Reads match it; inserts, and what an update or a
 * replace leaves, must match it; deletes only reach what matches it.
 * `true`: nothing to restrict here (the operation's own filter already keeps
 * to what the actor reaches). `undefined`: the collection has no rule, so code
 * acting for the actor reads and writes it unchecked. Runs in the owner, on
 * every operation an actor's work makes, with read access to everything.
 */
export type Guard = (
  actor: Actor,
  operation: {
    collection: string;
    /** Reads, or writes (inserts, updates, replaces and deletes). */
    access: "read" | "write";
    filter?: Filter;
  },
  ctx: ReadContext,
) => Filter | true | undefined | Promise<Filter | true | undefined>;

/** Plugins, in order; a theme's bundle is a list of its own, so lists may nest. */
export type Plugins = (Plugin | Plugins)[];

export const definePlugin = (plugin: Plugin): Plugin => plugin;

/** A collection whose documents (and queries' collection) are typed from its JSON Schema. */
export const defineCollection = <const S extends JSONSchema>(
  def: {
    schema: S;
    events?: boolean;
    records?: boolean;
    durable?: false;
    indexes?: string[][];
    private?: string[];
    queries?: Record<string, QueryDef<Infer<S> & { _id: string }>>;
    vectors?: string[];
  },
) => def;

/** An Action whose `input` type comes from its JSON Schema. */
export const defineAction = <const S extends JSONSchema, R>(
  def: {
    description?: string;
    input: S;
    record?: boolean;
    allow?(actor: Actor, input: Infer<S>): boolean;
    run(ctx: Context, input: Infer<S>): R | Promise<R>;
  },
): ActionDef => def as ActionDef;

export const defineProcessor = (def: ProcessorDef): ProcessorDef => def;

export type { Filter, FindOptions };
