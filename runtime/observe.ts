/**
 * Observing a View: its output, and again whenever what it read changes.
 *
 * Each View it shows (`ctx.show`) is a part of its own: a part runs again on
 * its own when a commit changes a document it read, so a reply being written
 * re-runs its line, not the screen. A medium says how a part goes into its
 * parent's output (`part`): for a UI framework, a component that redraws
 * when the part's output changes. Without one, shown Views render inline and
 * the whole re-runs.
 *
 * A part shown again with the same item and hints keeps its output. Parts
 * are known by their kind and their item's `_id` (or their place among that
 * kind's parts), so a list keeps its parts across runs.
 *
 * What one commit changes shows at once: the parts it makes run again tell
 * their new output together, once the last of them has it (a reply written
 * and the live text it replaces never show both, or neither). One that takes
 * too long (`WAVE_MS`) doesn't hold the others back.
 */
import { matches } from "./mongo.ts";
import { invalid } from "./registry.ts";
import type { ReadContext, ViewContext, Viewer, Views } from "./define.ts";
import type { Op } from "./ops.ts";
import type { Actor, Change, Filter } from "./store.ts";
import { failure, type Pass, PASSES, reread, viewCollections, viewOf } from "./views.ts";

/** A View's output, while it loads, once it's ready, or why it failed. */
export type Output<R = unknown> =
  | { status: "loading" }
  | { status: "ready"; value: R }
  | { status: "failed"; error: unknown };

/** A part's output now, and word when it changes. */
export type Observed<R = unknown> = {
  get(): Output<R>;
  subscribe(listener: () => void): () => void;
};

export type Observation<R = unknown> = Observed<R> & {
  /** The first output, or why it failed. */
  ready: Promise<Output<R>>;
  /** Stops observing: its parts close with it. */
  close(): void;
};

export type ObserveOptions = {
  viewer?: Viewer;
  /** Whose reads: the View shows what they reach, and its handlers act as them. */
  actor?: Actor;
  hints?: Record<string, unknown>;
  /** What `ctx.show` returns in this medium: the shown View as a part, with its key. */
  part?: (part: Observed, key: string) => unknown;
};

export type Observers = {
  observe<R = unknown>(
    medium: string,
    kind: string,
    item: unknown,
    options?: ObserveOptions,
  ): Observation<R>;
  /** What a commit changed, by collection: the parts that read it run again. */
  changed(seen: [string, Change[]][]): void;
  /** Resolves when no part is running: every observed View shows the latest data. */
  idle(): Promise<void>;
};

/** What a run read: a collection, and the filter its documents matched (all, without one). */
export type Dep = { collection: string; filter?: Filter };

/** The longest the parts of one commit wait for each other before telling what they have. */
const WAVE_MS = 2_000;

/**
 * The parts one commit made run again: those still running (each with its
 * generation then: only a run started after counts), and those done,
 * telling nothing yet.
 */
type Wave = {
  waiting: Map<Part, number>;
  done: Set<Part>;
  timer?: ReturnType<typeof setTimeout>;
};

type Part = {
  medium: string;
  kind: string;
  item: unknown;
  hints: Record<string, unknown>;
  viewer?: Viewer;
  actor?: Actor;
  place?: ObserveOptions["part"];
  snapshot: Output;
  observed: Observed;
  listeners: Set<() => void>;
  deps: Dep[];
  /** What its last run read, asked again first when it runs again. */
  slots?: Pass["slots"];
  /** The parts it showed in its last run, by key. */
  children: Map<string, Part>;
  /** Runs started on it (its own, or its parent's): only the latest settles. */
  generation: number;
  running: boolean;
  again: boolean;
  closed: boolean;
  /** The commits it runs again for, whose other parts it tells its output with. */
  waves?: Set<Wave>;
};

