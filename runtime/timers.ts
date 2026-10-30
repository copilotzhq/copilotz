/**
 * The owner's timers: one clock, armed for the earliest timer in
 * `sys.timers`. When it rings, the owner claims what's due in one commit
 * (each recurring timer moves to its next time; a one-off loses its time)
 * and calls each occurrence's Action with the occurrence's id, so the log
 * keeps it once however often it's called. A failed occurrence's next attempt
 * is a timer too, calling again as the same occurrence; one that a stop cut
 * short runs again (as itself) when the owner starts.
 */
import type { ActionDef } from "./define.ts";
import type { Metrics } from "./metrics.ts";
import { type Op, outcome, type StoreOp, type WriteOp } from "./ops.ts";
import { compile, invalid } from "./registry.ts";
import {
  backoff,
  type Clock,
  following,
  occurrence,
  recurs,
  sameSchedule,
  type Scheduled,
  type ScheduleDef,
  scheduledOf,
  type Timer,
  timer,
  TIMERS,
} from "./schedules.ts";
import type { Actor, Change, Doc, Reader } from "./store.ts";

/** Due timers claimed per commit. */
const BATCH = 100;
/** After a failed look at the timers, the next. */
const RECHECK_MS = 5_000;

export type Timers = {
  /** A timer op as the write it is, with the owner's clock (other ops pass through). */
  /** A timer op as the write it is; a timer set by an actor runs as them. */
  lower(op: Op, actor?: Actor): StoreOp;
  /** Timer documents a commit changed: the clock follows them. */
  changed(changes: Change[]): void;
  /** Keeps declared timers as declared, resumes cut-short occurrences, and arms the clock. */
  recover(): Promise<void>;
  /** Fires what's due now, and arms the clock for what's next. */
  wake(): Promise<void>;
  close(): void;
};

