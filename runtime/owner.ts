/**
 * The owner (cell): the only holder of its store. It commits every write,
 * sequences events, publishes events and live frames, and schedules
 * Processors. Plugin code runs in executors, which reach the store only by
 * sending ops to the owner over Oxian.
 */
import { plan } from "./aggregate.ts";
import { type Metrics, noMetrics } from "./metrics.ts";
import { type Clock, type Scheduled, systemClock, TIMERS } from "./schedules.ts";
import { createTimers } from "./timers.ts";
import type { IndexSpec, ScalarType } from "./store.ts";
import { createHypervisor, type Hypervisor, type HypervisorOptions } from "@oxian/oxian-js";
import type { Guard, Plugins, ProcessorDef, RenderOptions, Resources, ViewDef } from "./define.ts";
import { type Blobs, hydrate, offload } from "./blobs.ts";
import { createCache } from "./cache.ts";
import { createObservers, type Observation, type ObserveOptions } from "./observe.ts";
import { reading, startup } from "./reads.ts";
import { BROWSER, createBrowsers, READ_VIEW, readView, SESSION, WIRE } from "./browsers.ts";
import { memoryStore } from "./memory.ts";
import {
  type Hooks,
  isRead,
  type Op,
  type Outcome,
  perform,
  read,
  type ReadOp,
  type StoreOp,
  type WriteOp,
} from "./ops.ts";
import { check, matches } from "./mongo.ts";
import {
  canonical,
  checked,
  compile,
  events,
  fingerprint,
  invalid,
  json,
  merge,
} from "./registry.ts";
import type {
  Actor,
  Blob,
  Change,
  Command,
  Event,
  Filter,
  Reader,
  Store,
  Transaction,
} from "./store.ts";
import {
  decode,
  DISPATCH,
  encode,
  failure,
  type Job,
  type Line,
  lines,
  OP,
  type OpRequest,
  raise,
  RUN,
} from "./wire.ts";

export type Transport = HypervisorOptions["transports"][number];

export type Feed =
  | { kind: "event"; event: Event }
  | { kind: "frame"; channel: string; data: unknown };

export type Stats = {
  /** Database round trips (0 for memory). */
  roundTrips: number;
  /** Processor deliveries and timer occurrences not yet finished. */
  pending: number;
  /** Jobs sent to executors. */
  jobs: number;
  /** Calls executors made to the owner, each carrying one or more ops. */
  calls: number;
  /** Executors connected and ready for jobs. */
  executors: number;
  /** Browsers connected, as people. */
  browsers: number;
  /** Reads answered from the owner's cache, and reads that went to the store. */
  hits: number;
  misses: number;
};

/** What a runtime's plugins declare, for hosts: help, forms, defaults. */
export type Description = {
  collections: Record<string, { schema: unknown }>;
  actions: Record<string, { description?: string; input?: unknown }>;
  /** The media each kind has a View for. */
  views: Record<string, string[]>;
  resources: Resources;
};

export type Owner = {
  /**
   * Runs an action. Pass your own `id` to make retries safe: a call whose id
   * already completed returns its recorded result without running again, and
   * a call whose id is still running joins it.
   *
   * With `actor`, it runs for them: the Action must `allow` them, and
   * everything it causes is theirs, its reads and writes checked against the
   * rules (`guard`). Without, it runs as the system.
   */
  call<R = unknown>(
    action: string,
    input?: unknown,
    options?: { id?: string; actor?: Actor },
  ): Promise<R>;
  /** Runs a collection's named query: `query("message.history", { thread })`. */
  query<R = unknown>(name: string, params?: unknown, options?: { actor?: Actor }): Promise<R>;
  /**
   * Renders `item` through the View for `kind` in a medium (`"cli"`, `"llm"`…),
   * or the medium's default View (kind `"*"`); undefined when there's neither.
   */
  render<R = unknown>(
    renderer: string,
    kind: string,
    item: unknown,
    options?: RenderOptions,
  ): Promise<R | undefined>;
  /** What the plugins declare: collections' schemas, Actions, Views by kind, resources. */
  describe(): Description;
  /**
   * Observes a View: its output now, and again whenever what it read
   * changes; each View it shows is a part that runs again on its own (see
   * runtime/observe.ts). Its Views run here, in this process, and call
   * Actions from their handlers: what a terminal or a browser draws.
   */
  observe<R = unknown>(
    medium: string,
    kind: string,
    item: unknown,
    options?: ObserveOptions,
  ): Observation<R>;
  /** Commits an event, as a client does: Processors that handle its type react to it. */
  emit(
    type: string,
    data?: Record<string, unknown>,
    options?: { id?: string; actor?: Actor },
  ): Promise<void>;
  subscribe(listener: (item: Feed) => void): () => void;
  /**
   * Stops work that's running: an Action call by id (one a client or a
   * timer started), or what a Processor is doing for a key. It ends as
   * failed with code `cancelled`, and a cancelled delivery isn't retried.
   * False when nothing was running.
   */
  cancel(target: { call: string } | { processor: string; key: string }): Promise<boolean>;
  /** Resolves when no Processor delivery or timer occurrence is pending, and observed Views caught up. */
  idle(): Promise<void>;
  /**
   * Fires the timers now due and arms the clock for the next. The clock does
   * this itself; a host whose clock only rings (a Durable Object's alarm) calls it.
   */
  wake(): Promise<void>;
  stats(): Stats;
  /** The Oxian Hypervisor executors connect to; serve it to accept remote executors. */
  hypervisor: Hypervisor;
  close(): Promise<void>;
};

const SYSTEM = "sys.";
/** A held transaction with no op for this long is rolled back. */
const HOLD_IDLE_MS = 30_000;
/** An idle owner saves Processor cursors this long after their last advance. */
const CURSOR_FLUSH_MS = 200;
const DAY = 86_400_000;
/**
 * A Processor delivery is tried this many times before `processor.failed`;
 * once, when its failure is `final` (it was tried again already, as long as
 * it should be).
 */
const DELIVERY_ATTEMPTS = 3;

const aborted = Object.freeze({ aborted: true });

const forbidden = (message: string) => Object.assign(new Error(message), { code: "forbidden" });

/** Strings compared in time that doesn't depend on where they differ (keys). */
function same(a: string, b: string): boolean {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)];
  let differ = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) differ |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return differ === 0;
}