/** One run of a part: its reads, the parts it shows, and what each of them is running. */
type Run = Pass & {
  source: ReadContext;
  deps: Dep[];
  /** Shown in the latest pass, by key; how many of each kind so far. */
  used: Map<string, Part>;
  counts: Map<string, number>;
  /** Parts this run is running too (new, or shown with something new), by key. */
  nested: Map<string, Nested>;
};
type Nested = {
  part: Part;
  run: Run;
  item: unknown;
  hints: Record<string, unknown>;
  output?: unknown;
  error?: unknown;
};

/** The reads a run made, as dependencies. */
const depOf = (op: Op): Dep | undefined => {
  switch (op.op) {
    case "find":
    case "findOne":
    case "count":
      return { collection: op.collection, filter: op.filter };
    case "aggregate":
    case "nearest":
      return { collection: op.collection };
    default:
      return undefined;
  }
};

/** Whether a change could change what `dep` read: the document matched its filter, before or after. */
const touches = (dep: Dep, changes: Change[]) =>
  !dep.filter || !Object.keys(dep.filter).length ||
  changes.some(({ before, after }) =>
    (before && matches(before, dep.filter)) || (after && matches(after, dep.filter))
  );

/** Plain data compared by value; functions, elements and the like by reference. */
const same = (a: unknown, b: unknown, depth = 0): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b || depth > 32) return false;
  if ("$$typeof" in a || "$$typeof" in b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((x, i) => same(x, b[i], depth + 1));
  }
  const [ka, kb] = [Object.keys(a), Object.keys(b)];
  return ka.length === kb.length &&
    ka.every((k) => same((a as never)[k], (b as never)[k], depth + 1));
};

const idOf = (item: unknown) =>
  typeof item === "object" && item && typeof (item as { _id?: unknown })._id === "string"
    ? (item as { _id: string })._id
    : undefined;

