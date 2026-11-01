/**
 * An executor runs plugin code: Actions, Processor deliveries and queries. It
 * holds no store. Every storage call is an op sent to the owner, and live
 * frames ride the job's output back to it.
 */
import { createWorker, type WorkerOptions } from "@oxian/oxian-js";
import { collection, type Query, type Run } from "./collection.ts";
import type { Context, Plugins, ReadContext, TransactionScope } from "./define.ts";
import { isRead, type Op, type Outcome, type TimerOp } from "./ops.ts";
import type { Scheduled, ScheduleOptions } from "./schedules.ts";
import { compile, events, fingerprint, invalid, json, merge } from "./registry.ts";
import { renderer } from "./views.ts";
import { querying as queryingOver, reading as readingOver } from "./reads.ts";
import { type Metrics, noMetrics } from "./metrics.ts";
import type { Actor, Doc, Edge, Event } from "./store.ts";
import {
  decode,
  DISPATCH,
  encode,
  type Failure,
  failure,
  type Job,
  OP,
  type OpReply,
  type OpRequest,
  output,
  raise,
  RUN,
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

const reply = async (callHost: HostCaller, request: OpRequest) => {
  const call = await callHost({ workload: OP, body: encode(request) });
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
  },
): Executor {
  const registry = merge(options.plugins);
  const metrics = options.metrics ?? noMetrics;
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
  ): Promise<R> => {
    const who = actor ? { actor } : {};
    const id = crypto.randomUUID();
    const queued: Op[] = [];
    let begun = false;
    let active = true;
    let chain: Promise<unknown> = Promise.resolve();
    const run: Run = (op, options) => {
      if (!active) return Promise.reject(invalid("The transaction is closed."));
      if (UNANSWERED.has(op.op) || options?.unanswered) {
        queued.push(op);
        return Promise.resolve(undefined);
      }
      begun = true;
      const ops = [...queued.splice(0), op];
      const result = chain.then(() => job.send({ tx: id, ops, cause, ...who }));
      chain = result.catch(() => {});
      return result;
    };
    const scope: TransactionScope = {
      db: { collection: (name) => collection(name, run, querying(run, job.record, actor)) },
      graph: {
        link: (from, type, to, data) =>
          run({ op: "link", edge: { from, type, to, data } }).then(() => {}),
        unlink: (from, type, to) => run({ op: "unlink", edge: { from, type, to } }).then(() => {}),
      },
      emit: (type, data = {}, options = {}) => {
        if (!active) throw invalid("The transaction is closed.");
        declared(type, data);
        queued.push({ op: "emit", event: { id: options.id, type, data: json(data), cause } });
      },
      schedule: (action, input, when) => {
        if (!active) throw invalid("The transaction is closed.");
        const op = scheduling(job, numbering, action, input, when);
        queued.push(op);
        return op.timer;
      },
      unschedule: (timer) => {
        if (!active) throw invalid("The transaction is closed.");
        queued.push({ op: "unschedule", timer });
      },
    };
    try {
      const result = await work(scope);
      await chain;
      active = false;
      if (begun) {
        await chain.then(() =>
          job.send({ tx: id, ops: queued.splice(0), end: "commit", cause, ...who })
        );
      } else if (queued.length) await job.send({ ops: queued.splice(0), cause, ...who });
      return result;
    } catch (error) {
      if (active) {
        active = false;
        await chain;
        if (begun) {
          await job.send({ tx: id, ops: [], end: "abort", cause, ...who }).catch(() => {});
        }
      }
      throw error;
    }
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
  ): Context => {
    const run: Run = (op) => job.send({ ops: [op], cause, ...(actor ? { actor } : {}) });
    return {
      db: { collection: (name) => collection(name, run, querying(run, job.record, actor)) },
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
      transaction: (work) => transaction(job, work, cause, numbering, actor),
      stream: (channel) => ({ write: (data) => job.frame(channel, json(data)) }),
      call: (action, input) => call(job, action, input, cause, undefined, numbering, actor),
      branch: (key) =>
        context(job, cause, event, scheduled, `${numbering ?? crypto.randomUUID()}/${key}`, actor),
      ...(actor ? { actor } : {}),
      // Acting as someone else, or as the system: what it does says on whose behalf.
      as: (other) =>
        context(
          job,
          cause,
          event,
          scheduled,
          numbering,
          other
            ? { ...other, ...(actor ? { via: actor } : {}) }
            : actor
            ? { kind: "system", id: "system", via: actor }
            : undefined,
        ),
      schedule: async (action, input, when) => {
        const op = scheduling(job, numbering, action, input, when);
        await run(op);
        return op.timer;
      },
      unschedule: async (timer) => Number(await run({ op: "unschedule", timer })) > 0,
      cancel: async (target) => Boolean(await run({ op: "cancel", ...target } as Op)),
      render: renderer(registry.views, () => reading(run, job.record, actor)),
      record: job.record,
      metrics,
      resources: registry.resources,
      adapters: registry.adapters,
      workers: working(job),
      event,
      ...(scheduled ? { scheduled } : {}),
      retry: job.retry,
      signal: job.signal,
    };
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
    if (action.record === false) {
      return await action.run(
        context(job, parent, undefined, given?.scheduled, parent, actor),
        normalized,
      ) as R;
    }

    // A nested call's id comes from its cause, its place among the calls made
    // under it (taken before any await, so parallel calls number stably) and
    // what it does: a retry finds it again, and changed code makes a new call.
    const position = !given && numbering ? job.next(numbering) : 0;
    const inputHash = await fingerprint(name, normalized);
    let { id, attempt, after } = given ?? {
      id: numbering ? `${numbering}.${position}.${inputHash}` : crypto.randomUUID(),
      attempt: 1,
      after: undefined,
    };
    if (!given && parent && job.retry) {
      const prior = await job.send({ ops: [{ op: "outcome", call: id }] }) as Outcome;
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
          input: normalized ?? null,
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
        // A cancel stops other work: it writes nothing of this call's.
        const writes = tx !== undefined ||
          request.ops.some((op) => !isRead(op) && op.op !== "cancel");
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
    const finish = (type: string, data: Record<string, unknown>) =>
      reach.send({
        ops: [{ op: "emit", event: { type, data, cause: id } }],
        cause: id,
        ...(actor ? { actor } : {}),
      });

    job.frame("action", { type: "started", id, action: name, attempt });
    let result: R;
    try {
      result = await action.run(
        context(reach, id, undefined, given?.scheduled, id, actor),
        normalized,
      ) as R;
    } catch (error) {
      await finish("action.failed", { action: name, error: failure(error), ms: elapsed(), attempt })
        .catch(() => {});
      throw error;
    }
    await finish("action.completed", {
      action: name,
      result: json(result) ?? null,
      ms: elapsed(),
      attempt,
    });
    return result;
  };

  const reading = (run: Run, record: Context["record"], actor?: Actor): ReadContext =>
    readingOver(registry, run, record, metrics, actor);
  const querying = (run: Run, record: Context["record"], actor?: Actor): Query =>
    queryingOver(registry, run, record, metrics, actor);

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
        )(
          request.collection,
          request.query,
          request.params,
        );
      case "render":
        return renderer(
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
            ),
        )(request.renderer, request.view, request.item, {
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
    hostCalls: { maxConcurrent: 1_024 },
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