export function createTimers(options: {
  /** Committed state, to read timers and the log. */
  store: Reader;
  clock: Clock;
  schedules: Record<string, ScheduleDef>;
  actions: Record<string, ActionDef>;
  /** Commits writes together; each one's result. */
  write(ops: WriteOp[]): Promise<unknown[]>;
  /** Calls an Action as a known call id (a repeated id answers from the log). */
  call(
    action: string,
    input: unknown,
    id: string,
    scheduled: Scheduled,
    actor?: Actor,
  ): Promise<unknown>;
  /** Counts work toward the owner's `idle`. */
  track<T>(work: Promise<T>): Promise<T>;
  signal: AbortSignal;
  metrics: Metrics;
}): Timers {
  const { store, clock, schedules, actions, signal } = options;
  const lateness = options.metrics.histogram("copilotz.timer.lateness", {
    unit: "ms",
    description: "How long after its time a timer's occurrence was called",
  });
  // A declared schedule that can't run stops the runtime from starting.
  for (const [name, def] of Object.entries(schedules)) {
    const action = actions[def.call];
    try {
      if (!action) throw invalid(`calls unknown action "${def.call}"`);
      if ((def as { at?: unknown }).at !== undefined) {
        throw invalid("recurs: it takes `cron` or `every`, not `at`");
      }
      timer(name, def.call, def.input, def, clock.now());
      if (action.input) compile(action.input, `input`)(def.input);
    } catch (error) {
      throw invalid(`Schedule "${name}": ${(error as Error).message}`);
    }
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  const replace = (t: Timer): WriteOp => {
    const { _id, ...doc } = t;
    return { op: "replace", collection: TIMERS, filter: { _id }, doc, options: { upsert: true } };
  };
  // A one-off goes once its occurrence is settled, unless it was set again meanwhile.
  const drop = (t: Timer): WriteOp => ({
    op: "delete",
    collection: TIMERS,
    filter: { _id: t._id, at: { $exists: false } },
    options: {},
  });

  // Occurrences called here and not yet settled, by timer: each claim keeps them on record.
  const inflight = new Map<string, Set<string>>();
  const running = (t: Timer) => [...inflight.get(t._id) ?? []];

  /**
   * Settles an occurrence: a one-off goes, and a failure with attempts left
   * comes back as a retry timer, after a wait that grows with each attempt.
   */
  const settle = async (t: Timer, id: string, retry: boolean) => {
    const ops: WriteOp[] = [];
    let again = false;
    if (retry) {
      const { attempts, completed } = await outcome(store, id);
      if (!completed && attempts <= t.retries) {
        again = true;
        ops.push(replace({
          _id: id,
          call: t.call,
          ...(t.input === undefined ? {} : { input: t.input }),
          retries: t.retries,
          retry: true,
          at: iso(clock.now() + backoff(attempts)),
        }));
      }
    }
    // A retry timer that retries again is replaced above; otherwise a one-off goes.
    if (!recurs(t) && !(again && t._id === id)) ops.push(drop(t));
    if (ops.length) await options.write(ops);
  };

  const run = async (t: Timer, id: string) => {
    let failed: unknown;
    try {
      await options.call(t.call, t.input, id, scheduledOf(id), t.actor);
    } catch (error) {
      failed = error;
    } finally {
      const set = inflight.get(t._id);
      set?.delete(id);
      if (!set?.size) inflight.delete(t._id);
    }
    if (signal.aborted) return;
    // A call that can never succeed (bad input, an id taken by another call) isn't retried.
    const code = (failed as { code?: string } | undefined)?.code;
    const retry = failed !== undefined && code !== "invalid" && code !== "id_conflict";
    // The log holds every other failure; this one never started.
    if (code === "id_conflict") report(`calling ${id}`, failed);
    await settle(t, id, retry).catch((error) => report("settling", error));
  };

  const start = (t: Timer, id: string) => {
    if (!inflight.has(t._id)) inflight.set(t._id, new Set());
    inflight.get(t._id)!.add(id);
    void options.track(run(t, id));
  };

  const report = (what: string, error: unknown) => {
    if (!signal.aborted) {
      console.error(`timers: ${what} failed: ${error instanceof Error ? error.message : error}`);
    }
  };

  // The clock, armed for the earliest timer.
  let armed: { id: string; at: string; cancel(): void } | undefined;
  const arm = (next: { _id: string; at: string } | undefined) => {
    armed?.cancel();
    armed = undefined;
    if (!next || signal.aborted) return;
    const entry = { id: next._id, at: next.at, cancel: () => {} };
    armed = entry;
    // A clock may ring at once, for a time already past.
    entry.cancel = clock.wake(Date.parse(next.at), () => {
      if (armed === entry) armed = undefined;
      void wake();
    });
  };

  /**
   * One pass: claims what's due (up to a batch) and calls it, or else arms
   * for what's next. True when it claimed, so the look takes another pass.
   */
  const fire = async (): Promise<boolean> => {
    // A look ends only after a pass that saw every change committed since it began.
    seen = version;
    const now = clock.now();
    const due = await store.find(TIMERS, { at: { $lte: iso(now) } }, {
      sort: { at: 1 },
      limit: BATCH,
    }) as Timer[];
    if (due.length) {
      const claims = due.map((t): WriteOp => {
        const next = following(t, Date.parse(t.at!), now);
        const keep = [...running(t), occurrence(t)];
        return {
          op: "update",
          collection: TIMERS,
          // Unless it was set again since it was read.
          filter: { _id: t._id, at: t.at },
          update: next
            ? { $set: { at: next, running: keep } }
            : { $set: { running: keep }, $unset: { at: true } },
          options: {},
        };
      });
      const results = await options.write(claims) as ({ matched?: number } | undefined)[];
      due.forEach((t, i) => {
        if (!results[i]?.matched) return;
        lateness.record(Math.max(0, now - Date.parse(t.at!)), { action: t.call });
        start(t, occurrence(t));
      });
      // Another pass finds what's next, and any timer set again while it was claimed.
      return true;
    }
    const [next] = await store.find(TIMERS, { at: { $gt: iso(now) } }, {
      sort: { at: 1 },
      limit: 1,
    }) as Timer[];
    arm(next as { _id: string; at: string } | undefined);
    return false;
  };

  // One look at a time. Timer changes committed during a look, and wakes asked
  // for meanwhile, make it look again; it ends only once it read the latest.
  let looking: Promise<void> | undefined;
  /** Timer changes committed so far, and when the last pass began. */
  let version = 0;
  let seen = 0;
  let dirty = false;
  const wake = (): Promise<void> => {
    if (signal.aborted) return Promise.resolve();
    if (looking) {
      dirty = true;
      return looking;
    }
    looking = options.track((async () => {
      try {
        for (;;) {
          dirty = false;
          const more = await fire();
          // No await between this check and the `finally`: a change after it finds no look.
          if (signal.aborted || (!more && !dirty && version === seen)) return;
        }
      } catch (error) {
        report("firing timers", error);
        arm({ _id: "", at: iso(clock.now() + RECHECK_MS) });
      } finally {
        looking = undefined;
      }
    })());
    return looking;
  };

  return {
    lower(op, actor) {
      if (op.op === "cancel") throw invalid("A cancel goes on its own.");
      if (op.op !== "schedule" && op.op !== "unschedule") return op;
      if (op.timer in schedules) {
        throw invalid(`Timer "${op.timer}" is declared by a plugin: change it in configuration`);
      }
      if (op.op === "unschedule") {
        return { op: "delete", collection: TIMERS, filter: { _id: op.timer }, options: {} };
      }
      if (!actions[op.call]) throw invalid(`Unknown action "${op.call}"`);
      const set = timer(op.timer, op.call, op.input, op.when, clock.now());
      return replace(actor ? { ...set, actor } : set);
    },

    changed(changes) {
      version++;
      if (looking) return;
      for (const { _id, after } of changes) {
        const at = typeof after?.at === "string" ? after.at : undefined;
        // The armed timer moved or went: look again. An earlier one: arm for it.
        if (armed && armed.id === _id) return void wake();
        if (at && (!armed || at < armed.at)) arm({ _id, at });
      }
    },

    async recover() {
      // Occurrences a stop cut short run again, as themselves and as their timers were,
      // unless a retry waits for them.
      const cut = await store.find(TIMERS, { "running.0": { $exists: true } }) as Timer[];
      const ids = cut.flatMap((t) => t.running ?? []);
      const waiting = new Set(
        ids.length
          ? (await store.find(TIMERS, { _id: { $in: ids } }) as Doc[]).map((doc) => doc._id)
          : [],
      );
      for (const t of cut) {
        for (const id of t.running ?? []) {
          if (id !== t._id && waiting.has(id)) continue;
          const { attempts, completed } = await outcome(store, id);
          if (!completed && attempts <= t.retries) start(t, id);
          else await settle(t, id, false);
        }
      }

      // Declared timers, as the plugins declare them now; ones no longer declared go.
      const now = clock.now();
      const names = Object.keys(schedules);
      const found = await store.find(TIMERS, {
        $or: [{ declared: true }, { _id: { $in: names } }],
      }) as Timer[];
      const byId = new Map(found.map((t) => [t._id, t]));
      const ops: WriteOp[] = [];
      for (const [name, def] of Object.entries(schedules)) {
        const wanted: Timer = { ...timer(name, def.call, def.input, def, now), declared: true };
        const have = byId.get(name);
        if (have?.declared && sameSchedule(have, wanted)) continue;
        const keep = running(wanted);
        ops.push(replace({ ...wanted, ...(keep.length ? { running: keep } : {}) }));
      }
      for (const t of found) {
        if (t.declared && !(t._id in schedules)) {
          ops.push({ op: "delete", collection: TIMERS, filter: { _id: t._id }, options: {} });
        }
      }
      if (ops.length) await options.write(ops);
      void wake();
    },

    wake,

    close() {
      armed?.cancel();
      armed = undefined;
    },
  };
}