export function createObservers(env: {
  views: Views;
  /**
   * Read-only access for one run, as `actor`; each read is told to `track`
   * before it's made: an op, or what it depends on (a client tracks a read it
   * watches elsewhere by its key, as a collection of its own).
   */
  reads(track: (read: Op | Dep) => void, actor?: Actor): ReadContext;
  call(action: string, input: unknown, actor?: Actor): Promise<never>;
  emit(type: string, data: Record<string, unknown> | undefined, actor?: Actor): Promise<void>;
  /** No part reads `collection` any more (a client stops watching a read). */
  unread?(collection: string): void;
}): Observers {
  /** Parts by the collections they read. */
  const readers = new Map<string, Set<Part>>();
  // Runs in flight, for `idle`.
  let running = 0;
  let settled = Promise.withResolvers<void>();
  settled.resolve();
  const start = (p: Part) => {
    if (running++ === 0) settled = Promise.withResolvers<void>();
    void refresh(p).finally(() => {
      if (--running === 0) settled.resolve();
    });
  };

  const part = (
    medium: string,
    kind: string,
    item: unknown,
    hints: Record<string, unknown>,
    viewer?: Viewer,
    place?: ObserveOptions["part"],
    actor?: Actor,
  ): Part => {
    const p: Part = {
      medium,
      kind,
      item,
      hints,
      ...(viewer ? { viewer } : {}),
      ...(actor ? { actor } : {}),
      ...(place ? { place } : {}),
      snapshot: { status: "loading" },
      observed: undefined as never,
      listeners: new Set(),
      deps: [],
      children: new Map(),
      generation: 0,
      running: false,
      again: false,
      closed: false,
    };
    p.observed = {
      get: () => p.snapshot,
      subscribe: (listener) => {
        p.listeners.add(listener);
        return () => p.listeners.delete(listener);
      },
    };
    return p;
  };

  const fresh = (actor?: Actor): Run => {
    const deps: Dep[] = [];
    return {
      slots: new Map(),
      pending: [],
      deps,
      source: env.reads((read) => {
        const dep = "op" in read ? depOf(read) : read;
        if (dep) deps.push(dep);
      }, actor),
      used: new Map(),
      counts: new Map(),
      nested: new Map(),
    };
  };

  const context = (
    p: Part,
    run: Run,
    db: ViewContext["db"],
    kind: string,
    hints: Record<string, unknown>,
  ): ViewContext => ({
    db,
    resources: run.source.resources,
    renderer: p.medium,
    kind,
    ...(p.viewer ? { viewer: p.viewer } : {}),
    ...(p.actor ? { actor: p.actor } : {}),
    hints,
    show: (kind, item, hints = {}) => show(p, run, db, kind, item, hints),
    call: (action, input) => env.call(action, input, p.actor),
    emit: (type, data) => env.emit(type, data, p.actor),
  });

  /** One pass of a part's View over its run's reads. */
  const pass = (p: Part, run: Run, item: unknown, hints: Record<string, unknown>) => {
    run.pending = [];
    run.used = new Map();
    run.counts = new Map();
    const view = viewOf(env.views, p.kind, p.medium);
    if (!view) return undefined;
    return view(item, context(p, run, viewCollections(run.source, run), p.kind, hints));
  };

  /** `ctx.show` in a part: inline, or the shown View as a part of the parent's, kept across runs. */
  const show = (
    parent: Part,
    run: Run,
    db: ViewContext["db"],
    kind: string,
    item: unknown,
    hints: Record<string, unknown>,
  ): unknown => {
    if (!parent.place) {
      return viewOf(env.views, kind, parent.medium)?.(item, context(parent, run, db, kind, hints));
    }
    const n = run.counts.get(kind) ?? 0;
    run.counts.set(kind, n + 1);
    let key = `${kind}:${idOf(item) ?? n}`;
    if (run.used.has(key)) key += `#${n}`;
    let nested = run.nested.get(key);
    const child = nested?.part ?? parent.children.get(key) ??
      part(parent.medium, kind, item, hints, parent.viewer, parent.place, parent.actor);
    const changed = nested || child.snapshot.status === "loading" || !same(child.item, item) ||
      !same(child.hints, hints);
    if (changed && !nested && child.slots?.size) {
      // Shown with something new: it runs once what it read last time is in again.
      nested = { part: child, run: fresh(child.actor), item, hints };
      reread(child.slots, nested.run, nested.run.source);
      run.nested.set(key, nested);
      run.pending.push(...nested.run.pending);
    } else if (changed) {
      nested ??= { part: child, run: fresh(child.actor), item, hints };
      nested.item = item;
      nested.hints = hints;
      run.nested.set(key, nested);
      try {
        nested.output = pass(child, nested.run, item, hints);
        nested.error = undefined;
      } catch (error) {
        nested.error = error;
      }
      // The parent waits for what its new parts read, so it settles with them.
      run.pending.push(...nested.run.pending);
    }
    run.used.set(key, child);
    return parent.place(child.observed, key);
  };

  const notify = (p: Part) => {
    for (const listener of p.listeners) listener();
  };

  /** A wave whose parts all have their output (or that waited long enough): they tell it, together. */
  const finish = (wave: Wave) => {
    clearTimeout(wave.timer);
    for (const p of [...wave.waiting.keys(), ...wave.done]) p.waves?.delete(wave);
    const told = [...wave.done];
    wave.waiting.clear();
    wave.done.clear();
    for (const p of told) if (!p.closed) notify(p);
  };

  /**
   * A part has its new output: it tells it with the rest of its commit's
   * parts, or now (no commit waits on it, or this run started before it).
   */
  const release = (p: Part) => {
    let held = false;
    for (const wave of [...p.waves ?? []]) {
      const since = wave.waiting.get(p);
      if (since === undefined || p.generation <= since) continue;
      wave.waiting.delete(p);
      wave.done.add(p);
      held = true;
      if (!wave.waiting.size) finish(wave);
      else wave.timer ??= setTimeout(() => finish(wave), WAVE_MS);
    }
    if (!held) notify(p);
  };

  /** A part that won't run again: its commits don't wait for it. */
  const leave = (p: Part) => {
    for (const wave of [...p.waves ?? []]) {
      wave.waiting.delete(p);
      wave.done.delete(p);
      if (!wave.waiting.size) finish(wave);
    }
  };

  const depend = (p: Part, deps: Dep[]) => {
    const before = p.deps;
    for (const { collection } of before) readers.get(collection)?.delete(p);
    p.deps = deps;
    for (const { collection } of deps) {
      if (!readers.has(collection)) readers.set(collection, new Set());
      readers.get(collection)!.add(p);
    }
    // What nothing reads now.
    for (const { collection } of before) {
      if (readers.get(collection)?.size === 0) {
        readers.delete(collection);
        env.unread?.(collection);
      }
    }
  };

  const close = (p: Part) => {
    if (p.closed) return;
    p.closed = true;
    leave(p);
    depend(p, []);
    p.listeners.clear();
    for (const child of p.children.values()) close(child);
  };

  /** A run's outcome: its parts settle first, the ones it no longer shows close. */
  const settle = (p: Part, run: Run, snapshot: Output) => {
    for (const nested of run.nested.values()) {
      const child = nested.part;
      if (child.closed) continue;
      child.generation++;
      child.item = nested.item;
      child.hints = nested.hints;
      const failed = failure(nested.run);
      const error = failed?.error ?? nested.error;
      settle(
        child,
        nested.run,
        error !== undefined
          ? { status: "failed", error }
          : { status: "ready", value: nested.output },
      );
    }
    for (const [key, child] of p.children) if (run.used.get(key) !== child) close(child);
    p.children = run.used;
    depend(p, run.deps);
    p.slots = run.slots;
    p.snapshot = snapshot;
    release(p);
  };

  /** Runs a part until its reads settle; asked again meanwhile, it runs again after. */
  const refresh = async (p: Part): Promise<void> => {
    if (p.running) {
      p.again = true;
      return;
    }
    p.running = true;
    try {
      do {
        p.again = false;
        const generation = ++p.generation;
        const run = fresh(p.actor);
        if (p.slots) {
          reread(p.slots, run, run.source);
          await Promise.all(run.pending);
          if (p.closed) return;
        }
        let output: unknown;
        let error: unknown;
        for (let round = 1;; round++) {
          try {
            output = pass(p, run, p.item, p.hints);
            error = undefined;
          } catch (thrown) {
            // A View may stumble on data still loading: it runs again once it's there.
            error = thrown;
          }
          if (!run.pending.length) break;
          if (round === PASSES) {
            error = invalid(`The ${p.medium} View for "${p.kind}" kept making new reads.`);
            break;
          }
          await Promise.all(run.pending);
          if (p.closed) return;
        }
        if (generation !== p.generation || p.closed) continue;
        error = failure(run)?.error ?? error;
        settle(
          p,
          run,
          error !== undefined ? { status: "failed", error } : { status: "ready", value: output },
        );
      } while (p.again && !p.closed);
    } finally {
      p.running = false;
    }
  };

  return {
    observe(medium, kind, item, options = {}) {
      const root = part(
        medium,
        kind,
        item,
        options.hints ?? {},
        options.viewer,
        options.part,
        options.actor,
      );
      const ready = new Promise<Output>((resolve) => {
        const off = root.observed.subscribe(() => {
          if (root.snapshot.status === "loading") return;
          off();
          resolve(root.snapshot);
        });
      });
      start(root);
      return {
        ...(root.observed as Observed<never>),
        ready: ready as never,
        close: () => close(root),
      };
    },
    changed(seen) {
      const due = new Set<Part>();
      for (const [collection, changes] of seen) {
        for (const p of readers.get(collection) ?? []) {
          if (p.deps.some((dep) => dep.collection === collection && touches(dep, changes))) {
            due.add(p);
          }
        }
      }
      // They tell their new output together, once the last has it.
      if (due.size > 1) {
        const wave: Wave = { waiting: new Map(), done: new Set() };
        for (const p of due) {
          wave.waiting.set(p, p.generation);
          (p.waves ??= new Set()).add(wave);
        }
      }
      for (const p of due) start(p);
    },
    idle: () => settled.promise,
  };
}
