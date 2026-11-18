/**
 * An executor runs plugin code: Actions, Processor deliveries and queries. It
 * holds no store. Every storage call is an op sent to the owner, and live
 * frames ride the job's output back to it.
 */
import { createWorker, type WorkerOptions } from "@oxian/oxian-js";
import { collection, type Query, type Run } from "./collection.ts";
import type { ActionDef, Context, Plugins, ReadContext, TransactionScope } from "./define.ts";
import { isRead, type Op, type Outcome, RESULTS, type TimerOp } from "./ops.ts";
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
  unprivate,
} from "./registry.ts";
import { presenter } from "./views.ts";
import { refuseBlobKeys } from "./blobs.ts";
import { querying as queryingOver, reading as readingOver, type RunAs } from "./reads.ts";
import { type Metrics, noMetrics } from "./metrics.ts";
import type { Actor, Doc, Edge, Event } from "./store.ts";
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
  record: Context["record"];
  frame(channel: string, data: unknown): void;
  signal: AbortSignal;
  /** This job may repeat earlier work: a retried call or delivery. */
  retry: boolean;
  /** Numbers the nested calls made under each cause, in call order. */
  next(cause: string): number;
};

/** For whom ops in a held transaction go: what their writes answer to, as whom, in whose code. */
type Who = { cause?: string; actor?: Actor; action?: string };

/** An op waiting to go in a held transaction, and for whom. */
type Sent = { op: Op; who: Who };

