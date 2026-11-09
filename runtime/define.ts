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
import type { Owner } from "./owner.ts";

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
 *
 * An op that fails, a write the rules refuse included, ends the transaction:
 * it rolls back, and its later ops fail ("The transaction is closed."), even
 * when the error is caught. It holds the store's writer, so keep slow work out
 * of it: one with no op for 5 seconds rolls back too.
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
  /**
   * Ends an actor's browsers, when who they were ends (signed out, erased):
   * each connection closes, and comes back only with a new ticket. How many
   * it ended. A key of a person's (`actor.key`) is ended apart from them.
   *
   * Like `cancel`, it checks nothing of who asks: plugins are trusted code,
   * and it's theirs to call only once who the actor was has ended (a sign-out,
   * an erasure the rules allowed). It reaches only this runtime's browsers:
   * with many orgs behind a directory, each org's runtime has its own owner, so one org's
   * code never ends another org's browsers.
   */
  disconnect(actor: Actor): Promise<number>;
  /** Renders `item` through the View registered under a name (see Views). */
  render: Render;
  /**
   * Appends a document to a records collection, and returns its `_id`. It
   * goes with this job's next write, or when the job ends (even failing), so
   * it costs no round trip of its own and is kept whatever the job does next.
   */
  record(collection: string, doc: Record<string, unknown>): string;
  /** Counters, histograms and gauges (see runtime/metrics.ts); they do nothing unless configured. */
  metrics: Metrics;
  /**
   * Calls to outside services (Meta, Stripe, Google…): the platform's `fetch`
   * unless `createRuntime({ fetch })` replaced it, as tests do with a fake.
   */
  fetch: typeof fetch;
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
  /** Calls to outside services: the platform's `fetch`, or the one `createRuntime({ fetch })` gave. */
  fetch: typeof fetch;
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
  /** Every plugin's Actions, by name: whether one a declaration names is there. */
  actions: Readonly<Record<string, ActionDef>>;
  /** Calls an unrecorded Action, as a read does (another plugin's check: `models.check`). */
  call<R = unknown>(action: string, input?: unknown): Promise<R>;
};

/**
 * Views present data. A plugin registers each under a name, which says what
 * it shows: a collection's name, `tool:<name>`, a named datum; a place
 * prefixes it where the same thing is shown in several (`llm.message`,
 * `web.message`). The runtime gives names no meaning; for a name, the last
 * plugin's View wins.
 */
export type Views = Record<string, ViewDef>;

/** A View: an item in, what it presents out. Its context says what showing another View returns. */
// deno-lint-ignore no-explicit-any
export type ViewDef = (item: any, ctx: ViewContext<any>) => unknown;

/**
 * Who looks: a View renders relative to it (your own messages, your bubbles).
 * `name` is who they are (a person's id); `label` what they're shown as, when
 * it isn't that (a person's own name, as they signed in).
 */
export type Viewer = { name: string; kind?: string; label?: string };

export type RenderOptions = { viewer?: Viewer; hints?: Record<string, unknown> };

/** Renders through the View with this name; undefined when there is none. */
export type Render = (
  name: string,
  item: unknown,
  options?: RenderOptions,
) => Promise<unknown>;

/**
 * A read inside a View: it returns at once. While `loading`, the runtime
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

/** What a View gets. `Shown` is what showing another View returns (text, an element). */
export type ViewContext<Shown = unknown> = {
  db: { collection<T = Record<string, unknown>>(name: string): ViewCollection<T> };
  resources: Resources;
  /** The name of the View being rendered. */
  name: string;
  viewer?: Viewer;
  /** Who it renders as; what they don't reach, the rules keep out already. */
  actor?: Actor;
  /** What the caller asked for (`mode`: a density, …). Open-ended. */
  hints: Record<string, unknown>;
  /**
   * Renders `item` through the View named `name`, and exactly that one;
   * undefined when there is none. Observed, the shown View is a part of its own: it runs
   * again on its own when what it read changes (see `Owner.observe`).
   */
  show(name: string, item: unknown, hints?: Record<string, unknown>): Shown;
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
  /**
   * Fields its calls are recorded without, as dot paths (as a collection's
   * `private`), in its input and its result alike: personal data
   * (`["buyer", "passengers"]`) stays out of the log. A call's id still
   * hashes the whole input, so a retry with the same input finds the call,
   * and a changed one is a new call. A result that had any is kept whole
   * apart (`sys.results`, no events), so a retry answers with all of it.
   */
  private?: string[];
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
  views?: Record<string, ViewDef | null>;
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
  /**
   * Its HTTP, by `URLPattern` pathname (`/hooks/whatsapp/:name`, `/app/*`):
   * what `runtime.fetch` answers with (see `Route`). A later plugin's route
   * replaces an earlier one's of the same pattern; `null` removes it. A key
   * that's a whole `URLPattern` (`https://*-preview.example.com/:path*`) takes every request to
   * the hosts it matches, whatever the path (see runtime/routes.ts).
   */
  routes?: Record<string, Route | null>;
  /**
   * Who a request is, by a credential this plugin knows (see `Who`). The
   * runtime asks each plugin's, in plugin order; the first that answers wins.
   */
  who?: Who;
};

