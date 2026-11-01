/**
 * A client: the runtime as one person, somewhere else (a browser). It joins
 * the owner over Oxian as an untrusted worker bound to that person (see
 * design/views.md, "The web"), and runs Views here, with `observe` as the
 * owner does: their reads go over the connection, one batch per pass, and are
 * watched there; a read's new result, pushed, runs again the parts that read
 * it. Handlers' calls and events go to the owner, as the person.
 *
 * It loads front ends only (their Views, and their resources): the plugins
 * they build on live with the owner.
 */
import { createWorker } from "@oxian/oxian-js";
import {
  type Answer,
  CALL,
  EMIT,
  type Push,
  READ,
  type Remote,
  SESSION,
  UNWATCH,
} from "./browsers.ts";
import { collection } from "./collection.ts";
import type { Plugins, ReadContext } from "./define.ts";
import { noMetrics } from "./metrics.ts";
import { createObservers, type Observers } from "./observe.ts";
import { isRead, type Op } from "./ops.ts";
import { canonical, invalid, merge } from "./registry.ts";
import { decode, encode, lines } from "./wire.ts";

/** What a client's transport is: the one Oxian workers connect with. */
export type ClientTransport = Parameters<typeof createWorker>[0]["transport"];

export type Client = {
  /** Observes a View here, as the person: its reads come from the owner, and follow its changes. */
  observe: Observers["observe"];
  /** Calls an Action on the owner, as the person. */
  call<R = unknown>(action: string, input?: unknown): Promise<R>;
  /** Emits a declared event on the owner, as the person (what the event allows). */
  emit(type: string, data?: Record<string, unknown>): Promise<void>;
  /** Resolves when no part is running here. */
  idle(): Promise<void>;
  /** Connected, and the owner knows who it is. */
  ready: Promise<void>;
  close(): Promise<void>;
};

/** A call that never started because the connection was between sockets: safe to send again. */
const notStarted = (error: unknown) => {
  const e = error as { name?: string; code?: string; execution?: string } | null;
  return e?.name === "HostCallError" && e.code === "unavailable" && e.execution === "not_started";
};
/** How long a call waits for the connection to come back, in all. */
const RECONNECT_MS = 30_000;

/** The key a read is watched by: the same read, the same key. */
const keyOf = (read: Remote) => canonical(read);
/** Reads watched elsewhere are collections of their own to `observe`. */
const WATCHED = "@";