/** An atomic Action asked for in a transaction, checked: its declaration and its input. */
type Asked = { name: string; def: ActionDef; input: unknown };

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
  (a.cause === b.cause && a.action === b.action &&
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
          await send(rest, "commit");
        } else if (runs.length) await job.send({ ops: runs[0].ops, ...runs[0].who });
      },
      abort,
    };
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
    const runAs: RunAs = (as) => (op, options) => held.run(op, { ...who, actor: as }, options);
    let turn: Promise<unknown> = Promise.resolve();
    return {
      db: {
        collection: (name) => collection(name, run, querying(run, job.record, who.actor, runAs)),
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
        let asked: Asked;
        try {
          held.ensure();
          asked = atomicOf(action, input, who.actor);
        } catch (error) {
          return Promise.reject(error);
        }
        const position = asked.def.record !== false && numbering ? job.next(numbering) : 0;
        const result = turn.then(() => atomic<R>(job, held, asked, who, numbering, position));
        turn = result.catch(() => {});
        return result;
      },
    };
  };

  /**
   * An atomic Action a transaction may call, checked before anything of it
   * runs, as `ctx.call` checks: declared, atomic, its input, and its `allow`
   * for `actor`. A refusal here ends nothing: none of the Action ran.
   */
  const atomicOf = (name: string, input: unknown, actor: Actor | undefined): Asked => {
    const def = registry.actions[name];
    if (!def) throw invalid(`Unknown action "${name}"`);
    if (!def.atomic) {
      throw invalid(
        `"${name}" isn't atomic: a transaction calls only Actions declared \`atomic: true\`. ` +
          "Call it once the transaction has committed, or have it hear an event the transaction emits.",
      );
    }
    const normalized = json(input);
    inputs[name]?.(normalized);
    refuseBlobKeys(normalized);
    if (def.allow && actor && actor.kind !== "system" && !allows(def.allow, actor, normalized)) {
      throw forbidden(`${actor.kind} ${actor.id} may not call "${name}".`);
    }
    return { name, def, input: normalized };
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
  ): Promise<R> => {
    const { actor } = who;
    // Closed before its turn came (a call before it failed): it never ran.
    held.ensure();
    if (def.record === false) {
      const its: Who = { ...who, action: name };
      return await held.join(async () =>
        await def.run(joined(job, held, its, who.cause), input) as R
      );
    }
    const inputHash = await fingerprint(name, input);
    const id = numbering ? `${numbering}.${position}.${inputHash}` : crypto.randomUUID();
    let attempt = 1;
    let after: "failed" | "lost" | undefined;
    if (who.cause && job.retry) {
      const prior = await held.run({ op: "outcome", call: id }, who) as Outcome;
      if (prior.completed) return prior.result as R;
      attempt = prior.attempts + 1;
      if (prior.attempts) after = prior.lost ? "lost" : "failed";
    }
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
      const result = await def.run(joined(job, held, its, id), input) as R;
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
  const joined = (job: Reach, held: Held, who: Who, numbering: string | undefined): Context => {
    const { actor } = who;
    const tx = scoped(job, held, who, numbering);
    const run: Run = (op, options) => held.run(op, who, options);
    // Reads as someone else, in the transaction, for an unrecorded Action a read calls (`ctx.as`).
    const runAs: RunAs = (as) => (op, options) => held.run(op, { ...who, actor: as }, options);
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
      branch: (key) => joined(job, held, who, `${numbering ?? crypto.randomUUID()}/${key}`),
      ...(actor ? { actor } : {}),
      ...(where !== undefined ? { in: where } : {}),
      as: (other) => {
        const as = acting(actor, other);
        return joined(job, held, { ...who, ...(as ? { actor: as } : {}) }, numbering);
      },
      schedule: async (action, input, when) => tx.schedule(action, input, when),
      unschedule: async (timer) => Number(await run({ op: "unschedule", timer })) > 0,
      cancel: refused("ctx.cancel"),
      disconnect: refused("ctx.disconnect"),
      render: presenter(registry.views, () => reading(run, job.record, actor, runAs)),
      kept: (_key, work) => work(ctx),
      record: job.record,
      metrics,
      fetch: refused("ctx.fetch"),
      resources: registry.resources,
      adapters: registry.adapters,
      describe: () => described(registry),
      workers: { dispatch: refused("ctx.workers"), call: refused("ctx.workers") },
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
    const runAs: RunAs = (as) => (op) =>
      job.send({ ops: [op], cause, ...(as ? { actor: as } : {}), ...(action ? { action } : {}) });
    const ctx: Context = {
      db: { collection: (name) => collection(name, run, querying(run, job.record, actor, runAs)) },
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
      render: presenter(registry.views, () => reading(run, job.record, actor, runAs)),
      // Kept only in the owner, for its rules: here it's worked out each time.
      kept: (_key, work) => work(ctx),
      record: job.record,
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
    if (!registry.actions[action]) throw invalid(`Unknown action "${action}"`);
    const normalized = json(input);
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
    given?: { id: string; attempt: number; after?: "failed" | "lost"; scheduled?: Scheduled },
    numbering = parent,
    actor?: Actor,
  ): Promise<R> => {
    const action = registry.actions[name];
    if (!action) throw invalid(`Unknown action "${name}"`);
    const normalized = json(input);
    inputs[name]?.(normalized);
    // An Action's input may hold no `$blob` key (see blobs.ts), as the owner checks outside calls'.
    refuseBlobKeys(normalized);
    // Code acting for someone calls what lets them, as they would from outside (an agent, for
    // whom it works for too); what has no `allow` is internal, code's to call. Going on where
    // they couldn't is a grant of the system's (`ctx.as`), on record as one.
    if (
      action.allow && actor && actor.kind !== "system" && !allows(action.allow, actor, normalized)
    ) {
      throw forbidden(`${actor.kind} ${actor.id} may not call "${name}".`);
    }
    if (action.record === false) {
      return await action.run(
        context(job, parent, undefined, given?.scheduled, parent, actor, name),
        normalized,
      ) as R;
    }

    // A nested call's id comes from its cause, its place among the calls made
    // under it (taken before any await, so parallel calls number stably) and
    // what it does: a retry finds it again, and changed code makes a new call.
    // It hashes the whole input, private fields too, though the log never holds them.
    const position = !given && numbering ? job.next(numbering) : 0;
    const inputHash = await fingerprint(name, normalized);
    const hidden = action.private ?? [];
    let { id, attempt, after } = given ?? {
      id: numbering ? `${numbering}.${position}.${inputHash}` : crypto.randomUUID(),
      attempt: 1,
      after: undefined,
    };
    if (!given && parent && job.retry) {
      // Asked as whom it works for: in someone's job, an op that names nobody is refused.
      const prior = await job.send({
        ops: [{ op: "outcome", call: id }],
        ...(actor ? { actor } : {}),
      }) as Outcome;
      if (prior.completed) return prior.result as R;
      attempt = prior.attempts + 1;
      if (prior.attempts) after = prior.lost ? "lost" : "failed";
    }

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
        ...(actor ? { actor } : {}),
      });

    job.frame("action", { type: "started", id, action: name, attempt });
    let result: R;
    let recorded: unknown;
    try {
      result = await action.run(
        context(reach, id, undefined, given?.scheduled, id, actor),
        normalized,
      ) as R;
      // What it answers goes on record: one the owner would refuse fails the call, on record.
      recorded = json(result) ?? null;
      refuseBlobKeys(recorded);
    } catch (error) {
      await finish("action.failed", { action: name, error: failure(error), ms: elapsed(), attempt })
        .catch(() => {});
      throw error;
    }
    // A result with private fields is logged without them, and kept whole apart
    // in the same commit, so a retry answers with all of it.
    const whole = recorded;
    const logged = unprivate(whole, hidden);
    const apart = logged !== whole && JSON.stringify(logged) !== JSON.stringify(whole);
    await finish(
      "action.completed",
      { action: name, result: logged, ms: elapsed(), attempt, ...(apart ? { private: true } : {}) },
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
  };

  const reading = (
    run: Run,
    record: Context["record"],
    actor?: Actor,
    runAs?: RunAs,
  ): ReadContext => readingOver(registry, run, record, metrics, outside, actor, undefined, runAs);
  const querying = (run: Run, record: Context["record"], actor?: Actor, runAs?: RunAs): Query =>
    queryingOver(registry, run, record, metrics, outside, actor, runAs);
  /**
   * How a job's read reads as someone else, for an unrecorded Action it calls that acts as them
   * (`ctx.as`): as trusted code does, not as the caller's own read.
   */
  const readingAs = (job: Reach): RunAs => (actor) => (op) =>
    job.send({ ops: [op], ...(actor ? { actor } : {}) });

  const execute = (job: Reach, request: Job): unknown => {
    switch (request.kind) {
      case "call":
        return call(
          job,
          request.action,
          request.input,
          undefined,
          {
            id: request.id,
            attempt: request.attempt,
            after: request.after,
            scheduled: request.scheduled,
          },
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
        const pending = new Map<string, Record<string, unknown>[]>();
        const riding = () => {
          const ops: Op[] = [...pending].map(([collection, docs]) => ({
            op: "insert",
            collection,
            docs: docs as Doc[],
          }));
          pending.clear();
          return ops;
        };
        const requeue = (ops: Op[]) => {
          for (const op of ops) {
            if (op.op !== "insert") continue;
            pending.set(op.collection, [...op.docs, ...pending.get(op.collection) ?? []]);
          }
        };
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
          if (!pending.size || "tx" in body || body.ops.every(isRead)) return timed(body);
          const carried = riding();
          try {
            return await timed({ ...body, ops: [...carried, ...body.ops] });
          } catch (error) {
            requeue(carried);
            throw error;
          }
        };
        // What's left goes as the job's own actor: the owner checks every op against it.
        const own = request.kind === "process" ? request.event.actor : request.actor;
        const flush = async () => {
          if (pending.size) await timed({ ops: riding(), ...(own ? { actor: own } : {}) });
        };
        const job: Reach = {
          send,
          dispatch: (to, input, signal) =>
            callHost({ workload: DISPATCH, metadata: to, body: encode(input), signal }),
          record(collection, doc) {
            const check = records[collection];
            if (!check) throw invalid(`"${collection}" is not a records collection`);
            const { _id, ...fields } = json(doc);
            check(fields);
            const id = typeof _id === "string" ? _id : crypto.randomUUID();
            const docs = pending.get(collection);
            if (docs) docs.push({ _id: id, ...fields });
            else pending.set(collection, [{ _id: id, ...fields }]);
            return id;
          },
          frame: (channel, data) => out.write({ frame: { channel, data } }),
          signal,
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