/**
 * A cookie, as `runtime.fetch` keeps it for a plugin (see runtime/cookies.ts):
 * by its plain name, which the runtime turns into the one it goes by
 * (`__Host-<name>` wherever it's Secure, renamed as `resources.cookies` says).
 */
export type Cookies = {
  /** The secret the request carries under this name; undefined for none, or one unfit for a cookie. */
  get(name: string): string | undefined;
  /**
   * Sets it on the route's response: `secret` is 1 to 512 cookie-safe
   * characters (a credential's, long: the plugin's to make so), kept `days`
   * (30 unless said), `SameSite=Lax` unless `strict`.
   */
  set(name: string, secret: string, options?: { days?: number; sameSite?: "lax" | "strict" }): void;
  /** Clears it on the route's response, as it was set (`sameSite` as it was, `lax` unless said). */
  clear(name: string, options?: { sameSite?: "lax" | "strict" }): void;
};

/** What a route is given beside its request. */
export type RouteContext = {
  /** The runtime, as trusted code: what a route calls runs as the actor it names, or the system. */
  runtime: Owner;
  /** Who the request is, as plugins' `who` say: `{ kind: "anonymous", id: "" }` when none does. */
  actor: Actor;
  /** The pattern's named groups (`:name`) and wildcards (`0`…), as the URL has them (still encoded). */
  params: Record<string, string>;
  /** The request's cookies, and this route's to set and clear on its response. */
  cookies: Cookies;
};

/**
 * A plugin's HTTP: a plain function from a `Request` to a `Response`. Routes
 * deal with HTTP; the work is an Action's, called with plain data. The
 * request is as the browser sent it, on the site it asked for (the front's
 * host) and under the app's base (`/o/<org>/x` is `/x`). What it throws is
 * answered as an error (`failure`'s code: 400, 401, 403, 404, 429, else 500).
 */
export type Route = (request: Request, ctx: RouteContext) => Response | Promise<Response>;

/** What `who` is given beside the request. */
export type WhoContext = {
  resources: Resources;
  /** Runs a named query as the system, kept a few seconds per query and params. */
  query<R = unknown>(name: string, params?: unknown): Promise<R>;
  /** Calls an Action as the system: what a credential's use changes (a key's last use). */
  call<R = unknown>(action: string, input?: unknown): Promise<R>;
  /** The request's cookies, by their plain names (see `Cookies`). */
  cookies: Pick<Cookies, "get">;
};

/**
 * Who a request is, by a credential its plugin knows (a session's cookie, a
 * key in `Authorization`): the actor it proves, or nothing, for the next
 * plugin's to say. A request with no credential of its own costs nothing
 * here: each plugin reads its credential first, and asks only when there is one.
 */
export type Who = (
  request: Request,
  ctx: WhoContext,
) => Actor | null | undefined | Promise<Actor | null | undefined>;

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
 *
 * Asked about an outsider's own read or write (`direct`: REST, the socket)
 * before it runs, a rule speaks for it (any answer but `undefined`) or not:
 * a collection no rule speaks for never reaches outsiders. A rule may refuse
 * it there (throwing, `forbidden`): a read it won't watch as asked (a
 * contact's that doesn't name what of its own it reads would run again on
 * every change to the collection), or a write that only an Action's logic
 * may make (who's in a space, a session, a key).
 */
export type Guard = (
  actor: Actor,
  operation: {
    collection: string;
    /** Reads, or writes (inserts, updates, replaces and deletes). */
    access: "read" | "write";
    filter?: Filter;
    /** An outsider's own read or write (REST, the socket), asked before it runs. */
    direct?: true;
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
    private?: string[];
    allow?(actor: Actor, input: Infer<S>): boolean;
    run(ctx: Context, input: Infer<S>): R | Promise<R>;
  },
): ActionDef => def as ActionDef;

export const defineProcessor = (def: ProcessorDef): ProcessorDef => def;

export type { Filter, FindOptions };