export function connect(options: {
  transport: ClientTransport;
  /** What it shows to connect: a one-time ticket from its host, asked for each new connection. */
  ticket(): Promise<string>;
  /** Its front ends: the Views it draws, and their resources. */
  plugins: Plugins;
  id?: string;
}): Client {
  const registry = merge(options.plugins, { elsewhere: true });
  const attempt = { attemptId: crypto.randomUUID(), epoch: Date.now() };

  /** What the owner said each watched read came to. */
  const known = new Map<string, Answer>();
  /** Reads asked for, not yet answered, by key. */
  const asked = new Map<string, Promise<Answer>>();
  /** Every read the Views here are watching, by key: what a new connection asks for again. */
  const watching = new Map<string, Remote>();
  /**
   * Reads being asked for, and what each was pushed meanwhile: a batch is answered
   * once its slowest read is, so what's pushed before the answer is newer than it.
   */
  const racing = new Map<string, Answer | undefined>();
  /** Connections the owner has opened to this client (its session streams). */
  let sessions = 0;
  let batch: { key: string; read: Remote; done: PromiseWithResolvers<Answer> }[] = [];

  const worker = createWorker({
    id: options.id ?? `browser-${crypto.randomUUID()}`,
    transport: options.transport,
    activate: ({ workerId }: { workerId: string }) => ({ identity: { workerId, ...attempt } }),
    register: async () => ({
      credential: { kind: "registration" as const, capability: await options.ticket() },
      expiresAtMs: Date.now() + 60_000,
    }),
    capacity: 1,
    hostCalls: { maxConcurrent: 64 },
    workloads: {
      // What the owner tells: each line, the new results of the reads one commit
      // changed. A new connection after the first watches nothing yet: what's
      // shown is asked for again.
      [SESSION]: async ({ input }) => {
        const session = ++sessions;
        if (session > 1) void rewatch();
        // A line: what one commit changed, shown at once.
        for await (const line of lines<Push[]>(input)) {
          // A newer connection has asked for everything again: this one's news is older.
          if (session !== sessions) break;
          const changed: string[] = [];
          for (const { key, ...now } of line) {
            if (racing.has(key)) racing.set(key, now as Answer);
            if (!known.has(key)) continue;
            known.set(key, now as Answer);
            changed.push(WATCHED + key);
          }
          if (changed.length) observers.changed(changed.map((c) => [c, [{}]]) as never);
        }
      },
    },
  });

  let closed = false;
  /** Asks the owner, as the person. While the connection is coming back, it waits and asks then. */
  const ask = async <R>(workload: string, body: unknown): Promise<R> => {
    let call: Awaited<ReturnType<typeof worker.callHost>>;
    for (let waited = 0, delay = 50;; delay = Math.min(delay * 2, 1_000)) {
      try {
        call = await worker.callHost({ workload, body: encode(body) });
        break;
      } catch (error) {
        if (closed || !notStarted(error) || waited >= RECONNECT_MS) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
        waited += delay;
      }
    }
    const answer = await decode<{ value?: R; error?: { message: string; code?: string } }>(
      call.output,
    );
    await call.completed;
    if (answer.error) throw Object.assign(new Error(answer.error.message), answer.error);
    return answer.value as R;
  };

  /** Asks for reads; each comes to what it was pushed meanwhile, or else to its answer. */
  const reading = async (reads: { key: string; read: Remote }[]) => {
    for (const { key } of reads) if (!racing.has(key)) racing.set(key, undefined);
    try {
      const answers = await ask<({ key: string } & Answer)[]>(READ, { reads });
      return answers.map(({ key, ...answer }) => ({ key, ...(racing.get(key) ?? answer) }));
    } finally {
      for (const { key } of reads) racing.delete(key);
    }
  };

  /** Sends what this pass asked for, in one batch. */
  const flush = async () => {
    const sent = batch;
    batch = [];
    try {
      const answers = await reading(sent.map(({ key, read }) => ({ key, read })));
      const byKey = new Map(answers.map(({ key, ...answer }) => [key, answer as Answer]));
      for (const { key, done } of sent) {
        const answer = byKey.get(key) ?? { error: { message: `No answer for ${key}` } };
        known.set(key, answer);
        asked.delete(key);
        done.resolve(answer);
      }
    } catch (error) {
      for (const { key, done } of sent) {
        asked.delete(key);
        done.reject(error);
      }
    }
  };

  /**
   * Asks again for every read watched here, after the connection was lost: the
   * owner then watches them on the new one, and what changed meanwhile shows
   * (reads that failed with the lost connection too). Failing, it asks again,
   * longer waits apart, until it's answered or a newer connection asks.
   */
  const rewatch = async (session = sessions, tries = 0): Promise<void> => {
    const reads = [...watching].map(([key, read]) => ({ key, read }));
    if (!reads.length) return;
    try {
      const answers = await reading(reads);
      const changed: string[] = [];
      for (const { key, ...answer } of answers) {
        if (!watching.has(key)) continue;
        if (canonical(known.get(key) ?? null) === canonical(answer)) continue;
        known.set(key, answer as Answer);
        changed.push(WATCHED + key);
      }
      if (changed.length) observers.changed(changed.map((c) => [c, [{}]]) as never);
    } catch {
      if (closed || session !== sessions) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** tries, 15_000)));
      if (!closed && session === sessions) await rewatch(session, tries + 1);
    }
  };

  /** A read's value: known, asked for already, or asked for now (with the pass's others). */
  const value = async (read: Remote, track: (read: { collection: string }) => void) => {
    const key = keyOf(read);
    track({ collection: WATCHED + key });
    watching.set(key, read);
    // Asked for already (by another part, this pass): the same answer. Only a read
    // that is pending is awaited, so two parts reading alike ask once.
    let answer = known.get(key);
    if (!answer) {
      let pending = asked.get(key);
      if (!pending) {
        const done = Promise.withResolvers<Answer>();
        pending = done.promise;
        asked.set(key, pending);
        if (!batch.length) queueMicrotask(() => void flush());
        batch.push({ key, read, done });
      }
      answer = await pending;
    }
    if ("error" in answer) throw Object.assign(new Error(answer.error.message), answer.error);
    return answer.value;
  };

  const refuse = (what: string) => () =>
    Promise.reject(invalid(`A View here only reads: ${what} is for its handlers`));

  const observers = createObservers({
    views: registry.views,
    reads: (track): ReadContext => {
      const run = (op: Op) => {
        if (!isRead(op)) return refuse("writing")();
        return value({ op }, track);
      };
      const query = (name: string, queryName: string, params: unknown) =>
        value({ collection: name, query: queryName, params: params ?? null }, track);
      return {
        db: { collection: (name) => collection(name, run, query) as never },
        graph: { edges: refuse("reading edges") as never },
        render: refuse("rendering") as never,
        record: () => {
          throw invalid("A View here records nothing");
        },
        metrics: noMetrics,
        resources: registry.resources,
        adapters: registry.adapters,
        call: refuse("calling Actions") as never,
      };
    },
    call: (action, input) => ask(CALL, { action, input: input ?? {} }) as Promise<never>,
    emit: (type, data) => ask(EMIT, { type, data: data ?? {} }),
    // No part reads it now: the owner stops watching it.
    unread: (watched) => {
      if (!watched.startsWith(WATCHED)) return;
      const key = watched.slice(WATCHED.length);
      known.delete(key);
      watching.delete(key);
      void ask(UNWATCH, { keys: [key] }).catch(() => {});
    },
  });

  return {
    observe: observers.observe,
    call: (action, input) => ask(CALL, { action, input: input ?? {} }),
    emit: (type, data) => ask(EMIT, { type, data: data ?? {} }),
    idle: observers.idle,
    ready: worker.ready.then(() => {}),
    close: () => {
      closed = true;
      return worker.stop();
    },
  };
}
