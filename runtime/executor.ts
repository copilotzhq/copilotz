/**
 * An executor runs plugin code: Actions, Processor deliveries and queries. It
 * holds no store. Every storage call is an op sent to the owner, and live
 * frames ride the job's output back to it.
 */
import { createWorker, type WorkerOptions } from "@oxian/oxian-js";
import { collection, type Query, type Run } from "./collection.ts";
import type { ActionDef, Context, Plugins, ReadContext, TransactionScope } from "./define.ts";
import {
  type Attempt,
  isRead,
  nextAttempt,
  type Op,
  type Outcome,
  RESULTS,
  type TimerOp,
} from "./ops.ts";
import type { Scheduled, ScheduleOptions } from "./schedules.ts";
import {
  canonical,
  compile,
  described,
  events,
  fingerprint,
  invalid,
  json,
  merge,
  runAction,
  unknown,
  unprivate,
} from "./registry.ts";
import { presenter } from "./views.ts";
import { refuseBlobKeys } from "./blobs.ts";
import {
  querying as queryingOver,
  reading as readingOver,
  type Recorder,
  type RunAs,
} from "./reads.ts";
import { type Metrics, noMetrics } from "./metrics.ts";
import type { Actor, Edge, Event } from "./store.ts";
import { actionInput } from "./action-input.ts";
import { acting, allows, whereOf } from "./actor.ts";
import { forbidden } from "./errors.ts";
import {
  decode,
  DISPATCH,
  encode,
  type Failure,
  failure,
  type Job,
  OP,
  OP_MS,
  type OpReply,
  type OpRequest,
  output,
  raise,
  RUN,
  WORK_MS,
} from "./wire.ts";

export type Executor = { ready: Promise<void>; stop(): Promise<void> };

type HostCaller = Parameters<WorkerOptions["workloads"][string]>[0]["callHost"];

/** Ops whose result the caller already knows, so a transaction can send them later. */
const UNANSWERED = new Set<Op["op"]>(["emit", "insert", "link", "unlink"]);

/** What one job's code can reach: the owner, its output and its cancellation. */
type Reach = {
  send(request: OpRequest): Promise<unknown>;
  /** Sends work on to a worker of a plugin's kind, through the owner (see `Workers`). */
  dispatch(
    to: { kind: string; id: string; workload: string },
    input: unknown,
    signal: AbortSignal,
  ): ReturnType<HostCaller>;
  /** Appends to a records collection with the job's next write (see `Context.record`). */
  record: Recorder;
  frame(channel: string, data: unknown): void;
  signal: AbortSignal;
  /** This job may repeat earlier work: a retried call or delivery. */
  retry: boolean;
  /** The numbering used by the recorded Action whose code is running. */
  callNumbering: Attempt["callNumbering"];
  /** Numbers the nested calls made under each cause, in call order. */
  next(cause: string): number;
};

/** For whom ops in a held transaction go: what their writes answer to, as whom, in whose code. */
type Who = { cause?: string; actor?: Actor; action?: string; outside?: true };

/** An op waiting to go in a held transaction, and for whom. */
type Sent = { op: Op; who: Who };

/** The owner's id and retry information when it dispatches a call. */
type CallJob = Extract<Job, { kind: "call" }>;

/** An atomic Action asked for in a transaction, checked: its declaration and its input. */
type Asked = { name: string; def: ActionDef; input: unknown };

/** An unrecorded call keeps its caller as the cause. Its own position, when it has one,
 * numbers its children apart so they can't move a later call in the caller. */
const unrecordedScope = (
  parent: string | undefined,
  numbering: string | undefined,
  position: number,
) => position ? `${numbering}.${position}` : parent;

/** A transaction a job holds open on the owner (see `holding`). */
type Held = {
  /** Sends an op (or, unanswered, queues it), for `who`. */
  run(op: Op, who: Who, options?: { unanswered?: boolean }): Promise<unknown>;
  /** Queues an op for the next request or the commit; throws once it's closed. */
  queue(op: Op, who: Who): void;
  /** Throws once it's closed: committed, rolled back, or ended under it. */
  ensure(): void;
  /** Runs work in it (an atomic Action, a transaction joining it): failing, it ends it. */
  join<R>(work: () => Promise<R>): Promise<R>;
  commit(): Promise<void>;
  abort(): Promise<void>;
};

/** Whether ops for `a` and `b` may go in one request. */
const alike = (a: Who, b: Who) =>
  a === b ||
  (a.cause === b.cause && a.action === b.action && a.outside === b.outside &&
    canonical(a.actor ?? null) === canonical(b.actor ?? null));

/** Ops in order, in runs of the same `Who`: a request each. */
const byWho = (ops: Sent[]): { who: Who; ops: Op[] }[] => {
  const runs: { who: Who; ops: Op[] }[] = [];
  for (const { op, who } of ops) {
    const last = runs.at(-1);
    if (last && alike(last.who, who)) last.ops.push(op);
    else runs.push({ who, ops: [op] });
  }
  return runs;
};