export async function createOwner(
  options: {
    store: Store;
    plugins: Plugins;
    transports: Transport[];
    /** Executors connecting over a remote transport must present this key. */
    key?: string;
    /** Where large values live; by default, in the store itself. */
    blobs?: Blobs;
    /** Strings over this many bytes become blobs (default 16 KiB). */
    blobThreshold?: number;
    /** The read cache's size, or false to read the store every time. */
    cache?: { documents?: number; queries?: number } | false;
    /** Where the owner records its metrics (jobs, ops, commits, events, lag, cache). */
    metrics?: Metrics;
    /** What timers run on (the system's by default; `manualClock` in tests). */
    clock?: Clock;
    /**
     * Who a browser is, from what it presents when it connects (a one-time
     * ticket the host issued): undefined refuses it. Without it, no browsers.
     */
    admit?(secret: string): Actor | undefined | Promise<Actor | undefined>;
  },
): Promise<Owner> {
  const { store } = options;
  const registry = merge(options.plugins);
  // The View a browser's watched read is: one read, made as its person.
  registry.views[READ_VIEW] = { [WIRE]: readView as ViewDef };
  const declared = events(registry);
  const metrics = options.metrics ?? noMetrics;
  await checked(registry, startup(registry, metrics));
  const measure = {
    jobs: metrics.histogram("copilotz.job.duration", {
      unit: "ms",
      description: "Jobs run on executors: Action calls, Processor deliveries, queries",
    }),
    ops: metrics.histogram("copilotz.op.duration", {
      unit: "ms",
      description: "Executors' requests, as the owner served them",
    }),
    commits: metrics.histogram("copilotz.commit.duration", {
      unit: "ms",
      description: "Commits to the store",
    }),
    events: metrics.counter("copilotz.events", { description: "Events committed" }),
    lag: metrics.gauge("copilotz.processor.lag", {
      unit: "{event}",
      description: "Events a Processor has yet to finish",
    }),
    executors: metrics.gauge("copilotz.executors", { description: "Executors connected" }),
    cache: metrics.counter("copilotz.cache.reads", {
      description: "Reads the owner's cache answered (hit) or passed to the store (miss)",
    }),
  };
  // A Processor filter the reference can't evaluate fails here, not when an event arrives.
  for (const [name, processor] of Object.entries(registry.processors)) {
    try {
      if (processor.where) check(processor.where);
    } catch (error) {
      throw invalid(`Processor "${name}" where: ${(error as Error).message}`);
    }
  }
  const validators = Object.fromEntries(
    Object.entries(registry.collections).map(([name, def]) => [
      name,
      compile(def.schema, `collection "${name}"`),
    ]),
  );
  const vectorFields = (collection: string) => registry.collections[collection]?.vectors ?? [];
  // Collections kept in memory only (`durable: false`): not in the store, no events.
  const fleeting = new Set(
    Object.entries(registry.collections).flatMap(([name, def]) =>
      def.durable === false ? [name] : []
    ),
  );
  const memory = fleeting.size ? memoryStore() : undefined;
  const inMemory = (op: Op): boolean => "collection" in op && fleeting.has(op.collection);
  const known = (op: Op) => {
    if (!("collection" in op) || op.collection.startsWith(SYSTEM)) return;
    if (!validators[op.collection]) throw invalid(`Unknown collection "${op.collection}"`);
    // A pipeline the stores can't run fails here, before any store sees it.
    if (op.op === "aggregate") plan(op.pipeline);
    // Records are appended, once: the same record sent again is the one already kept.
    if (registry.collections[op.collection].records) {
      if (op.op === "insert") op.ifAbsent = true;
      else if (op.op === "update" || op.op === "replace" || op.op === "delete") {
        throw invalid(`"${op.collection}" holds records: they are appended, never changed`);
      }
    }
    if (op.op === "nearest") {
      // The collection's vector field, when it has just one.
      const fields = vectorFields(op.collection);
      op.field ??= fields.length === 1 ? fields[0] : undefined;
      if (!op.field || !fields.includes(op.field)) {
        throw invalid(
          op.field
            ? `"${op.field}" is not a vector field of "${op.collection}"`
            : `Name the vector field of "${op.collection}" to search`,
        );
      }
      if (!Array.isArray(op.vector) || !op.vector.every(Number.isFinite)) {
        throw invalid("nearest takes a vector: an array of numbers");
      }
    }
  };
  const validate = (collection: string, doc: Record<string, unknown>) => {
    if (!collection.startsWith(SYSTEM)) validators[collection](doc);
  };

  const closing = new AbortController();
  // Time calls Actions: one clock, for the earliest timer (see timers.ts).
  const timers = createTimers({
    store,
    clock: options.clock ?? systemClock,
    schedules: registry.schedules,
    actions: registry.actions,
    write: (ops) => writeEach(ops),
    call: (action, input, id, scheduled, actor) => begin(action, input, id, true, scheduled, actor),
    track: (work) => track(work),
    signal: closing.signal,
    metrics,
  });

  // Indexed fields must be scalars their schema types, so stores may compare them as such.
  const indexes = Object.fromEntries(
    Object.entries(registry.collections).filter(([name, def]) =>
      def.indexes?.length && !fleeting.has(name)
    ).map((
      [name, def],
    ) => [
      name,
      def.indexes!.map((fields): IndexSpec => ({
        fields: fields.map((path) => {
          const type = path === "_id" ? undefined : scalarOf(def.schema, path);
          if (!type) {
            throw invalid(
              `Collection "${name}" indexes "${path}", which its schema doesn't type as a string, ` +
                `number or boolean`,
            );
          }
          return { path, type };
        }),
      })),
    ]),
  );
  // Timers are found by when they're due.
  indexes[TIMERS] = [{ fields: [{ path: "at", type: "string" }] }];
  const { epoch } = await store.open();
  const memoryEpoch = memory ? (await memory.open()).epoch : 0;
  await store.describe?.(
    Object.fromEntries(
      Object.entries(registry.collections).flatMap(([name, def]) =>
        fleeting.has(name) ? [] : [[name, def.schema]]
      ),
    ),
  );
  await store.index?.(indexes);
  const listeners = new Set<(item: Feed) => void>();
  const publish = (item: Feed) => {
    for (const listener of listeners) listener(item);
  };
  let jobs = 0;
  let calls = 0;

  // Processor cursors ride on the next commit that writes documents, and are
  // saved on their own at most CURSOR_FLUSH_MS after they first move.
  const unsaved = new Map<string, number>();
  let flushing: ReturnType<typeof setTimeout> | undefined;

  /**
   * One store transaction = one owner command. Committed events go out at once.
   * `cursors: false` keeps a commit that only records events from carrying
   * cursor writes, so a store can make it a single statement.
   */
  const commit = async <R>(
    work: (tx: Transaction, seen: Seen) => Promise<R>,
    cursors = true,
    later?: Later,
  ): Promise<R> => {
    const saving: [string, number][] = cursors ? [...unsaved] : [];
    const seen: Seen = [];
    const started = performance.now();
    const { result, events } = await store.transaction(epoch, (tx) => work(tx, seen), {
      ...(saving.length ? { positions: Object.fromEntries(saving) } : {}),
    });
    measure.commits.record(performance.now() - started, { path: "transaction" });
    if (later?.ops.length) later.results = await remember(later.ops, seen);
    committed(saving, events, seen);
    return result;
  };

  /** Writes to in-memory collections that wait for the store's commit, then their results. */
  type Later = { ops: StoreOp[]; results?: unknown[] };

  /** Performs ops on in-memory collections: each one's result; what they changed goes in `seen`. */
  const remember = async (ops: StoreOp[], seen: Seen): Promise<unknown[]> => {
    const { result } = await memory!.transaction(memoryEpoch, async (tx) => {
      const hooks: Hooks = {
        validate,
        offload: (value) => Promise.resolve(value),
        changed: (collection, changes) => void seen.push([collection, changes]),
        vectors: vectorFields,
      };
      const values: unknown[] = [];
      for (const op of ops) {
        values.push(isRead(op) ? await read(tx, op) : await perform(tx, op, hooks));
      }
      return values;
    });
    return result;
  };

  /** The documents a command changed, by collection. The cache hears them once committed. */
  type Seen = [string, Change[]][];

  const committed = (saving: [string, number][], events: Event[], seen: Seen = []) => {
    // Before the events go out, so anything reacting to them reads the new state.
    for (const [collection, changes] of seen) {
      if (!fleeting.has(collection)) cache?.apply(collection, changes);
      if (collection === TIMERS) timers.changed(changes);
    }
    for (const [name, seq] of saving) if (unsaved.get(name) === seq) unsaved.delete(name);
    for (const event of events) {
      measure.events.add(1, { type: event.type });
      publish({ kind: "event", event });
      route(event);
    }
    if (seen.length) observers.changed(seen);
  };

  /**
   * A request of writes (with any emits among them) runs as the store's single
   * command when it can: fence, writes, their events, blobs and positions in
   * one round trip. Otherwise it is an ordinary transaction.
   */
  const write = async (ops: StoreOp[], by: By = {}): Promise<unknown> => {
    const results = await writeEach(ops, by);
    // Like a transaction, the request answers with its last op's result.
    return ops.at(-1)!.op === "emit" ? undefined : results.at(-1);
  };

  /**
   * On whose behalf writes happen: what they answer to, who does them, and
   * the rules what they leave must keep, by collection.
   */
  type By = {
    cause?: string;
    actor?: Actor;
    keep?: Map<string, Filter>;
    /** Hears what each read returned (for labels). */
    saw?: (op: ReadOp, value: unknown) => void;
  };

  /** Commits ops together: each write's result, in order (emits answer nothing). */
  const writeEach = async (ops: StoreOp[], by: By = {}): Promise<unknown[]> => {
    if (!memory || !ops.some(inMemory)) return await writeStore(ops, by);
    // In-memory collections change once the store has committed the rest.
    const later: Later = { ops: ops.filter(inMemory) };
    const rest = ops.filter((op) => !inMemory(op));
    let stored: unknown[] = [];
    if (rest.length) stored = await writeStore(rest, by, later);
    else {
      const seen: Seen = [];
      later.results = await remember(later.ops, seen);
      committed([], [], seen);
    }
    let [s, m] = [0, 0];
    return ops.filter((op) => op.op !== "emit").map((op) =>
      inMemory(op) ? later.results![m++] : stored[s++]
    );
  };

  /** Commits ops to the store, then `later`'s to memory: each write's result, in order. */
  const writeStore = async (ops: StoreOp[], by: By, later?: Later): Promise<unknown[]> => {
    const { cause, actor } = by;
    const writes = ops.filter((o): o is WriteOp => !isRead(o) && o.op !== "emit");
    // Writes to collections with vector fields also write the store's vectors, and
    // what writes leave may have to keep to a rule: a transaction.
    const plain = writes.every((o) => !("collection" in o) || !vectorFields(o.collection).length) &&
      !by.keep?.size;
    if (store.command && writes.length && plain && ops.every((o) => !isRead(o))) {
      for (const op of writes) {
        if (op.op === "insert") {
          for (const { _id: _, ...fields } of op.docs) validate(op.collection, fields);
        }
        if (op.op === "replace") validate(op.collection, op.doc);
      }
      const blobs: Blob[] = [];
      const put = (blob: Blob) => (blobs.push(blob), Promise.resolve());
      const large = <T>(value: T) => offload(value, put, options.blobThreshold);
      // The same values perform() offloads: documents, updates, edge data, event data.
      const steps: Command["steps"] = await Promise.all(ops.map(async (op) => {
        switch (op.op) {
          case "emit":
            return {
              emit: { ...op.event, ...(actor ? { actor } : {}), data: await large(op.event.data) },
            };
          case "insert":
            return {
              write: { ...op, docs: await large(op.docs) },
              record: recorded(op.collection),
            };
          case "update":
            return {
              write: { ...op, update: await large(op.update) },
              record: recorded(op.collection),
            };
          case "replace":
            return { write: { ...op, doc: await large(op.doc) }, record: recorded(op.collection) };
          case "delete":
            return { write: op, record: recorded(op.collection) };
          case "link":
            return { write: { ...op, edge: await large(op.edge) }, record: false };
          default:
            return { write: op as WriteOp, record: false };
        }
      }));
      // Blobs kept elsewhere are written before anything can refer to them.
      if (options.blobs) await Promise.all(blobs.map((blob) => options.blobs!.put(blob)));
      const saving: [string, number][] = [...unsaved];
      const run = store.command(epoch, {
        steps,
        ...(cause ? { cause } : {}),
        ...(actor ? { actor } : {}),
        blobs: options.blobs ? [] : blobs,
        ...(saving.length ? { positions: Object.fromEntries(saving) } : {}),
      });
      if (run) {
        const started = performance.now();
        const { results, events, changes } = await run;
        measure.commits.record(performance.now() - started, { path: "command" });
        const seen: Seen = writes.flatMap((op, i) =>
          "collection" in op ? [[op.collection, changes[i] ?? []] as [string, Change[]]] : []
        );
        if (later?.ops.length) later.results = await remember(later.ops, seen);
        committed(saving, events, seen);
        return results;
      }
    }
    const results = await commit(
      (tx, seen) => performEach(tx, ops, by, seen),
      ops.some((op) => op.op !== "emit"),
      later,
    );
    return results.filter((_, i) => ops[i].op !== "emit");
  };

  // Large values: in the configured blob store, or in the store's own blobs.
  const blobsOf = (reader: Reader) => (id: string) =>
    options.blobs ? options.blobs.get(id) : reader.blob(id);
  // Reads of committed state go through the cache; reads in a transaction see its own writes.
  const cache = options.cache === false ? undefined : createCache({
    ...options.cache,
    onRead: (hit) => measure.cache.add(1, { result: hit ? "hit" : "miss" }),
  });
  const cached = (op: ReadOp): Promise<unknown> => {
    switch (op.op) {
      case "find":
        return cache!.find(
          op.collection,
          op.filter,
          op.options,
          () => store.find(op.collection, op.filter, op.options),
        );
      case "findOne": {
        const options = { ...op.options, limit: 1 };
        return cache!.find(
          op.collection,
          op.filter,
          options,
          () => store.find(op.collection, op.filter, options),
        ).then((docs) => docs[0] ?? null);
      }
      case "count":
        return cache!.count(op.collection, op.filter, () => store.count(op.collection, op.filter));
      case "aggregate":
        return cache!.aggregate(
          op.collection,
          op.pipeline,
          () => store.aggregate(op.collection, plan(op.pipeline)),
        );
      default:
        return read(store, op);
    }
  };
  const answer = (reader: Reader, op: ReadOp) =>
    memory && inMemory(op)
      ? read(memory, op)
      : (reader === store && cache ? cached(op) : read(reader, op))
        .then((value) => hydrate(value, blobsOf(reader)));

  // Views observed here read committed state, as clients do; their handlers call and emit.
  // What comes from outside is a declared event, and the actor one it lets emit it.
  const emit = async (
    type: string,
    data: Record<string, unknown> = {},
    options: { id?: string; actor?: Actor } = {},
  ) => {
    const def = declared(type, data);
    const { actor } = options;
    if (actor && actor.kind !== "system" && !def.allow?.(actor)) {
      throw forbidden(`${actor.kind} ${actor.id} may not emit "${type}".`);
    }
    await write(
      [{
        op: "emit",
        event: { type, data: json(data), ...(options.id ? { id: options.id } : {}) },
      }],
      options.actor ? { actor: options.actor } : {},
    );
  };
  const observers = createObservers({
    views: registry.views,
    reads: (track, actor) => {
      // An actor's Views see what they reach, and what the rules read to
      // know it (memberships) is what they read too: they follow its changes.
      const rules = actor
        ? reading(registry, (op) => {
          track(op);
          return answer(store, op as ReadOp);
        }, () =>
          crypto.randomUUID(), metrics)
        : ruleReads;
      return reading(
        registry,
        async (op) => {
          known(op);
          track(op);
          const [read] = (await guard([op as ReadOp], actor, rules)).ops;
          const value = await answer(store, read as ReadOp);
          return actor ? hidden(read as ReadOp, value) : value;
        },
        (collection, doc) => {
          // What a read used (an embedding's tokens): recorded on its own.
          const _id = typeof doc._id === "string" ? doc._id : crypto.randomUUID();
          const op: StoreOp = { op: "insert", collection, docs: [{ ...doc, _id }] };
          known(op);
          void writeEach([op]).catch(() => {});
          return _id;
        },
        metrics,
        actor,
      );
    },
    call: (action, input, actor) => api.call(action, input, actor ? { actor } : {}),
    emit: (type, data, actor) => emit(type, data, actor ? { actor } : {}),
  });

  // Every change to a declared collection is an event, committed with it; records are their own.
  const recorded = (collection: string) =>
    !collection.startsWith(SYSTEM) && registry.collections[collection]?.events !== false &&
    !registry.collections[collection]?.records && !fleeting.has(collection);
  const lifecycle = (tx: Transaction, collection: string, changes: Change[], by: By) => {
    if (!recorded(collection)) return;
    const { cause } = by;
    const actor = by.actor ? { actor: by.actor } : {};
    // The log keeps no private field: a token or key never lands in an event.
    const kept = registry.collections[collection]?.private ?? [];
    const open = <D extends Record<string, unknown>>(doc: D): D =>
      kept.length ? unprivate(doc, kept) as D : doc;
    for (const { _id, before, after } of changes) {
      if (!before) {
        tx.emit({
          type: `${collection}.created`,
          data: { _id, doc: open(after!) },
          cause,
          ...actor,
        });
      } else if (!after) {
        tx.emit({
          type: `${collection}.deleted`,
          data: { _id, doc: open(before) },
          cause,
          ...actor,
        });
      } else {
        const changed = Object.keys(after).filter((key) =>
          canonical(after[key]) !== canonical(before[key])
        ).sort();
        const removed = Object.keys(before).filter((key) => !(key in after)).sort();
        tx.emit({
          type: `${collection}.updated`,
          data: { _id, doc: open(after), changed, removed },
          cause,
          ...actor,
        });
      }
    }
  };

  const performAll = async (
    tx: Transaction,
    ops: StoreOp[],
    by: By,
    seen?: Seen,
    later?: Later,
  ) => (await performEach(tx, ops, by, seen, later)).at(-1);

  /** Performs ops in `tx`; writes to in-memory collections wait in `later`, answering nothing. */
  const performEach = async (
    tx: Transaction,
    ops: StoreOp[],
    by: By,
    seen?: Seen,
    later?: Later,
  ) => {
    const hooks: Hooks = {
      validate,
      offload: (value) =>
        offload(
          value,
          (blob) => options.blobs ? options.blobs.put(blob) : tx.putBlob(blob),
          options.blobThreshold,
        ),
      changed: (collection, changes) => {
        // What an actor's write leaves must stay within what they reach.
        const keep = by.keep?.get(collection);
        if (keep && changes.some(({ after }) => after && !matches(after, keep))) {
          throw forbidden(`That would put a "${collection}" document out of your reach.`);
        }
        seen?.push([collection, changes]);
        lifecycle(tx, collection, changes, by);
      },
      vectors: vectorFields,
    };
    const values: unknown[] = [];
    for (const op of ops) {
      if (isRead(op)) {
        const value = await answer(tx, op);
        by.saw?.(op, value);
        values.push(value);
      } else if (later && inMemory(op)) values.push((later.ops.push(op), undefined));
      else if (op.op === "emit" && by.actor) {
        values.push(await perform(tx, { ...op, event: { ...op.event, actor: by.actor } }, hooks));
      } else values.push(await perform(tx, op, hooks));
    }
    return values;
  };

  // Who reaches what: the plugins' rules, as filters (see `Guard`). They read freely.
  const ruleReads = reading(
    registry,
    (op) => answer(store, op as ReadOp),
    (_, doc) => typeof doc._id === "string" ? doc._id : crypto.randomUUID(),
    metrics,
  );
  /** An actor's rule on a collection, for an operation with this filter; none: unrestricted. */
  const rule = async (
    actor: Actor,
    access: "read" | "write",
    collection: string,
    filter?: Filter,
    reads = ruleReads,
  ): Promise<Filter | undefined> => {
    if (actor.kind === "system" || collection.startsWith(SYSTEM)) return undefined;
    const rules: Filter[] = [];
    for (const guard of registry.guards as Guard[]) {
      const found = await guard(
        actor,
        { collection, access, ...(filter ? { filter } : {}) },
        reads,
      );
      if (found !== undefined && found !== true) rules.push(found);
    }
    return rules.length > 1 ? { $and: rules } : rules[0];
  };
  /** Whether any rule speaks for a collection's reads by this actor: a browser reads nothing else directly. */
  const ruled = async (actor: Actor, collection: string) => {
    for (const guard of registry.guards as Guard[]) {
      if (await guard(actor, { collection, access: "read" }, ruleReads) !== undefined) return true;
    }
    return false;
  };
  /** Whether an actor may run a query from outside: one that lets them, as Actions do. */
  const askable = (
    actor: Actor | undefined,
    collection: string,
    query: string,
    params: unknown,
  ) => {
    if (!actor || actor.kind === "system") return true;
    const def = registry.collections[collection]?.queries?.[query];
    return typeof def === "object" && def.allow(actor, params);
  };
  const both = (filter: Filter | undefined, rule: Filter): Filter =>
    filter && Object.keys(filter).length ? { $and: [filter, rule] } : rule;

  /**
   * An actor's ops within the rules: reads, updates and deletes reach only
   * what matches; inserts must; and what updates leave must still match
   * (`keep`, checked as they're written).
   */
  const guard = async (ops: StoreOp[], actor: Actor | undefined, reads = ruleReads) => {
    const keep = new Map<string, Filter>();
    if (!actor || !registry.guards.length) return { ops, keep };
    const checked = await Promise.all(ops.map(async (op): Promise<StoreOp> => {
      if (!("collection" in op)) return op;
      switch (op.op) {
        case "find":
        case "findOne":
        case "count":
        case "delete": {
          const access = op.op === "delete" ? "write" : "read";
          const found = await rule(actor, access, op.collection, op.filter, reads);
          return found ? { ...op, filter: both(op.filter, found) } : op;
        }
        case "aggregate": {
          const found = await rule(actor, "read", op.collection, undefined, reads);
          return found ? { ...op, pipeline: [{ $match: found }, ...op.pipeline] } : op;
        }
        case "nearest": {
          const found = await rule(actor, "read", op.collection, op.options.filter, reads);
          return found
            ? { ...op, options: { ...op.options, filter: both(op.options.filter, found) } }
            : op;
        }
        case "insert": {
          const found = await rule(actor, "write", op.collection, undefined, reads);
          if (found && op.docs.some((doc) => !matches(doc, found))) {
            throw forbidden(`That "${op.collection}" document would be out of your reach.`);
          }
          return op;
        }
        case "update":
        case "replace": {
          const [found, all] = await Promise.all([
            rule(actor, "write", op.collection, op.filter, reads),
            rule(actor, "write", op.collection, undefined, reads),
          ]);
          if (all) keep.set(op.collection, all);
          return found ? { ...op, filter: both(op.filter, found) } : op;
        }
      }
    }));
    return { ops: checked, keep };
  };

  // Private fields: what an outside reader's reads come without (see `CollectionDef.private`).
  const hidden = (op: ReadOp, value: unknown): unknown => {
    const fields = "collection" in op ? registry.collections[op.collection]?.private : undefined;
    if (!fields?.length || value === null || typeof value !== "object") return value;
    const without = (doc: Record<string, unknown>) => unprivate(doc, fields);
    return Array.isArray(value)
      ? value.map((doc) => without(doc as Record<string, unknown>))
      : without(value as Record<string, unknown>);
  };

  // Labels: what each actor's job read, carried to what it then writes (see `Labels`).
  const labelled = new Map<string, Set<string>>();
  const notice = (job: string, actor: Actor | undefined, op: ReadOp, value: unknown) => {
    if (!registry.labels || !actor || actor.kind === "system" || !("collection" in op)) return;
    if (op.op !== "find" && op.op !== "findOne" && op.op !== "nearest") return;
    const docs = (Array.isArray(value) ? value : value ? [value] : []) as Record<string, unknown>[];
    if (!docs.length) return;
    const found = registry.labels.read(op.collection, docs, ruleReads);
    if (!found.length) return;
    if (!labelled.has(job)) labelled.set(job, new Set());
    for (const one of found) labelled.get(job)!.add(one);
  };
  /** An actor's inserts and replaces, as the labels have them, given what their job read. */
  const label = async (ops: StoreOp[], actor: Actor | undefined, job: string) => {
    const read = labelled.get(job);
    const labels = registry.labels;
    if (!labels || !actor || actor.kind === "system" || !read?.size) return ops;
    const seen = [...read];
    return await Promise.all(ops.map(async (op): Promise<StoreOp> => {
      if (op.op === "insert") {
        return {
          ...op,
          docs: await Promise.all(
            op.docs.map((doc) => labels.write(actor, op.collection, doc, seen, ruleReads)),
          ) as typeof op.docs,
        };
      }
      if (op.op === "replace") {
        return {
          ...op,
          doc: await labels.write(actor, op.collection, op.doc, seen, ruleReads) as typeof op.doc,
        };
      }
      return op;
    }));
  };

  // Transactions an executor holds open across several calls, bound to the job that opened them.
  /** A request to a held transaction, its timer ops already writes. */
  type HeldRequest = Omit<Extract<OpRequest, { tx: string }>, "ops"> & {
    ops: StoreOp[];
    keep?: Map<string, Filter>;
    saw?: By["saw"];
  };
  type Held = { job: string; send(request: HeldRequest): Promise<unknown> };
  const held = new Map<string, Held>();
  const heldBy = new Map<string, Set<string>>();

  const hold = (id: string, job: string): Held => {
    type Message = {
      request: HeldRequest;
      reply: PromiseWithResolvers<unknown>;
    };
    const inbox: Message[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let ending: { reply: PromiseWithResolvers<unknown>; value: unknown } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send: Held["send"] = (request) => {
      if (closed) return Promise.reject(invalid("The transaction is closed."));
      clearTimeout(timer);
      if (request.end) closed = true;
      else {
        timer = setTimeout(
          () => send({ tx: id, ops: [], end: "abort" }).catch(() => {}),
          HOLD_IDLE_MS,
        );
      }
      const reply = Promise.withResolvers<unknown>();
      inbox.push({ request, reply });
      wake?.();
      return reply.promise;
    };
    const next = async () => {
      while (!inbox.length) await new Promise<void>((resolve) => wake = resolve);
      return inbox.shift()!;
    };
    const later: Later = { ops: [] };
    commit(
      async (tx, seen) => {
        for (;;) {
          const { request, reply } = await next();
          let value: unknown;
          // As in MongoDB, a failed op aborts its transaction.
          try {
            value = await performAll(
              tx,
              request.ops,
              {
                ...(request.cause ? { cause: request.cause } : {}),
                ...(request.actor ? { actor: request.actor } : {}),
                ...(request.keep?.size ? { keep: request.keep } : {}),
                ...(request.saw ? { saw: request.saw } : {}),
              },
              seen,
              later,
            );
          } catch (error) {
            reply.reject(error);
            throw error;
          }
          if (!request.end) {
            reply.resolve(value);
            continue;
          }
          ending = { reply, value };
          if (request.end === "abort") throw aborted;
          return;
        }
      },
      true,
      later,
    ).then(
      () => ending!.reply.resolve(ending!.value),
      (error) => {
        closed = true;
        for (const { reply } of inbox.splice(0)) reply.reject(error);
        if (error === aborted) ending?.reply.resolve(undefined);
        else ending?.reply.reject(error);
      },
    ).finally(() => {
      clearTimeout(timer);
      held.delete(id);
      heldBy.get(job)?.delete(id);
    });
    const entry = { job, send };
    held.set(id, entry);
    if (!heldBy.has(job)) heldBy.set(job, new Set());
    heldBy.get(job)!.add(id);
    return entry;
  };

  const serve = (request: OpRequest, job: string): Promise<unknown> => {
    const started = performance.now();
    const kind = "tx" in request
      ? "transaction"
      : request.ops.length === 1 && isRead(request.ops[0])
      ? "read"
      : "write";
    const done = () => measure.ops.record(performance.now() - started, { kind });
    const served = handle(request, job);
    served.then(done, done);
    return served;
  };

  const handle = async (request: OpRequest, job: string): Promise<unknown> => {
    calls++;
    const [first] = request.ops;
    if (first?.op === "cancel") {
      if ("tx" in request || request.ops.length !== 1) throw invalid("A cancel goes on its own.");
      return cancel(first);
    }
    const lowered = request.ops.map((op) => timers.lower(op, request.actor));
    lowered.forEach(known);
    const guarded = await guard(lowered, request.actor);
    const { keep } = guarded;
    const ops = await label(guarded.ops, request.actor, job);
    const saw = (op: ReadOp, value: unknown) => notice(job, request.actor, op, value);
    if (!("tx" in request)) {
      const [first, ...rest] = ops;
      if (!rest.length && isRead(first)) {
        const value = await answer(store, first);
        saw(first, value);
        return request.outside ? hidden(first, value) : value;
      }
      return write(ops, {
        ...(request.cause ? { cause: request.cause } : {}),
        ...(request.actor ? { actor: request.actor } : {}),
        ...(keep.size ? { keep } : {}),
        saw,
      });
    }
    let transaction = held.get(request.tx);
    if (transaction && transaction.job !== job) throw invalid("Not this job's transaction.");
    if (!transaction) {
      if (request.end === "abort") return Promise.resolve(undefined);
      transaction = hold(request.tx, job);
    }
    return transaction.send({ ...request, ops, keep, saw });
  };

  // Workers of plugins' kinds (computers…): admitted by their kind's Action, then found by id.
  const connected = new Map<string, string>();
  const resumed = new Map<string, { kind: string; id: string; until: number }>();
  const workerKey = (kind: string, id: string) => `${kind}\u0000${id}`;
  /** Who a worker of a plugin's kind is, from `<kind>:<secret>`; undefined: not one. */
  const workerOf = async (credential: { kind: string; capability: unknown }) => {
    const capability = String(credential.capability);
    const kind = capability.slice(0, Math.max(capability.indexOf(":"), 0));
    const def = registry.workers[kind];
    if (!def) return undefined;
    if (credential.kind === "resume") {
      const kept = resumed.get(capability);
      if (!kept || kept.until < Date.now()) throw invalid(`Unknown ${kind}.`);
      return kept;
    }
    const who = await api.call<{ id: string } | null>(def.admit, {
      secret: capability.slice(kind.length + 1),
    });
    if (!who?.id) throw invalid(`Unknown ${kind}.`);
    return { kind, id: String(who.id) };
  };

  // Remote executors prove the shared key; a browser, a ticket the host's `admit` knows; a
  // plugin's worker, what its kind's Action knows. Oxian fences their sessions.
  let generation = 0;
  const admit: HypervisorOptions["admit"] = async (
    { identity, credential, workloads, capacity },
  ) => {
    const secret = String(credential.capability);
    const worker = await workerOf(credential);
    if (worker) {
      const now = Date.now();
      for (const [kept, { until }] of resumed) if (until < now) resumed.delete(kept);
      const again = `${worker.kind}:${crypto.randomUUID()}${crypto.randomUUID()}`;
      resumed.set(again, { ...worker, until: now + DAY });
      return {
        definition: {
          workerId: identity.workerId,
          providerId: `worker:${worker.kind}`,
          // What it may say it serves: its kind's work, and any newer work named for its kind (a
          // newer program, before the app knows that work: it's never sent any). Never anything
          // else, such as the runtime's jobs.
          workloads: workloads.filter((w) =>
            registry.workers[worker.kind].workloads.includes(w) || w.startsWith(`${worker.kind}.`)
          ),
          capacity,
          providerConfig: { kind: worker.kind, id: worker.id },
          labels: {},
        },
        sessionGeneration: ++generation,
        authenticatedWith: credential.kind,
        resume: { credential: { kind: "resume", capability: again }, expiresAtMs: now + DAY },
      };
    }
    if (!options.key || !same(secret, options.key)) {
      const actor = credential.kind === "resume"
        ? browsers.resumed(secret)
        : options.admit
        ? await options.admit(secret)
        : undefined;
      if (!actor) throw invalid("Unknown executor key.");
      // A browser: its person rides on the connection, and it takes no work but its session.
      return {
        definition: {
          workerId: identity.workerId,
          providerId: BROWSER,
          workloads: [SESSION],
          capacity: 1,
          providerConfig: browsers.config(actor),
          labels: {},
        },
        sessionGeneration: ++generation,
        authenticatedWith: credential.kind,
        resume: browsers.resume(actor),
      };
    }
    return {
      definition: {
        workerId: identity.workerId,
        providerId: "copilotz",
        workloads,
        capacity,
        providerConfig: {},
        labels: {},
      },
      sessionGeneration: ++generation,
      authenticatedWith: credential.kind,
      resume: {
        credential: { kind: "resume", capability: options.key },
        expiresAtMs: Date.now() + DAY,
      },
    };
  };

  /**
   * Each running job's authority: whom the owner sent it to work for (null:
   * the system). Every op an executor sends in a job is checked against it.
   * It acts as that actor, or, from an executor holding the owner's key, as
   * someone its code chose with `ctx.as()`, which keeps whose job it was
   * (`via`). What an executor claims never widens what its job was given.
   */
  const pinned = new Map<string, Actor | null>();
  const pinning = new Map<string, PromiseWithResolvers<Actor | null>>();
  const pin = (job: string, actor: Actor | undefined) => {
    pinned.set(job, actor ?? null);
    pinning.get(job)?.resolve(actor ?? null);
    pinning.delete(job);
  };
  /** A job's authority, once its dispatch has returned: its first op can come sooner. */
  const authority = (job: string): Promise<Actor | null> => {
    if (pinned.has(job)) return Promise.resolve(pinned.get(job)!);
    let waiting = pinning.get(job);
    if (!waiting) {
      const made = Promise.withResolvers<Actor | null>();
      const late = setTimeout(() => made.reject(forbidden("Not a job this owner sent")), 10_000);
      void made.promise.finally(() => clearTimeout(late)).catch(() => {});
      pinning.set(job, waiting = made);
    }
    return waiting.promise;
  };
  /** Whether `actor` is `given`, or acts (through `ctx.as()`, `via`) within its job. */
  const within = (actor: Actor | undefined, given: string): boolean =>
    !!actor && (canonical(actor) === given || within(actor.via as Actor | undefined, given));
  const authorize = async (request: OpRequest, job: string, trusted: boolean) => {
    const given = await authority(job);
    const claimed = request.actor;
    if (canonical(claimed ?? null) === canonical(given)) return;
    // Trusted code may act for others, and says in whose job it did.
    if (trusted && (!given || within(claimed, canonical(given)))) return;
    throw forbidden("This job can't act as that");
  };

  const ready = new Set<string>();
  const hypervisor = createHypervisor({
    transports: options.transports,
    // Its own admission whenever anyone but its in-process executors may connect.
    ...(options.admit || Object.keys(registry.workers).length ||
        options.transports.some((t) => t.type !== "in-process")
      ? { admit }
      : {}),
    config: { maxQueuedDispatches: 100_000, dispatchQueueTimeoutMs: 30_000 },
    workerCalls: {
      maxConcurrent: 65_536,
      maxPerConnection: 1_024,
      admit: (context) => {
        const job = context.parent?.operationId;
        // Only executors, in a job, reach storage or send work on: browsers and plugins'
        // workers ask nothing here.
        const provider = context.definition.providerId;
        if (!job || provider === BROWSER || provider.startsWith("worker:")) return undefined;
        if (context.workload === DISPATCH) return sending(context.metadata);
        if (context.workload !== OP) return undefined;
        // Executors holding the owner's key run the app's own code. One admitted as bound
        // (`bound:…`, an org's own) runs only as its jobs.
        const trusted = !provider.startsWith("bound:");
        return async ({ input }) => {
          try {
            const request = await decode<OpRequest>(input);
            await authorize(request, job, trusted);
            return encode({ value: await serve(request, job) });
          } catch (error) {
            return encode({ error: failure(error) });
          }
        };
      },
      // A browser's own calls: reads, Actions, events, as its person.
      admitUnassigned: (context) => browsers.admit(context),
    },
  }, {
    onReady: ({ fence, definition }) => {
      if (definition.providerId === BROWSER) {
        return browsers.ready(
          fence.identity.workerId,
          definition.providerConfig,
          fence.connectionId,
        );
      }
      if (definition.providerId.startsWith("worker:")) {
        const { kind, id } = definition.providerConfig as { kind: string; id: string };
        connected.set(workerKey(kind, id), fence.identity.workerId);
        return tell(registry.workers[kind]?.ready, id);
      }
      ready.add(fence.connectionId);
      measure.executors.set(ready.size);
    },
    onDisconnect: ({ fence, definition }) => {
      browsers.gone(fence.identity.workerId, fence.connectionId);
      if (definition.providerId.startsWith("worker:")) {
        const { kind, id } = definition.providerConfig as { kind: string; id: string };
        // A worker that came back on another connection is still there.
        if (connected.get(workerKey(kind, id)) !== fence.identity.workerId) return;
        connected.delete(workerKey(kind, id));
        return tell(registry.workers[kind]?.gone, id);
      }
      ready.delete(fence.connectionId);
      measure.executors.set(ready.size);
    },
  });
  /**
   * A worker kind's Action hears one come or go, as the system; its failure
   * is only logged. Closing waits for what it's telling.
   */
  const telling = new Set<Promise<void>>();
  const tell = (action: string | undefined, id: string) => {
    if (!action || closing.signal.aborted) return;
    const told = api.call(action, { id }).then(() => {}, (error) => {
      if (!closing.signal.aborted) {
        console.error(`${action}:`, error instanceof Error ? error.message : error);
      }
    });
    telling.add(told);
    void told.finally(() => telling.delete(told));
  };

  /**
   * A job's work sent on to a worker of a plugin's kind: it says first
   * (its metadata) whether that worker took it, then streams its output.
   */
  const sending =
    (meta: Record<string, unknown>) =>
    async ({ input, signal }: { input: ReadableStream<Uint8Array>; signal: AbortSignal }) => {
      const { kind, id, workload } = meta as { kind: string; id: string; workload: string };
      const def = registry.workers[kind];
      const refused = (message: string, code: string) => {
        void input.cancel().catch(() => {});
        return { metadata: { error: { message, code } } };
      };
      if (!def || !def.workloads.includes(workload)) {
        return refused(`No ${kind} work "${workload}"`, "invalid");
      }
      const workerId = connected.get(workerKey(kind, String(id)));
      if (!workerId) return refused(`${kind} ${id} isn't connected`, "offline");
      const handle = await hypervisor.dispatch({
        workload,
        target: { workerId },
        body: input,
        signal,
      });
      return { metadata: {}, body: handle.output };
    };

  const browsers = createBrowsers({
    observers,
    ruled,
    askable,
    call: (action, input, actor) => api.call(action, input, { actor }),
    emit: (type, data, actor) => emit(type, data, { actor }),
    dispatch: (input) => hypervisor.dispatch(input),
  });

  // Sends a job to an executor; its live frames are published as they arrive.
  const run = async (job: Job, signal?: AbortSignal): Promise<unknown> => {
    const started = performance.now();
    const what = job.kind === "call"
      ? job.action
      : job.kind === "process"
      ? job.processor
      : job.kind === "render"
      ? `${job.renderer}:${job.view}`
      : `${job.collection}.${job.query}`;
    try {
      const result = await dispatch(job, signal);
      measure.jobs.record(performance.now() - started, {
        kind: job.kind,
        name: what,
        outcome: "ok",
      });
      return result;
    } catch (error) {
      measure.jobs.record(performance.now() - started, {
        kind: job.kind,
        name: what,
        outcome: (error as { code?: string }).code === "executor_lost"
          ? "lost"
          : (error as { code?: string }).code === "cancelled"
          ? "cancelled"
          : "error",
      });
      throw error;
    }
  };

  const dispatch = async (job: Job, signal?: AbortSignal): Promise<unknown> => {
    jobs++;
    const handle = await hypervisor.dispatch({
      workload: RUN,
      body: encode(job),
      signal: signal ? AbortSignal.any([closing.signal, signal]) : closing.signal,
    });
    pin(handle.operationId, job.kind === "process" ? job.event.actor : job.actor);
    let outcome: Exclude<Line, { frame: unknown }> | undefined;
    let lost: unknown;
    try {
      for await (const line of lines(handle.output)) {
        if ("frame" in line) publish({ kind: "frame", ...line.frame });
        else outcome = line;
      }
      await handle.completed;
    } catch (error) {
      if (!outcome) lost = error;
    } finally {
      for (const id of heldBy.get(handle.operationId) ?? []) {
        held.get(id)?.send({ tx: id, ops: [], end: "abort" }).catch(() => {});
      }
      heldBy.delete(handle.operationId);
      labelled.delete(handle.operationId);
      pinned.delete(handle.operationId);
    }
    if (signal?.aborted && !closing.signal.aborted && !(outcome && "result" in outcome)) {
      // Stopped: what it committed stays; `recorded` when it ended on its own record.
      throw Object.assign(new Error("Cancelled"), { code: "cancelled", recorded: !!outcome });
    }
    if (!outcome) {
      // The job started and its executor went away: the work may be partly done.
      const reason = lost instanceof Error ? lost.message : "it ended without a result";
      throw Object.assign(new Error(`The executor was lost: ${reason}`), { code: "executor_lost" });
    }
    if ("error" in outcome) throw raise(outcome.error);
    return outcome.result;
  };

  // Action calls the clients started, by id: a repeated id joins the running call.
  const calling = new Map<
    string,
    { what: string; call: Promise<unknown>; stop: AbortController }
  >();

  const conflict = (id: string) =>
    Object.assign(new Error(`Call id "${id}" was already used for a different call.`), {
      code: "id_conflict",
    });

  /** Starts a call, or joins the running one with its id (refusing a different call under it). */
  const begin = (
    action: string,
    input: unknown,
    id: string,
    known: boolean,
    scheduled?: Scheduled,
    actor?: Actor,
  ) => {
    const what = canonical([action, input ?? null]);
    const running = calling.get(id);
    if (running) return running.what === what ? running.call : Promise.reject(conflict(id));
    const stop = new AbortController();
    const call = callAction(action, input, id, known, scheduled, stop.signal, actor)
      .finally(() => calling.delete(id));
    calling.set(id, { what, call, stop });
    return call;
  };

  const callAction = async (
    action: string,
    input: unknown,
    id: string,
    known: boolean,
    scheduled?: Scheduled,
    signal?: AbortSignal,
    actor?: Actor,
  ) => {
    let attempt = 1;
    let after: "failed" | "lost" | undefined;
    if (known) {
      // The log is the receipt: a completed call answers again without running.
      const prior = await answer(store, { op: "outcome", call: id }) as Outcome;
      if (
        prior.attempts &&
        (prior.action !== action || prior.inputHash !== await fingerprint(action, input))
      ) throw conflict(id);
      if (prior.completed) return prior.result;
      attempt = prior.attempts + 1;
      if (prior.attempts) after = prior.lost ? "lost" : "failed";
    }
    const begun = performance.now();
    const startedAt = new Date().toISOString();
    try {
      return await run({
        kind: "call",
        action,
        input,
        id,
        attempt,
        ...(after ? { after } : {}),
        ...(scheduled ? { scheduled } : {}),
        ...(actor ? { actor } : {}),
      }, signal);
    } catch (error) {
      const { code, recorded } = error as { code?: string; recorded?: boolean };
      // An executor lost, or a call stopped before it recorded its own end.
      if (code !== "executor_lost" && !(code === "cancelled" && !recorded)) throw error;
      // The executor died mid-call, so nothing on its side can record it.
      // Its start and retry marks are dropped if they already committed.
      const ms = Math.round((performance.now() - begun) * 100) / 100;
      const emit = (event: Extract<Op, { op: "emit" }>["event"]) => ({
        op: "emit" as const,
        event,
      });
      const inputHash = await fingerprint(action, input);
      await commit((tx) =>
        performAll(tx, [
          emit({
            id,
            type: "action.started",
            data: { action, input: input ?? null, inputHash, startedAt, attempt },
          }),
          ...(after
            ? [emit({
              id: `${id}:retry:${attempt}`,
              type: "action.retried",
              data: { action, attempt, after },
              cause: id,
            })]
            : []),
          emit({
            type: "action.failed",
            data: { action, error: failure(error), ms, attempt },
            cause: id,
          }),
        ], { cause: id, ...(actor ? { actor } : {}) }), false).catch(() => {});
      throw error;
    }
  };

  // Processors: per-key ordering, a durable cursor, at-least-once delivery.
  type Lane = { tail: Promise<void> };
  const lanes = new Map<string, Lane>();
  const inflight = new Map<string, Set<number>>();
  const seen = new Map<string, number>();
  const saved = new Map<string, number>();
  let pending = 0;
  let drained = Promise.withResolvers<void>();
  drained.resolve();
  /** Counts work toward `idle` until it settles. */
  const track = <T>(work: Promise<T>): Promise<T> => {
    if (pending++ === 0) drained = Promise.withResolvers<void>();
    return work.finally(() => {
      if (--pending === 0) drained.resolve();
    });
  };

  const wants = (processor: ProcessorDef, event: Event) =>
    [processor.on].flat().some((type) => type === "*" || type === event.type) &&
    (!processor.where || matches(event.data, processor.where));

  // The latest event routed: a Processor's lag is how far its cursor is behind it.
  let head = 0;
  const advance = (name: string) => {
    const open = inflight.get(name) ?? new Set<number>();
    const safe = open.size ? Math.min(...open) - 1 : seen.get(name)!;
    measure.lag.set(Math.max(0, head - safe), { processor: name });
    if (safe <= (saved.get(name) ?? 0)) return;
    saved.set(name, safe);
    unsaved.set(name, safe);
    flushing ??= setTimeout(() => {
      flushing = undefined;
      if (unsaved.size && !closing.signal.aborted) commit(async () => {}).catch(() => {});
    }, CURSOR_FLUSH_MS);
  };

  // What each Processor lane is running, so it can be stopped.
  const active = new Map<string, AbortController>();

  /** Stops a running call or Processor lane; false when nothing was running. */
  const cancel = (target: { call: string } | { processor: string; key: string }): boolean => {
    const stop = "call" in target
      ? calling.get(target.call)?.stop
      : active.get(`${target.processor}\u0000${target.key}`);
    stop?.abort();
    return !!stop;
  };

  const deliver = async (name: string, event: Event, recovered: boolean, lane: string) => {
    const stop = new AbortController();
    active.set(lane, stop);
    try {
      await attempts(name, event, recovered, stop.signal);
    } finally {
      if (active.get(lane) === stop) active.delete(lane);
    }
  };

  const attempts = async (name: string, event: Event, recovered: boolean, stop: AbortSignal) => {
    for (let attempt = 1;; attempt++) {
      try {
        const full = { ...event, data: await hydrate(event.data, blobsOf(store)) };
        await run({
          kind: "process",
          processor: name,
          event: full,
          retry: recovered || attempt > 1,
        }, stop);
        return;
      } catch (error) {
        if (closing.signal.aborted) return;
        // Every failed attempt is on record: the retry that follows, or the final failure.
        const after = (error as { code?: string }).code === "executor_lost" ? "lost" : "failed";
        // A stopped delivery is over, and so is one whose failure says trying again won't help.
        const last = attempt >= DELIVERY_ATTEMPTS || stop.aborted ||
          (error as { final?: boolean }).final === true;
        await commit((tx) =>
          Promise.resolve(tx.emit({
            id: `${event.id}:${name}:${last ? "failed" : `retry:${attempt + 1}`}`,
            type: last ? "processor.failed" : "processor.retried",
            // A final failure carries what failed, so a processor can answer for it.
            data: last
              ? {
                processor: name,
                event: event.id,
                type: event.type,
                data: event.data,
                error: failure(error),
                attempts: attempt,
              }
              : {
                processor: name,
                event: event.id,
                attempt: attempt + 1,
                after,
                error: failure(error),
              },
            cause: event.id,
          })), false).catch(() => {});
        if (last) return;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 200 * attempt);
          stop.addEventListener("abort", () => (clearTimeout(timer), resolve(undefined)), {
            once: true,
          });
        });
      }
    }
  };

  // Events routed while recovering may have been handled before the restart.
  let recovering = false;
  function route(event: Event) {
    const retry = recovering;
    head = Math.max(head, event.seq);
    for (const [name, processor] of Object.entries(registry.processors)) {
      if (event.seq <= (saved.get(name) ?? 0)) continue;
      if (!wants(processor, event)) {
        // Nothing to do for it: the cursor may move past it.
        seen.set(name, Math.max(seen.get(name) ?? 0, event.seq));
        if (!inflight.get(name)?.size) advance(name);
        continue;
      }
      const key = `${name}\u0000${processor.key?.(event) ?? event.id}`;
      const lane = lanes.get(key) ?? { tail: Promise.resolve() };
      lanes.set(key, lane);
      if (!inflight.has(name)) inflight.set(name, new Set());
      inflight.get(name)!.add(event.seq);
      seen.set(name, Math.max(seen.get(name) ?? 0, event.seq));
      const tail = track(lane.tail.then(async () => {
        await deliver(name, event, retry, key);
        inflight.get(name)!.delete(event.seq);
        advance(name);
      })).finally(() => {
        if (lane.tail === tail) lanes.delete(key);
      });
      lane.tail = tail;
    }
  }

  // Recover: resume every Processor from its durable cursor, then every timer.
  for (const [name, seq] of Object.entries(await store.positions())) saved.set(name, seq);
  const from = Math.min(
    ...Object.keys(registry.processors).map((name) => saved.get(name) ?? 0),
  );
  if (Number.isFinite(from)) {
    recovering = true;
    for (let after = from;;) {
      const batch = await store.events(after, 500);
      if (!batch.length) break;
      for (const event of batch) route(event);
      after = batch.at(-1)!.seq;
    }
    recovering = false;
  }
  await timers.recover();

  const api: Owner = {
    call(action, input, options = {}) {
      const def = registry.actions[action];
      if (!def) return Promise.reject(invalid(`Unknown action "${action}"`));
      const { actor } = options;
      // An actor calls only what lets them.
      if (actor && actor.kind !== "system" && !def.allow?.(actor, input)) {
        return Promise.reject(forbidden(`${actor.kind} ${actor.id} may not call "${action}".`));
      }
      const id = options.id ?? crypto.randomUUID();
      return begin(action, json(input), id, options.id !== undefined, undefined, actor) as never;
    },
    async render(medium, kind, item, options = {}) {
      return await run({
        kind: "render",
        renderer: medium,
        view: kind,
        item: json(item),
        ...(options.viewer ? { viewer: options.viewer } : {}),
        ...(options.hints ? { hints: json(options.hints) } : {}),
      }) as never;
    },
    observe: (medium, kind, item, options) => observers.observe(medium, kind, item, options),
    emit,
    describe: () => ({
      collections: Object.fromEntries(
        Object.entries(registry.collections).map(([name, def]) => [name, { schema: def.schema }]),
      ),
      actions: Object.fromEntries(
        Object.entries(registry.actions).map(([name, def]) => [name, {
          ...(def.description ? { description: def.description } : {}),
          ...(def.input ? { input: def.input } : {}),
        }]),
      ),
      views: Object.fromEntries(
        Object.entries(registry.views).map(([kind, media]) => [kind, Object.keys(media)]),
      ),
      resources: registry.resources,
    }),
    async query(name, params, options = {}) {
      const dot = name.lastIndexOf(".");
      const [collection, query] = [name.slice(0, dot), name.slice(dot + 1)];
      if (!registry.collections[collection]?.queries?.[query]) {
        throw invalid(`Unknown query "${name}"`);
      }
      const { actor } = options;
      // An actor runs only what lets them.
      if (actor && !askable(actor, collection, query, params)) {
        throw forbidden(`${actor.kind} ${actor.id} may not run "${name}".`);
      }
      return await run({
        kind: "query",
        collection,
        query,
        params: json(params),
        ...(options.actor ? { actor: options.actor } : {}),
      }) as never;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel: (target) => Promise.resolve(cancel(target)),
    // Nothing pending, and every observed View showing what that left.
    async idle() {
      do {
        await drained.promise;
        await observers.idle();
      } while (pending);
    },
    wake: () => timers.wake(),
    stats: () => ({
      roundTrips: store.roundTrips(),
      pending,
      jobs,
      calls,
      executors: ready.size,
      browsers: browsers.count(),
      hits: cache?.stats().hits ?? 0,
      misses: cache?.stats().misses ?? 0,
    }),
    hypervisor,
    async close() {
      // Workers still connected go with it: their kinds hear so while it still runs.
      for (const key of connected.keys()) {
        const [kind, id] = key.split("\u0000");
        tell(registry.workers[kind]?.gone, id);
      }
      connected.clear();
      await Promise.all(telling);
      closing.abort();
      timers.close();
      clearTimeout(flushing);
      await hypervisor.shutdown();
      if (unsaved.size) await commit(async () => {});
      await store.close();
    },
  };
  return api;
}

/** The scalar type a schema gives a dot path (through properties and additionalProperties), if one. */
/** A copy of `doc` without the private fields at these (dotted) paths. */
function unprivate(doc: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const copy = structuredClone(doc);
  for (const path of fields) {
    const keys = path.split(".");
    let at: Record<string, unknown> | undefined = copy;
    for (const key of keys.slice(0, -1)) at = at?.[key] as Record<string, unknown> | undefined;
    if (at && typeof at === "object") delete at[keys.at(-1)!];
  }
  return copy;
}

function scalarOf(schema: unknown, path: string): ScalarType | undefined {
  let node = schema as Record<string, unknown> | undefined;
  for (const key of path.split(".")) {
    const properties = node?.properties as Record<string, unknown> | undefined;
    const more = node?.additionalProperties;
    node = (properties?.[key] ?? (more && typeof more === "object" ? more : undefined)) as
      | Record<string, unknown>
      | undefined;
  }
  const types = [node?.type].flat().filter((type) => type && type !== "null");
  if (types.length !== 1) return undefined;
  const [type] = types;
  return type === "string"
    ? "string"
    : type === "number" || type === "integer"
    ? "number"
    : type === "boolean"
    ? "boolean"
    : undefined;
}
