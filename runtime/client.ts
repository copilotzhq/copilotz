/**
 * A client: the runtime as one person, somewhere else (a browser, a
 * script). It joins the owner over Oxian as an untrusted worker bound to
 * that person (see design/views.md, "The web"), and runs Views here, with
 * `observe` as the owner does: their reads go over the connection, one batch
 * per pass, and are watched there; a read's new result, pushed, runs again
 * the parts that read it. Handlers' calls and events go to the owner, as the
 * person.
 *
 * **Its collections** (`client.db.collection(name)`) are spelled as plugin
 * code's (`ctx.db.collection(name)`): `find` (with `.toArray()`), `findOne`,
 * `countDocuments`, `insertOne`, `updateOne`, `replaceOne`, `deleteOne`, a
 * named `query`, and `watch(filter, options?, onChange)`, which shows the
 * rows now and after each commit that changes them, until stopped. Each is
 * the person's own operation, as the owner admits one from outside (see
 * `admitted`, owner.ts: only where a rule speaks for the collection, never
 * private fields); an update with no operator sets the fields it gives.
 *
 * **One script, either transport:** `connect(url, { key })` connects over
 * the socket, with a ticket from `POST /connect` (the key as its
 * `Authorization`; none, the browser's cookie); `connect(url, { key, over:
 * "http" })`, over the REST API (`/api/`, see rest.ts), where a watch is a
 * server-sent stream. The rest of the script is the same:
 *
 * ```ts
 * const app = await connect("https://mobizap.app", { key: env.MOBIZAP_KEY });
 * const open = await app.db.collection("booking").find({ status: "open" }).toArray();
 * await app.db.collection("booking").updateOne({ _id: "42" }, { $set: { note: "janela" } });
 * await app.call("booking.cancel", { id: "42" });
 * const stop = app.db.collection("booking").watch({ status: "open" }, (rows) => show(rows));
 * ```
 *
 * Or over a link of its host's (`link`): reads asked and Actions called by
 * whatever carries them (an outside assistant's widget bridge, a server
 * answering as the person), with no pushes: what's shown is asked again when
 * the host says (`refresh`), or set from what came back (`update`). Seeded
 * with answers already known (`known`: a snapshot), its first pass reads none
 * of them. What it knows of the reads watched now is `known()`: a snapshot,
 * by the same keys.
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
  WRITE,
} from "./browsers.ts";
import {
  collection,
  type Cursor,
  cursor,
  type DeleteResult,
  type UpdateResult,
  type WithId,
} from "./collection.ts";
import type { Plugins, ReadContext } from "./define.ts";
import type { Filter, FindOptions, Update } from "./store.ts";
import { restLink } from "./rest.ts";
import { noMetrics } from "./metrics.ts";
import { createObservers, type Observers } from "./observe.ts";
import { isRead, type Op, type WriteOp } from "./ops.ts";
import { canonical, invalid, merge } from "./registry.ts";
import { decode, encode, lines } from "./wire.ts";

/** What a client's transport is: the one Oxian workers connect with. */
export type ClientTransport = Parameters<typeof createWorker>[0]["transport"];

/**
 * What carries a client's reads and calls when it isn't Oxian (see `connect`): each answers as
 * the person, under the rules, as the owner answers a browser.
 */
export type ClientLink = {
  /** Answers a batch of reads, by the key each was asked under. */
  read(reads: { key: string; read: Remote }[]): Promise<({ key: string } & Answer)[]>;
  /** Calls an Action; with `id`, the caller's own id for the call (done once). */
  call(action: string, input: unknown, options?: { id?: string }): Promise<unknown>;
  emit?(type: string, data: Record<string, unknown>): Promise<void>;
  /** A write to a collection, as the person, answered as MongoDB does (`insertedId`…). */
  write?(op: WriteOp): Promise<unknown>;
  /** A read watched: its answer now, and each new one, until the function it returns is called. */
  watch?(read: Remote, listener: (answer: Answer) => void): () => void;
};

/** What a watch is told: the rows now; failing, none, and why. */
export type Watcher<T> = (rows: WithId<T>[], error?: Error & { code?: string }) => void;

/**
 * A collection, from outside: spelled as plugin code's `ctx.db.collection`,
 * each operation the person's own (see the module's header).
 */