const reply = async (callHost: HostCaller, request: OpRequest) => {
  const call = await callHost({
    workload: OP,
    body: encode(request),
    deadlineAtMs: Date.now() + OP_MS,
  });
  const answer = await decode<OpReply>(call.output);
  await call.completed;
  if ("error" in answer) throw raise(answer.error);
  return answer.value;
};

export function createExecutor(
  options: {
    plugins: Plugins;
    transport: WorkerOptions["transport"];
    id?: string;
    capacity?: number;
    /** The owner's executor key, for remote transports. */
    key?: string;
    /** Where plugin code (`ctx.metrics`) and this executor record metrics. */
    metrics?: Metrics;
    /** What plugin code (`ctx.fetch`) calls outside services with (default: the platform's). */
    fetch?: typeof fetch;
  },
): Executor {
  const registry = merge(options.plugins);
  const metrics = options.metrics ?? noMetrics;
  const outside = options.fetch ?? globalThis.fetch.bind(globalThis);
  const roundTrips = metrics.histogram("copilotz.op.roundtrip", {
    unit: "ms",
    description: "Requests to the owner, as executors waited for them",
  });
  // Records are checked where they're made: a bad one never rides along with another write.
  const records = Object.fromEntries(
    Object.entries(registry.collections).filter(([, def]) => def.records).map(([name, def]) => [
      name,
      compile(def.schema, `record in "${name}"`),
    ]),
  );
  // What plugins emit is checked where it's emitted: declared, and as declared.
  const declared = events(registry);
  const inputs = Object.fromEntries(
    Object.entries(registry.actions).filter(([, def]) => def.input).map(([name, def]) => [
      name,
      compile(def.input, `action "${name}" input`),
    ]),
  );

  // Multi-op atomic work. Ops go to the owner in order, one call at a time.
  // Those with nothing to answer (emits, inserts, links, unlinks, and writes
  // with `w: 0`) wait for the next op or the commit, so they cost no call of
  // their own; a failing one fails that op or the commit. Work whose ops all
  // wait commits in one call, without holding a transaction open on the owner.
  const transaction = async <R>(
    job: Reach,
    work: (tx: TransactionScope) => Promise<R>,
    cause?: string,
    numbering = cause,
    actor?: Actor,
    action?: string,
  ): Promise<R> => {
    const opener: Who = {
      ...(cause ? { cause } : {}),
      ...(actor ? { actor } : {}),
      ...(action ? { action } : {}),
    };
    const held = holding(job, opener);
    try {
      const result = await work(scoped(job, held, opener, numbering));
      await held.commit();
      return result;
    } catch (error) {
      await held.abort();
      throw error;
    }
  };

  /**
   * A transaction this job holds. Each op goes for whoever made it (its
   * `Who`): the code that opened it, or an atomic Action it called. A run of
   * ops by the same one is one request, so each write answers to its own
   * Action's call, and what each sends is checked as its actor.
   */
  const holding = (job: Reach, opener: Who): Held => {
    const id = crypto.randomUUID();
    const queued: Sent[] = [];
    let begun = false;
    let active = true;
    let chain: Promise<unknown> = Promise.resolve();
    const closed = () => invalid("The transaction is closed.");
    /** Sends ops, a request for each run of them by one `Who`; `end` goes with the last. */
    const send = async (ops: Sent[], end?: "commit") => {
      const runs = byWho(ops);
      if (!runs.length) runs.push({ who: opener, ops: [] });
      let value: unknown;
      for (const [i, { who, ops }] of runs.entries()) {
        const last = i === runs.length - 1;
        value = await job.send({ tx: id, ops, ...who, ...(end && last ? { end } : {}) });
      }
      return value;
    };
    const ensure = () => {
      if (!active) throw closed();
    };
    const abort = async () => {
      if (!active) return;
      active = false;
      queued.length = 0;
      await chain;
      if (begun) await job.send({ tx: id, ops: [], end: "abort", ...opener }).catch(() => {});
    };
    return {
      run(op, who, options) {
        if (!active) return Promise.reject(closed());
        if (UNANSWERED.has(op.op) || options?.unanswered) {
          queued.push({ op, who });
          return Promise.resolve(undefined);
        }
        begun = true;
        const ops = [...queued.splice(0), { op, who }];
        const result = chain.then(() => send(ops));
        chain = result.catch(() => {});
        return result;
      },
      queue(op, who) {
        ensure();
        queued.push({ op, who });
      },
      ensure,
      async join(work) {
        ensure();
        try {
          return await work();
        } catch (error) {
          // What it queued, or sent, can't be told from the rest: it all rolls back.
          await abort();
          throw error;
        }
      },
      async commit() {
        await chain;
        // Ended under it (an atomic Action failed): nothing commits.
        ensure();
        active = false;
        const rest = queued.splice(0);
        const runs = byWho(rest);
        if (begun || runs.length > 1) {
          begun = true;
          try {
            await send(rest, "commit");
          } catch (error) {
            // A later run may be refused before reaching the owner-held transaction.
            await job.send({ tx: id, ops: [], end: "abort", ...opener }).catch(() => {});
            throw error;
          }
        } else if (runs.length) await job.send({ ops: runs[0].ops, ...runs[0].who });
      },
      abort,
    };
  };

  /** Check permission synchronously when the rule can answer immediately. */
  const admit = (
    { name, def, input }: Asked,
    actor: Actor | undefined,
    reads: (as: Actor) => ReadContext,
  ): void | Promise<void> => {
    if (!def.allow || !actor || actor.kind === "system") return;
    const check = (ok: boolean) => {
      if (!ok) throw forbidden(`${actor.kind} ${actor.id} may not call "${name}".`);
    };
    const ok = allows(def.allow, actor, input, reads);
    return typeof ok === "boolean" ? check(ok) : ok.then(check);
  };

  /** Reserve in invocation order. Unmarked starts used rc.63's sequence of admitted, recorded calls. */
  const prepareCall = (
    job: Reach,
    numbering: string | undefined,
    name: string,
    input: unknown,
    actor: Actor | undefined,
    reads: (as: Actor) => ReadContext,
    atomicOnly = false,
  ) => {
    let position = numbering && job.callNumbering === 2 ? job.next(numbering) : 0;
    const def = registry.actions[name];
    if (!def) throw unknown("action", name, Object.keys(registry.actions));
    if (atomicOnly && !def.atomic && !def.transaction) {
      throw invalid(
        `"${name}" isn't atomic: a transaction calls only Actions declared \`atomic: true\` or \`transaction: true\`. ` +
          "Call it once the transaction has committed, or have it hear an event the transaction emits.",
      );
    }
    const normalized = json(actionInput(def, input));
    inputs[name]?.(normalized);
    refuseBlobKeys(normalized);
    const asked = { name, def, input: normalized };
    const admission = admit(asked, actor, reads);
    if (numbering && job.callNumbering !== 2 && def.record !== false) {
      position = job.next(numbering);
    }
    return { asked, admission, position };
  };

  /**
   * What code acting as `who` does in a held transaction: the opener's
   * scope, or an atomic Action's. Its calls run one at a time, in the order
   * they're made; each is numbered as it's made, so calls made together
   * number stably.
   */
  const scoped = (
    job: Reach,
    held: Held,
    who: Who,
    numbering: string | undefined,
  ): TransactionScope => {
    const run: Run = (op, options) => held.run(op, who, options);
    const runAs: RunAs = (as, action = who.action) => (op, options) =>
      held.run(op, { ...who, actor: as, action }, options);
    let turn: Promise<unknown> = Promise.resolve();
    return {
      db: {
        collection: (name) =>
          collection(
            name,
            run,
            querying(
              run,
              (name, doc, origin) => job.record(name, doc, origin ?? who),
              who.actor,
              runAs,
            ),
          ),
      },
      graph: {
        link: (from, type, to, data) =>
          run({ op: "link", edge: { from, type, to, data } }).then(() => {}),
        unlink: (from, type, to) => run({ op: "unlink", edge: { from, type, to } }).then(() => {}),
      },
      emit: (type, data = {}, options = {}) => {
        held.ensure();
        declared(type, data);
        const event = { id: options.id, type, data: json(data), cause: who.cause };
        held.queue({ op: "emit", event }, who);
      },
      schedule: (action, input, when) => {
        held.ensure();
        const op = scheduling(job, numbering, action, input, when);
        held.queue(op, who);
        return op.timer;
      },
      unschedule: (timer) => held.queue({ op: "unschedule", timer }, who),
      call: <R>(action: string, input?: unknown): Promise<R> => {
        try {
          held.ensure();
          // Permission reads see the effects of earlier calls on this scope.
          const before = turn;
          const { asked, admission, position } = prepareCall(
            job,
            numbering,
            action,
            input,
            who.actor,
            (as) =>
              reading(
                (op) => before.then(() => held.run(op, { ...who, actor: as, outside: true })),
                job.record,
                as,
              ),
            true,
          );
          const result = Promise.all([turn, admission]).then(() =>
            atomic<R>(job, held, asked, who, numbering, position)
          );
          turn = Promise.allSettled([turn, result]);
          return result;
        } catch (error) {
          return Promise.reject(error);
        }
      },
    };
  };

  /**
   * Runs an atomic Action in a held transaction (`tx.call`), as `who`'s
   * actor, with a context bound to it (see `joined`). A recorded one's
   * `action.started` and `action.completed` go in the transaction, so they
   * commit with its writes, or not at all; its retry check is asked there.
   * Its failure ends the transaction, which rolls back, and is on record
   * apart, as a nested call's is.
   */
  const atomic = async <R>(
    job: Reach,
    held: Held,
    { name, def, input }: Asked,
    who: Who,
    numbering: string | undefined,
    position: number,
    own?: { given?: CallJob },
  ): Promise<R> => {
    const { actor } = who;
    // Closed before its turn came (a call before it failed): it never ran.
    held.ensure();
    const run = (reach: Reach, its: Who, count?: string) => {
      const ctx = joined(reach, held, { ...its, action: name }, count, own?.given?.scheduled);
      return runAction<R>(
        registry,
        name,
        ctx,
        input,
        (actor, action) => held.run({ op: "elevate" }, { ...its, actor, action }),
      );
    };
    if (def.record === false) {
      const its: Who = { ...who, action: name };
      return await held.join(async () => {
        const result = await run(job, its, unrecordedScope(who.cause, numbering, position));
        if (own) await held.commit();
        return result;
      });
    }
    const inputHash = await fingerprint(name, input);
    const id = own?.given?.id ??
      (numbering ? `${numbering}.${position}.${inputHash}` : crypto.randomUUID());
    let prior: Outcome | undefined;
    if (!own?.given && who.cause && job.retry) {
      prior = await held.run({ op: "outcome", call: id }, who) as Outcome;
      if (prior.completed) {
        if (own) await held.commit();
        return prior.result as R;
      }
    }
    const { attempt, after, callNumbering } = own?.given ?? nextAttempt(prior);
    // Its own: what it writes answers to its call.
    const its: Who = { cause: id, ...(actor ? { actor } : {}) };
    const hidden = def.private ?? [];
    const marks: Op[] = [{
      op: "emit",
      event: {
        id,
        type: "action.started",
        data: {
          action: name,
          input: unprivate(input ?? null, hidden),
          inputHash,
          startedAt: new Date().toISOString(),
          attempt,
          callNumbering,
        },
        cause: who.cause,
      },
    }];
    if (after) {
      marks.push({
        op: "emit",
        event: {
          id: `${id}:retry:${attempt}`,
          type: "action.retried",
          data: { action: name, attempt, after },
          cause: id,
        },
      });
    }
    const begun = performance.now();
    const elapsed = () => Math.round((performance.now() - begun) * 100) / 100;
    job.frame("action", { type: "started", id, action: name, attempt });
    try {
      for (const mark of marks) held.queue(mark, its);
      const result = await run({ ...job, callNumbering }, its, id);
      const whole = json(result) ?? null;
      refuseBlobKeys(whole);
      const logged = unprivate(whole, hidden);
      const apart = logged !== whole && JSON.stringify(logged) !== JSON.stringify(whole);
      held.queue({
        op: "emit",
        event: {
          type: "action.completed",
          data: {
            action: name,
            result: logged,
            ms: elapsed(),
            attempt,
            ...(apart ? { private: true } : {}),
          },
          cause: id,
        },
      }, its);
      if (apart) {
        held.queue({
          op: "insert",
          collection: RESULTS,
          docs: [{ _id: id, result: whole }],
          ifAbsent: true,
        }, its);
      }
      if (own) await held.commit();
      return result;
    } catch (error) {
      await held.abort();
      const failed: Op = {
        op: "emit",
        event: {
          type: "action.failed",
          data: { action: name, error: failure(error), ms: elapsed(), attempt },
          cause: id,
        },
      };
      await job.send({ ops: [...marks, failed], cause: id, ...(actor ? { actor } : {}) })
        .catch(() => {});
      throw error;
    }
  };

  /**
   * An atomic Action's context in the transaction it was called into: its
   * reads see the transaction's writes and its writes are the transaction's,
   * its own `transaction` joins it (flattened), and it calls only atomic
   * Actions, in it too. What can't be rolled back, or waits on the world,
   * throws: streams, `fetch`, workers, cancelling, ending browsers.
   */
  const joined = (
    job: Reach,
    held: Held,
    who: Who,
    numbering: string | undefined,
    scheduled?: Scheduled,
  ): Context => {
    const { actor } = who;
    const record: Recorder = (name, doc, origin) => {
      if (!records[name]) throw invalid(`"${name}" is not a records collection`);
      const { _id, ...fields } = json(doc);
      records[name](fields);
      const id = typeof _id === "string" ? _id : crypto.randomUUID();
      held.queue({ op: "insert", collection: name, docs: [{ ...fields, _id: id }] }, {
        ...who,
        ...origin,
      });
      return id;
    };
    job = { ...job, record };
    const tx = scoped(job, held, who, numbering);
    const run: Run = (op, options) => held.run(op, who, options);
    // Reads as someone else, in the transaction, for an unrecorded Action a read calls (`ctx.as`).
    const runAs: RunAs = (as, action = who.action) => (op, options) =>
      held.run(op, { ...who, actor: as, action }, options);
    const refused = (what: string) => () => {
      throw invalid(
        `${what} isn't for an atomic Action: it does only what commits with its transaction`,
      );
    };
    const where = whereOf(actor);
    const ctx: Context = {
      db: tx.db,
      graph: { ...tx.graph, edges: (query) => run({ op: "edges", query }) as Promise<Edge[]> },
      emit: async (type, data, options) => tx.emit(type, data, options),
      transaction: (work) => held.join(() => work(tx)),
      stream: refused("ctx.stream"),
      call: (action, input) => tx.call(action, input),
      branch: (key) =>
        joined(job, held, who, `${numbering ?? crypto.randomUUID()}/${key}`, scheduled),
      ...(actor ? { actor } : {}),
      ...(where !== undefined ? { in: where } : {}),
      as: (other) => {
        const as = acting(actor, other);
        return joined(job, held, { ...who, ...(as ? { actor: as } : {}) }, numbering, scheduled);
      },
      schedule: async (action, input, when) => tx.schedule(action, input, when),
      unschedule: async (timer) => Number(await run({ op: "unschedule", timer })) > 0,
      cancel: refused("ctx.cancel"),
      disconnect: refused("ctx.disconnect"),
      render: presenter(registry.views, () => reading(run, job.record, actor, runAs)),
      kept: (_key, work) => work(ctx),
      record: (name, doc) => job.record(name, doc),
      metrics,
      fetch: refused("ctx.fetch"),
      resources: registry.resources,
      adapters: registry.adapters,
      describe: () => described(registry),
      workers: { dispatch: refused("ctx.workers"), call: refused("ctx.workers") },
      ...(scheduled ? { scheduled } : {}),
      retry: job.retry,
      signal: job.signal,
    };
    return ctx;
  };

  /**
   * What plugin code reaches. `cause` is what its writes answer to; nested
   * calls and timers are numbered under `numbering` (the cause, unless a
   * branch numbers its own).
   */
  const context = (
    job: Reach,
    cause?: string,
    event?: Event,
    scheduled?: Scheduled,
    numbering = cause,
    actor?: Actor,
    /** The unrecorded Action whose code this is, running in its caller's job. */
    action?: string,
  ): Context => {
    const run: Run = (op) =>
      job.send({ ops: [op], cause, ...(actor ? { actor } : {}), ...(action ? { action } : {}) });
    // Reads as someone else, for an unrecorded Action a read calls (`ctx.as`).
    const runAs: RunAs = (as, callee = action) => (op) =>
      job.send({
        ops: [op],
        cause,
        ...(as ? { actor: as } : {}),
        ...(callee ? { action: callee } : {}),
      });
    const record: Recorder = (name, doc, origin) =>
      job.record(name, doc, { cause, ...(origin ?? { actor, action }) });
    const ctx: Context = {
      db: { collection: (name) => collection(name, run, querying(run, record, actor, runAs)) },
      graph: {
        link: (from, type, to, data) =>
          run({ op: "link", edge: { from, type, to, data } }).then(() => {}),
        unlink: (from, type, to) => run({ op: "unlink", edge: { from, type, to } }).then(() => {}),
        edges: (query) => run({ op: "edges", query }) as Promise<Edge[]>,
      },
      emit: async (type, data = {}, options = {}) => {
        declared(type, data);
        await run({ op: "emit", event: { id: options.id, type, data, cause } });
      },
      transaction: (work) => transaction(job, work, cause, numbering, actor, action),
      stream: (channel) => ({ write: (data) => job.frame(channel, json(data)) }),
      call: (action, input) => call(job, action, input, cause, undefined, numbering, actor),
      branch: (key) =>
        context(
          job,
          cause,
          event,
          scheduled,
          `${numbering ?? crypto.randomUUID()}/${key}`,
          actor,
          action,
        ),
      ...(actor ? { actor } : {}),
      ...(whereOf(actor) !== undefined ? { in: whereOf(actor) } : {}),
      as: (other) => context(job, cause, event, scheduled, numbering, acting(actor, other), action),
      schedule: async (action, input, when) => {
        const op = scheduling(job, numbering, action, input, when);
        await run(op);
        return op.timer;
      },
      unschedule: async (timer) => Number(await run({ op: "unschedule", timer })) > 0,
      cancel: async (target) => Boolean(await run({ op: "cancel", ...target } as Op)),
      disconnect: async (actor) =>
        Number(
          await run({
            op: "disconnect",
            actor: {
              kind: actor.kind,
              id: actor.id,
              ...(typeof actor.key === "string" ? { key: actor.key } : {}),
            },
          }),
        ),
      render: presenter(registry.views, () => reading(run, record, actor, runAs)),
      // Kept only in the owner, for its rules: here it's worked out each time.
      kept: (_key, work) => work(ctx),
      record: (name, doc) => record(name, doc),
      metrics,
      fetch: outside,
      resources: registry.resources,
      adapters: registry.adapters,
      describe: () => described(registry),
      workers: working(job),
      event,
      ...(scheduled ? { scheduled } : {}),
      retry: job.retry,
      signal: job.signal,
    };
    return ctx;
  };

  /** A job's workers: work sent on through the owner, stopped when the job is. */
  const working = (job: Reach): Context["workers"] => {
    const dispatch: Context["workers"]["dispatch"] = async (kind, id, workload, input, options) => {
      const signal = options?.signal ? AbortSignal.any([job.signal, options.signal]) : job.signal;
      const call = await job.dispatch({ kind, id, workload }, json(input ?? null), signal);
      // The owner says first whether the worker took it, then its output follows.
      const said = await call.metadata as { error?: Failure };
      if (said.error) {
        await call.output.cancel().catch(() => {});
        throw raise(said.error);
      }
      return { output: call.output, done: call.completed };
    };
    return {
      dispatch,
      call: async (kind, id, workload, input, options) => {
        const { output, done } = await dispatch(kind, id, workload, input, options);
        const value = await decode(output);
        await done;
        return value as never;
      },
    };
  };

  /**
   * A timer, checked here: its Action and input. Its id is the caller's, or
   * comes from the call setting it and its place among that call's timers, so
   * a retried call sets the same timers again rather than more of them.
   */
  const scheduling = (
    job: Reach,
    cause: string | undefined,
    action: string,
    input: unknown,
    when: ScheduleOptions,
  ): Extract<TimerOp, { op: "schedule" }> => {
    if (!registry.actions[action]) throw unknown("action", action, Object.keys(registry.actions));
    const normalized = json(actionInput(registry.actions[action], input));
    inputs[action]?.(normalized);
    const { id, ...rest } = json(when ?? {}) as ScheduleOptions;
    const timer = id ?? (cause ? `${cause}:timer.${job.next(`${cause}:timer`)}` : undefined);
    return {
      op: "schedule",
      timer: timer ?? crypto.randomUUID(),
      call: action,
      ...(normalized === undefined ? {} : { input: normalized }),
      when: rest,
    };
  };

  /**
   * Runs an action, recorded as `action.started` and then `action.completed` or
   * `action.failed`. Everything the action writes has `action.started` as its
   * cause. `started` costs no commit of its own: every write carries it until
   * one commits (the store keeps the first copy), so it lands in the action's
   * earliest commit, ahead of all its effects. With no writes, it commits with
   * the completion. The events carry the call's own start time and duration.
   */
  const call = async <R>(
    job: Reach,
    name: string,
    input?: unknown,
    parent?: string,
    given?: CallJob,
    numbering = parent,
    actor?: Actor,
  ): Promise<R> => {
    // Code acting for someone calls what lets them, as they would from outside (an agent, for
    // whom it works for too); what has no `allow` is internal, code's to call. Going on where
    // they couldn't is a grant of the system's (`ctx.as`), on record as one.
    const who: Who = { cause: parent, actor };
    const held = registry.actions[name]?.transaction ? holding(job, who) : undefined;
    const { asked, admission, position } = prepareCall(
      job,
      given ? undefined : numbering,
      name,
      input,
      actor,
      (as) =>
        reading(
          (op) =>
            held
              ? held.run(op, { ...who, actor: as, outside: true })
              : job.send({ ops: [op], actor: as, outside: true }),
          job.record,
          as,
        ),
    );
    const { def: action, input: normalized } = asked;
    if (held) {
      try {
        if (admission) await admission;
        return await atomic(
          job,
          held,
          asked,
          who,
          numbering,
          position,
          { given },
        );
      } catch (error) {
        await held.abort();
        throw error;
      }
    }
    if (admission) await admission;
    const checkGrant = (actor: Actor, action: string) =>
      job.send({ ops: [{ op: "elevate" }], actor, action });
    if (action.record === false) {
      const count = unrecordedScope(parent, numbering, position);
      const ctx = context(job, parent, undefined, given?.scheduled, count, actor, name);
      return await runAction<R>(registry, name, ctx, normalized, checkGrant);
    }

    // A nested call's id comes from its cause, its place among the calls made
    // under it (taken before any await, so parallel calls number stably) and
    // what it does: a retry finds it again, and changed code makes a new call.
    // It hashes the whole input, private fields too, though the log never holds them.
    const inputHash = await fingerprint(name, normalized);
    const hidden = action.private ?? [];
    const id = given?.id ??
      (numbering ? `${numbering}.${position}.${inputHash}` : crypto.randomUUID());
    let prior: Outcome | undefined;
    if (!given && parent && job.retry) {
      // Asked as whom it works for: in someone's job, an op that names nobody is refused.
      prior = await job.send({
        ops: [{ op: "outcome", call: id }],
        ...(actor ? { actor } : {}),
      }) as Outcome;
      if (prior.completed) return prior.result as R;
    }
    const { attempt, after, callNumbering } = given ?? nextAttempt(prior);

    const begun = performance.now();
    // Marks the call's start (once per call) and, on a retry, this attempt.
    const marks: Op[] = [{
      op: "emit",
      event: {
        id,
        type: "action.started",
        data: {
          action: name,
          input: unprivate(normalized ?? null, hidden),
          inputHash,
          startedAt: new Date().toISOString(),
          attempt,
          callNumbering,
        },
        cause: parent,
      },
    }];
    if (after) {
      marks.push({
        op: "emit",
        event: {
          id: `${id}:retry:${attempt}`,
          type: "action.retried",
          data: { action: name, attempt, after },
          cause: id,
        },
      });
    }
    let pending = true;
    // Held transactions that already carry `started` in their first request.
    const carrying = new Set<string>();
    const reach: Reach = {
      ...job,
      callNumbering,
      async send(request) {
        const tx = "tx" in request ? request.tx : undefined;
        const end = "end" in request ? request.end : undefined;
        // A cancel stops other work, a disconnect ends browsers: neither writes this call's.
        const writes = tx !== undefined ||
          request.ops.some((op) => !isRead(op) && op.op !== "cancel" && op.op !== "disconnect");
        const carry = pending && writes && (tx === undefined || !carrying.has(tx));
        if (carry && tx !== undefined) carrying.add(tx);
        try {
          const value = await job.send(
            carry ? { ...request, ops: [...marks, ...request.ops] } : request,
          );
          // Committed: a single write at once; a held transaction when it commits.
          if (tx === undefined ? carry : end === "commit" && carrying.has(tx)) pending = false;
          return value;
        } finally {
          if (tx !== undefined && end) carrying.delete(tx);
        }
      },
    };
    const elapsed = () => Math.round((performance.now() - begun) * 100) / 100;
    const finish = (type: string, data: Record<string, unknown>, more: Op[] = []) =>
      reach.send({
        ops: [{ op: "emit", event: { type, data, cause: id } }, ...more],
        cause: id,
        action: name,
        ...(actor ? { actor } : {}),
      });

    job.frame("action", { type: "started", id, action: name, attempt });
    try {
      const ctx = context(reach, id, undefined, given?.scheduled, id, actor, name);
      // The call starts as its caller even when its first write is made as the grant.
      if (action.as) {
        await job.send({ ops: marks, cause: id, actor });
        pending = false;
      }
      const result = await runAction<R>(registry, name, ctx, normalized, checkGrant);
      // What it answers goes on record: one the owner would refuse fails the call, on record.
      const whole = json(result) ?? null;
      refuseBlobKeys(whole);
      // A result with private fields is logged without them, and kept whole apart
      // in the same commit, so a retry answers with all of it.
      const logged = unprivate(whole, hidden);
      const apart = logged !== whole && JSON.stringify(logged) !== JSON.stringify(whole);
      await finish(
        "action.completed",
        {
          action: name,
          result: logged,
          ms: elapsed(),
          attempt,
          ...(apart ? { private: true } : {}),
        },
        apart
          ? [{
            op: "insert",
            collection: RESULTS,
            docs: [{ _id: id, result: whole }],
            ifAbsent: true,
          }]
          : [],
      );
      return result;
    } catch (error) {
      await finish("action.failed", { action: name, error: failure(error), ms: elapsed(), attempt })
        .catch(() => {});
      throw error;
    }
  };

  const reading = (
    run: Run,
    record: Recorder,
    actor?: Actor,
    runAs?: RunAs,
  ): ReadContext => readingOver(registry, run, record, metrics, outside, actor, undefined, runAs);
  const querying = (run: Run, record: Recorder, actor?: Actor, runAs?: RunAs): Query =>
    queryingOver(registry, run, record, metrics, outside, actor, runAs);
  /**
   * How a job's read reads as someone else, for an unrecorded Action it calls that acts as them
   * (`ctx.as`): as trusted code does, not as the caller's own read.
   */
  const readingAs = (job: Reach): RunAs => (actor, action) => (op) =>
    job.send({ ops: [op], actor, action });

  const execute = (job: Reach, request: Job): unknown => {
    switch (request.kind) {
      case "call":
        return call(
          job,
          request.action,
          request.input,
          undefined,
          request,
          undefined,
          request.actor,
        );
      case "process": {
        const processor = registry.processors[request.processor];
        if (!processor) throw invalid(`Unknown processor "${request.processor}"`);
        // A Processor runs as the actor of the event it handles.
        return processor.run(
          context(
            job,
            request.event.id,
            request.event,
            undefined,
            request.event.id,
            request.event.actor,
          ),
          request.event,
        );
      }
      case "query":
        // What a query reads goes out to its caller: private fields stay in.
        return querying(
          (op) =>
            job.send({
              ops: [op],
              ...(request.actor ? { actor: request.actor, outside: true } : {}),
            }),
          job.record,
          request.actor,
          readingAs(job),
        )(
          request.collection,
          request.query,
          request.params,
        );
      case "render":
        return presenter(
          registry.views,
          () =>
            reading(
              (op) =>
                job.send({
                  ops: [op],
                  ...(request.actor ? { actor: request.actor, outside: true } : {}),
                }),
              job.record,
              request.actor,
              readingAs(job),
            ),
        )(request.view, request.item, {
          ...(request.viewer ? { viewer: request.viewer } : {}),
          ...(request.hints ? { hints: request.hints } : {}),
        });
    }
  };

  // One attempt per process: reconnects keep it, so Oxian can fence a replaced process.
  const attempt = { attemptId: crypto.randomUUID(), epoch: Date.now() };
  const remote = options.transport.type !== "in-process";

  const worker = createWorker({
    // Over a remote transport, or wherever the owner admits others, it shows the key.
    ...(remote || options.key
      ? {
        activate: ({ workerId }: { workerId: string }) => ({ identity: { workerId, ...attempt } }),
        register: () => ({
          credential: { kind: "registration" as const, capability: options.key ?? "" },
          expiresAtMs: Date.now() + 60_000,
        }),
      }
      : {}),
    id: options.id ?? `executor-${crypto.randomUUID()}`,
    transport: options.transport,
    capacity: options.capacity ?? 256,
    // A call may last as long as work sent on to a worker does; a storage op says its own deadline.
    hostCalls: { maxConcurrent: 1_024, timeoutMs: WORK_MS },
    workloads: {
      [RUN]: async ({ input, callHost, signal }) => {
        const request = await decode<Job>(input);
        const out = output();
        const counters = new Map<string, number>();
        // Records wait for the job's next write that commits on its own, and go
        // first in it; if it fails they wait again (an id kept twice is kept
        // once). What's left goes when the job ends.
        const pending: Sent[] = [];
        const timed = async (body: OpRequest) => {
          const started = performance.now();
          try {
            return await reply(callHost, body);
          } finally {
            roundTrips.record(performance.now() - started, {
              kind: "tx" in body ? "transaction" : body.ops.every(isRead) ? "read" : "write",
            });
          }
        };
        const send = async (body: OpRequest) => {
          if (!pending.length || "tx" in body || body.ops.every(isRead)) return timed(body);
          const carried = pending.splice(0);
          try {
            const runs = byWho(carried);
            const last = runs.at(-1)!;
            const rides = alike(last.who, body);
            if (rides) runs.pop();
            for (const { ops, who } of runs) await timed({ ops, ...who });
            return await timed(rides ? { ...body, ops: [...last.ops, ...body.ops] } : body);
          } catch (error) {
            // If a refused record kept the failure receipt from committing, write the receipt
            // on its own. Other actors' records may still be accepted under their own authority.
            if (body.ops.some((op) => op.op === "emit" && op.event.type === "action.failed")) {
              for (const { ops, who } of byWho(carried)) {
                await timed({ ops, ...who }).catch(() => {});
              }
              return timed(body);
            }
            // Stable record ids make replay of an already delivered group idempotent.
            pending.unshift(...carried);
            throw error;
          }
        };
        const own = request.kind === "process" ? request.event.actor : request.actor;
        const flush = async () => {
          for (const { ops, who } of byWho(pending.splice(0))) await timed({ ops, ...who });
        };
        const job: Reach = {
          send,
          dispatch: (to, input, signal) =>
            callHost({ workload: DISPATCH, metadata: to, body: encode(input), signal }),
          record(collection, doc, who = { actor: own }) {
            const check = records[collection];
            if (!check) throw invalid(`"${collection}" is not a records collection`);
            const { _id, ...fields } = json(doc);
            check(fields);
            const id = typeof _id === "string" ? _id : crypto.randomUUID();
            const entry = { _id: id, ...fields };
            const last = pending.at(-1);
            if (
              last?.op.op === "insert" && last.op.collection === collection && alike(last.who, who)
            ) {
              last.op.docs.push(entry);
            } else {
              pending.push({ op: { op: "insert", collection, docs: [entry] }, who });
            }
            return id;
          },
          frame: (channel, data) => out.write({ frame: { channel, data } }),
          signal,
          callNumbering: request.kind === "call" ? request.callNumbering : 2,
          retry: request.kind === "call"
            ? request.attempt > 1
            : request.kind === "process" && request.retry,
          next(cause) {
            const n = (counters.get(cause) ?? 0) + 1;
            counters.set(cause, n);
            return n;
          },
        };
        Promise.resolve().then(() => execute(job, request)).then(
          async (result) => {
            await flush();
            out.end({ result: json(result) });
          },
          async (error) => {
            await flush().catch(() => {});
            out.end({ error: failure(error) });
          },
        ).catch((error) => out.end({ error: failure(error) }));
        return out.readable;
      },
    },
  });

  return { ready: worker.ready.then(() => {}), stop: () => worker.stop().then(() => {}) };
}