export type ClientCollection<T = Record<string, unknown>> = {
  find(filter?: Filter, options?: FindOptions): Cursor<T>;
  findOne(filter?: Filter, options?: FindOptions): Promise<WithId<T> | null>;
  countDocuments(filter?: Filter): Promise<number>;
  insertOne(doc: T & { _id?: string }): Promise<{ acknowledged: true; insertedId: string }>;
  /** `update` is an update document (`$set`, `$inc`…), or the fields to set. */
  updateOne(
    filter: Filter,
    update: Update | Partial<T>,
    options?: { upsert?: boolean },
  ): Promise<UpdateResult>;
  replaceOne(filter: Filter, doc: T, options?: { upsert?: boolean }): Promise<UpdateResult>;
  deleteOne(filter: Filter): Promise<DeleteResult>;
  /** Runs one of the collection's named queries. */
  query<R = unknown>(name: string, params?: unknown): Promise<R>;
  /**
   * The rows `find(filter, options)` finds, now and after each commit that
   * changes them: `onChange` hears each. It returns how to stop.
   */
  watch(filter: Filter, onChange: Watcher<T>): () => void;
  watch(filter: Filter, options: FindOptions, onChange: Watcher<T>): () => void;
};

/** Reads' answers by their keys: what a client knows (a snapshot), or is seeded with. */
export type Known = [key: string, answer: Answer][];

export type Client = {
  /** Observes a View here, as the person: its reads come from the owner, and follow its changes. */
  observe: Observers["observe"];
  /** Collections, as the person reads and writes them (see the module's header). */
  db: { collection<T = Record<string, unknown>>(name: string): ClientCollection<T> };
  /**
   * Calls an Action on the owner, as the person. With `id` (theirs alone),
   * sent again it answers what the first did, without doing it twice.
   */
  call<R = unknown>(action: string, input?: unknown, options?: { id?: string }): Promise<R>;
  /** Emits a declared event on the owner, as the person (what the event allows). */
  emit(type: string, data?: Record<string, unknown>): Promise<void>;
  /** Resolves when no part is running here. */
  idle(): Promise<void>;
  /** What it knows of the reads watched now, by key: a snapshot to seed another client with. */
  known(): Known;
  /** The reads watched now, by key: what to ask answers for, after a call over a link. */
  watching(): { key: string; read: Remote }[];
  /** Asks every read watched here again; what changed shows. For a link, which isn't pushed to. */
  refresh(): Promise<void>;
  /** Reads' new answers, by key, from elsewhere (a call's reply): those watched here show them. */
  update(answers: Known): void;
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

/** How a client connects: over Oxian (with a ticket for each connection), or over a link. */
export type ClientOptions =
  & {
    /** Its front ends: the Views it draws, and their resources. */
    plugins: Plugins;
    /** Answers already known, by read key (a snapshot): the first pass reads none of them. */
    known?: Known;
  }
  & (
    | {
      transport: ClientTransport;
      /** What it shows to connect: a one-time ticket from its host, asked for each new connection. */
      ticket(): Promise<string>;
      id?: string;
      link?: undefined;
    }
    | { link: ClientLink; transport?: undefined }
  );

/** How a script connects to an app by its address (see `connect`). */
export type RemoteOptions = {
  /** A developer key (`Authorization: Bearer`); none: the browser's cookie, from the app's page. */
  key?: string;
  /** Over the socket (by default), or over HTTP: the REST API, a watch a server-sent stream. */
  over?: "socket" | "http";
  /** Its front ends, to `observe` Views here (none by default). */
  plugins?: Plugins;
  /** What it calls the app with: the platform's `fetch` unless said (a runtime's own, in tests). */
  fetch?: typeof fetch;
};

/**
 * Connects to an app at `url` (`https://mobizap.app`, or an org's
 * `https://compass.app/o/acme`) as whoever `key` is (none: the browser's
 * cookie): over its socket, once it's connected; or over HTTP (`over:
 * "http"`), at once.
 */
export function connect(url: string, options?: RemoteOptions): Promise<Client>;
/** A client over Oxian's `transport` (with a `ticket` for each connection), or over a `link`. */
export function connect(options: ClientOptions): Client;
export function connect(
  first: string | ClientOptions,
  remote: RemoteOptions = {},
): Client | Promise<Client> {
  if (typeof first !== "string") return open(first);
  const base = first.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) {
    return Promise.reject(invalid("connect takes the app's http(s) address"));
  }
  const plugins = remote.plugins ?? [];
  if (remote.over === "http") {
    return Promise.resolve(
      open({ link: restLink(base, { key: remote.key, fetch: remote.fetch }), plugins }),
    );
  }
  if (remote.over !== undefined && remote.over !== "socket") {
    return Promise.reject(invalid('connect is over "socket" or "http"'));
  }
  const send = remote.fetch ?? globalThis.fetch.bind(globalThis);
  const client = open({
    transport: {
      type: "websocket",
      config: { url: `${base.replace(/^http/, "ws")}/oxian`, allowInsecureLoopback: true },
    },
    // A one-time ticket for each connection, for whoever the key (or the cookie) is.
    ticket: async () => {
      const response = await send(`${base}/connect`, {
        method: "POST",
        headers: remote.key ? { authorization: `Bearer ${remote.key}` } : {},
        credentials: "same-origin",
      });
      const said = await response.json().catch(() => ({})) as {
        ticket?: string;
        error?: string | { message?: string; code?: string };
      };
      if (!response.ok || typeof said.ticket !== "string") {
        const message = typeof said.error === "string" ? said.error : said.error?.message;
        throw Object.assign(new Error(message ?? `/connect answered ${response.status}`), {
          code: response.status === 401 ? "unauthorized" : "unavailable",
        });
      }
      return said.ticket;
    },
    plugins,
  });
  return client.ready.then(() => client, async (error) => {
    await client.close().catch(() => {});
    throw error;
  });
}

function open(options: ClientOptions): Client {
  const registry = merge(options.plugins, { elsewhere: true });

  /** What the owner said each watched read came to. */
  const known = new Map<string, Answer>(options.known ?? []);
  /** Reads asked for, not yet answered, by key. */
  const asked = new Map<string, Promise<Answer>>();
  /** Every read the Views here are watching, by key: what a new connection asks for again. */
  const watching = new Map<string, Remote>();
  /**
   * Reads being asked for, and what each was pushed meanwhile: a batch is answered
   * once its slowest read is, so what's pushed before the answer is newer than it.
   */
  const racing = new Map<string, Answer | undefined>();
  /**
   * Reads watched for the collections' `watch` (not Views'), by their own
   * keys: what each was, and who hears its answers. A new connection asks
   * for them again.
   */
  const direct = new Map<
    string,
    {
      read: Remote;
      hear(answer: Answer): void;
      /** Pushed while it was being asked for: its answer, when it comes, is older. */
      pushed?: boolean;
    }
  >();
  /** Connections the owner has opened to this client (its session streams). */
  let sessions = 0;
  let batch: { key: string; read: Remote; done: PromiseWithResolvers<Answer> }[] = [];

  /** One enrolment: a worker that comes in with a new ticket, and keeps its connection after. */
  const enrol = (over: { transport: ClientTransport; ticket(): Promise<string>; id: string }) => {
    const attempt = { attemptId: crypto.randomUUID(), epoch: Date.now() };
    return createWorker({
      id: over.id,
      transport: over.transport,
      activate: ({ workerId }: { workerId: string }) => ({ identity: { workerId, ...attempt } }),
      register: async () => ({
        credential: { kind: "registration" as const, capability: await over.ticket() },
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
          if (session > 1) {
            void rewatch();
            for (const [key, { read }] of direct) void watchOver(key, read);
          }
          // A line: what one commit changed, shown at once.
          for await (const line of lines<Push[]>(input)) {
            // A newer connection has asked for everything again: this one's news is older.
            if (session !== sessions) break;
            const changed: string[] = [];
            for (const { key, ...now } of line) {
              const watched = direct.get(key);
              if (watched) {
                watched.pushed = true;
                watched.hear(now as Answer);
              }
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
  };
  let closed = false;
  const oxian = options.link === undefined
    ? {
      transport: options.transport,
      ticket: options.ticket,
      id: options.id ?? `browser-${crypto.randomUUID()}`,
    }
    : undefined;
  let worker = oxian ? enrol(oxian) : undefined;
  /**
   * Once in, its way back refused (who it was ended: signed out, erased, and
   * its resume credential with it; or an owner that never knew it), it comes
   * in again with a new ticket, which only a browser that's still someone gets
   * (a page's `ticket` reloads it otherwise). One never let in stays out.
   */
  const follow = (current: NonNullable<typeof worker>, again = 0) => {
    current.closed.catch(() => {});
    // Back in after having been in: a refusal (a busy moment) is tried again, longer apart.
    const retry = () => {
      if (closed || current !== worker || !again) return;
      setTimeout(() => {
        if (closed || current !== worker) return;
        worker = enrol(oxian!);
        follow(worker, again + 1);
      }, Math.min(500 * 2 ** (again - 1), 5_000));
    };
    void current.ready.then(() =>
      current.closed.then((result) => {
        if (closed || current !== worker || result.reason !== "reenrollment_required") return;
        worker = enrol(oxian!);
        follow(worker, 1);
      })
    ).catch(retry);
  };
  if (worker) follow(worker);

  /** Asks the owner over Oxian, as the person. While the connection is coming back, it waits and asks then. */
  const viaOxian = async <R>(workload: string, body: unknown): Promise<R> => {
    let call: Awaited<ReturnType<NonNullable<typeof worker>["callHost"]>>;
    for (let waited = 0, delay = 50;; delay = Math.min(delay * 2, 1_000)) {
      try {
        call = await worker!.callHost({ workload, body: encode(body) });
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

  /** Asks the owner, as the person: over Oxian, or over the host's link. */
  const ask = async <R>(workload: string, body: Record<string, unknown>): Promise<R> => {
    const link = options.link;
    if (!link) return await viaOxian<R>(workload, body);
    switch (workload) {
      case READ:
        return await link.read(body.reads as { key: string; read: Remote }[]) as R;
      case CALL:
        return await link.call(
          body.action as string,
          body.input,
          typeof body.id === "string" ? { id: body.id } : {},
        ) as R;
      case WRITE:
        if (!link.write) throw invalid("This client's link writes nothing");
        return await link.write(body.op as WriteOp) as R;
      case EMIT:
        if (!link.emit) throw invalid("This client's link emits no events");
        return await link.emit(body.type as string, body.data as Record<string, unknown>) as R;
      default:
        // Nothing is watched over a link: there's nothing to stop watching.
        return undefined as R;
    }
  };

  /** One read, answered once: asked, then no longer watched. */
  const once = async (read: Remote): Promise<unknown> => {
    const key = `once:${crypto.randomUUID()}`;
    const [answer] = await ask<({ key: string } & Answer)[]>(READ, { reads: [{ key, read }] });
    if (!options.link) void ask(UNWATCH, { keys: [key] }).catch(() => {});
    if (!answer) throw new Error("No answer");
    if ("error" in answer) throw Object.assign(new Error(answer.error.message), answer.error);
    return answer.value;
  };

  /** Asks over Oxian for a read watched by its own key: its answer, then what's pushed. */
  const watchOver = async (key: string, read: Remote) => {
    const watched = direct.get(key);
    if (watched) watched.pushed = false;
    try {
      const [answer] = await viaOxian<({ key: string } & Answer)[]>(READ, {
        reads: [{ key, read }],
      });
      // What was pushed meanwhile is newer than this answer.
      if (answer && !direct.get(key)?.pushed) {
        const { key: _, ...said } = answer;
        direct.get(key)?.hear(said as Answer);
      }
    } catch (error) {
      const { message, code } = error as { message?: string; code?: string };
      direct.get(key)?.hear({
        error: { message: message ?? String(error), ...(code ? { code } : {}) },
      });
    }
  };

  /** A read watched (not a View's): `hear` gets its answer now and each new one, until stopped. */
  const watchRead = (read: Remote, hear: (answer: Answer) => void): () => void => {
    if (options.link) {
      if (!options.link.watch) {
        queueMicrotask(() => hear({ error: { message: "This client's link watches nothing" } }));
        return () => {};
      }
      return options.link.watch(read, hear);
    }
    const key = `watch:${crypto.randomUUID()}`;
    let last: string | undefined;
    direct.set(key, {
      read,
      // The same answer again (a new connection's) isn't news.
      hear: (answer) => {
        const text = canonical(answer);
        if (text === last) return;
        last = text;
        hear(answer);
      },
    });
    void watchOver(key, read);
    return () => {
      if (!direct.delete(key)) return;
      void ask(UNWATCH, { keys: [key] }).catch(() => {});
    };
  };

  /** A collection, as the person reads and writes it from here. */
  const collectionOf = <T>(name: string): ClientCollection<T> => {
    const write = (op: WriteOp) => ask<unknown>(WRITE, { op });
    const watch = (
      filter: Filter,
      second: FindOptions | Watcher<T>,
      third?: Watcher<T>,
    ): () => void => {
      const [findOptions, onChange] = typeof second === "function"
        ? [{}, second]
        : [second ?? {}, third!];
      if (typeof onChange !== "function") throw invalid("watch takes what hears its rows");
      return watchRead(
        { op: { op: "find", collection: name, filter: filter ?? {}, options: findOptions } },
        (answer) =>
          "error" in answer
            ? onChange([], Object.assign(new Error(answer.error.message), answer.error))
            : onChange((answer.value ?? []) as WithId<T>[]),
      );
    };
    return {
      find: (filter = {}, findOptions = {}) =>
        cursor<T>(
          (final) => once({ op: { op: "find", collection: name, filter, options: final } }),
          findOptions,
        ),
      findOne: (filter = {}, findOptions = {}) =>
        once({ op: { op: "findOne", collection: name, filter, options: findOptions } }) as Promise<
          WithId<T> | null
        >,
      countDocuments: (filter = {}) =>
        once({ op: { op: "count", collection: name, filter } }) as Promise<number>,
      insertOne: (doc) =>
        write({ op: "insert", collection: name, docs: [doc as never] }) as Promise<
          { acknowledged: true; insertedId: string }
        >,
      updateOne: (filter, update, { upsert } = {}) =>
        write({
          op: "update",
          collection: name,
          filter,
          update: update as Update,
          options: upsert ? { upsert } : {},
        }) as Promise<UpdateResult>,
      replaceOne: (filter, doc, { upsert } = {}) =>
        write({
          op: "replace",
          collection: name,
          filter,
          doc: doc as never,
          options: upsert ? { upsert } : {},
        }) as Promise<UpdateResult>,
      deleteOne: (filter) =>
        write({ op: "delete", collection: name, filter, options: {} }) as Promise<DeleteResult>,
      query: <R>(query: string, params?: unknown) =>
        once({ collection: name, query, params: params ?? null }) as Promise<R>,
      watch: watch as ClientCollection<T>["watch"],
    };
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
        fetch: refuse("calling outside services") as never,
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

  /** New answers, by key: those watched here, when they differ, run again what read them. */
  const update = (answers: Known) => {
    const changed: string[] = [];
    for (const [key, answer] of answers) {
      if (!watching.has(key)) continue;
      if (canonical(known.get(key) ?? null) === canonical(answer)) continue;
      known.set(key, answer);
      changed.push(WATCHED + key);
    }
    if (changed.length) observers.changed(changed.map((c) => [c, [{}]]) as never);
  };

  return {
    observe: observers.observe,
    db: { collection: collectionOf },
    call: (action, input, { id } = {}) =>
      ask(CALL, { action, input: input ?? {}, ...(id !== undefined ? { id } : {}) }),
    emit: (type, data) => ask(EMIT, { type, data: data ?? {} }),
    idle: observers.idle,
    known: () =>
      [...watching.keys()].flatMap((key) => known.has(key) ? [[key, known.get(key)!]] : []),
    watching: () => [...watching].map(([key, read]) => ({ key, read })),
    refresh: async () => {
      const reads = [...watching].map(([key, read]) => ({ key, read }));
      if (!reads.length) return;
      const answers = await reading(reads);
      update(answers.map(({ key, ...answer }) => [key, answer as Answer]));
    },
    update,
    ready: worker ? worker.ready.then(() => {}) : Promise.resolve(),
    close: () => {
      closed = true;
      direct.clear();
      return worker ? worker.stop() : Promise.resolve();
    },
  };
}
