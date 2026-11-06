/**
 * Browsers, the owner's side (see design/views.md, "The web"): a browser is
 * an untrusted worker bound to its person. Every read, call and emit it makes
 * is that person's, under the rules, without secret fields.
 *
 * - **Admission:** the host's `admit` turns what a browser presents (a
 *   one-time ticket) into its person; the person rides on the connection.
 * - **What it asks** (calls of its own, outside any job): reads, which are
 *   watched from then on; Actions; declared events; reads it no longer needs.
 * - **What it's told:** a read's new result once a commit changes it, over
 *   one session stream per connection. A read is watched by observing a View
 *   that makes it, as the person: what the rules read to know their reach is
 *   followed too, so being let in shows at once.
 * - **How much:** a browser is its worker id: an actor has 16 at most, each
 *   on two connections at most (one coming while the last goes); each
 *   connection 512 reads watched (one more is refused, `too_many`, and
 *   those watched keep working; a read asked again is the same one); and 16
 *   resume credentials, each for a day (a new one drops their oldest). What's
 *   past its day is dropped as it passes (see expiring.ts).
 * - **Counted from admission:** a connection takes its place when it's let
 *   in (`take`, at Welcome) and keeps it until it goes (`gone`), Ready or
 *   not: connections let in together can't pass a limit by not being ready
 *   yet. One that isn't ready soon enough is closed (the owner's ready
 *   timeout).
 * - **Coming back:** a resume credential works once, for the browser (worker
 *   id) it was given to; each admission gives a new one.
 * - **Contacts** (outsiders, anyone with a browser on a web line) hold far
 *   less: 2 browsers each, 32 reads watched on each connection; and
 *   together, 16 connections from each network they came from (`actor.from`,
 *   its tags: as many times that as the network counts, `scaleOf`), 300 on
 *   each web line (`actor.web`), 400 in all: well under what a listener
 *   holds (`LISTENER`, Oxian's), so people always find room. Runtimes on one
 *   listener (the orgs host's orgs) count their contacts together too, with
 *   one `contactsPool()` given to each. People's connections never count
 *   against those. A contact reads a collection directly only with `find`,
 *   `findOne` or `count`, its filter and options (or a query's params) 2 KB
 *   of JSON at most, as the rules let it (`direct`: they refuse a read that
 *   doesn't name what of its own it reads, a chat), so what it watches runs
 *   again only when what it named changes. And it's told only the words of
 *   a failure meant for anyone (`public`), as a model outside the app is:
 *   never a provider's, a store's or the runtime's.
 * - **Ended** (signed out, erased: `end`): an actor's connections close, its
 *   resume credentials go, and a connection let in before is never ready.
 */
import type { JsonObject, WorkInput } from "@oxian/oxian-js";
import type { ViewContext } from "./define.ts";
import type { Observers, Output } from "./observe.ts";
import type { ReadOp } from "./ops.ts";
import type { Actor, Filter } from "./store.ts";
import { failure as refusal } from "./errors.ts";
import { expiring } from "./expiring.ts";
import { scaleOf } from "./caller.ts";
import { CONNECTION_BUDGET } from "@oxian/oxian-js/http";
import { decode, encode, type Failure, failure } from "./wire.ts";

/** A browser connection's provider id, set at admission. */
export const BROWSER = "core.browser";
/** What a browser asks: reads (watched), reads no longer needed, Actions, events. */
export const READ = "core.read";
export const UNWATCH = "core.unwatch";
export const CALL = "core.call";
export const EMIT = "core.emit";
/**
 * What a browser is told: one stream per connection, a line per commit's
 * new results (the reads one commit changed, together: the browser shows
 * them at once).
 */
export const SESSION = "core.session";
/** The View that makes one read, observed per watched read. */
export const READ_VIEW = "core.read";

/** A read a browser's View made: an op, or one of a collection's named queries. */
export type Remote = { op: ReadOp } | { collection: string; query: string; params?: unknown };

/** What a read came to: its value, or why it failed. */
export type Answer = { value: unknown } | { error: { message: string; code?: string } };

/** A read's new result, as the session stream tells it (a line holds those that came together). */
export type Push = { key: string } & Answer;

/** Makes the read it's given, as whoever observes it. */
export function readView(remote: Remote, ctx: ViewContext): unknown {
  if ("query" in remote) {
    return ctx.db.collection(remote.collection).query(remote.query, remote.params).value;
  }
  const { op } = remote;
  if (op.op === "edges" || op.op === "outcome") throw new Error(`A browser can't read ${op.op}`);
  const collection = ctx.db.collection(op.collection);
  switch (op.op) {
    case "find":
      return collection.find(op.filter, op.options).value;
    case "findOne":
      return collection.findOne(op.filter, op.options).value;
    case "count":
      return collection.countDocuments(op.filter).value;
    case "aggregate":
      return collection.aggregate(op.pipeline).value;
    case "nearest":
      return collection.nearest(op.vector, {
        ...op.options,
        ...(op.field ? { field: op.field } : {}),
      })
        .value;
  }
}

/**
 * A failure as a browser is told it: a person, all of it; a contact, its
 * words only when they're for anyone (`public`), else that it failed, and
 * its code.
 */
export function toldTo(actor: Actor | undefined, error: unknown): Failure {
  const said = failure(error);
  if (actor?.kind !== "contact" || said.public) return said;
  return { message: "Something went wrong.", ...(said.code ? { code: said.code } : {}) };
}

/**
 * One read, answered as an actor outside any connection (a widget's, through the app's MCP
 * line; a snapshot of what a View reads): a query they may run (its `allow`, under the rules,
 * without private fields), its failure as they may be told it. A direct read of a collection is
 * refused: from there, an actor reads through queries.
 */
export async function answeredAs(
  runtime: { query(name: string, params: unknown, options: { actor: Actor }): Promise<unknown> },
  actor: Actor,
  key: string,
  read: Remote,
): Promise<{ key: string } & Answer> {
  if (!("query" in read) || typeof read.collection !== "string" || typeof read.query !== "string") {
    return { key, error: { message: "Read through a query", code: "forbidden" } };
  }
  try {
    const value = await runtime.query(`${read.collection}.${read.query}`, read.params ?? null, {
      actor,
    });
    return { key, value: value ?? null };
  } catch (error) {
    return { key, error: toldTo(actor, error) };
  }
}

const answer = (output: Output, actor: Actor): Answer =>
  output.status === "failed" ? { error: toldTo(actor, output.error) } : {
    value: (output as { value: unknown }).value ?? null,
  };

/**
 * The most WebSockets one listener holds (Oxian's Node adapter's budget):
 * people, contacts, routes' sockets and, on the orgs host, every org's.
 */
export const LISTENER: number = CONNECTION_BUDGET;

/** The most bytes of JSON a contact's read says: its filter and options, or a query's params. */
export const CONTACT_READ = 2_048;

/**
 * Contacts' connections counted across runtimes that share a listener (the
 * orgs host's orgs), as many as `most` (400 unless said): `contactsPool()`,
 * given to each runtime (`browsers: { pool }`).
 */
export type ContactsPool = { readonly held: Set<object>; readonly most: number };

/** A pool of contacts' connections for runtimes on one listener (see `ContactsPool`). */
export const contactsPool = (most: number = Math.floor(LISTENER * 0.4)): ContactsPool => ({
  held: new Set(),
  most,
});

/** How much a browser may hold: see the module's header. */
export type BrowserLimits = {
  /** Each actor's browsers (worker ids). */
  sockets?: number;
  /** Reads watched on each connection. */
  watches?: number;
  resumes?: number;
  /** Each contact's browsers, and reads watched on each connection. */
  contact?: { sockets?: number; watches?: number };
  /**
   * Contacts' connections together: from one network (as many times as it
   * counts), one web line, all of this runtime's.
   */
  network?: number;
  line?: number;
  contacts?: number;
  /** Contacts' connections counted with other runtimes' on the same listener. */
  pool?: ContactsPool;
};

/** What's wrong with browser limits, if anything (checked as the runtime starts). */
export function limitsProblem(limits: BrowserLimits | undefined): string | undefined {
  if (!limits) return undefined;
  const counts: [string, unknown][] = [
    ["sockets", limits.sockets],
    ["watches", limits.watches],
    ["resumes", limits.resumes],
    ["contact.sockets", limits.contact?.sockets],
    ["contact.watches", limits.contact?.watches],
    ["network", limits.network],
    ["line", limits.line],
    ["contacts", limits.contacts],
  ];
  for (const [name, value] of counts) {
    if (value !== undefined && !(Number.isInteger(value) && (value as number) > 0)) {
      return `browsers.${name} is a whole number over 0`;
    }
  }
  const contacts = limits.contacts ?? Math.floor(LISTENER * 0.4);
  if (contacts >= LISTENER || (limits.line ?? 0) >= LISTENER) {
    return `browsers: contacts take fewer connections than a listener holds (${LISTENER}), ` +
      "so people always find room";
  }
  return undefined;
}

/** Who an actor is, for counting what they hold. */
const whoOf = (actor: Actor) => `${actor.kind}:${actor.id}`;

/**
 * The pools a contact's connections are counted in with others' (none for
 * anyone else): every contact's here, its web line's, each network's it came from.
 */
const poolsOf = (actor: Actor): string[] => {
  if (actor.kind !== "contact") return [];
  const from = Array.isArray(actor.from) ? actor.from.filter((t) => typeof t === "string") : [];
  return [
    "contacts",
    ...(typeof actor.web === "string" ? [`line:${actor.web}`] : []),
    ...from.map((tag) => `from:${tag}`),
  ];
};

/** A read's filter, where it names one (find, findOne, count). */
const filterOf = (remote: Remote): Filter | undefined =>
  "op" in remote && "filter" in remote.op ? remote.op.filter as Filter : undefined;

/** What a read says beyond its collection: its filter and options, or a query's params. */
const sizeOf = (remote: Remote): number =>
  JSON.stringify(
    "query" in remote
      ? remote.params ?? null
      : [(remote.op as { filter?: unknown }).filter, (remote.op as { options?: unknown }).options],
  )?.length ?? 0;

/** A connection let in, from Welcome until it goes: what's counted. */
type Place = {
  actor: Actor;
  workerId: string;
  /** The transport connection it holds. */
  via: string;
  /** How many ends there had been when it came in (`ends`): one after it ends it. */
  since: number;
};

type Connection = {
  actor: Actor;
  /** The transport connection it came on: only that one going closes it. */
  via: string;
  /** Reads watched, by the key the browser gave them. */
  watches: Map<string, { close(next?: Promise<Answer>): void }>;
  push(frame: Push): void;
  close(): void;
};

export function createBrowsers(env: {
  observers: Pick<Observers, "observe">;
  /**
   * Whether a rule speaks for an actor's reads of a collection: a browser
   * reads nothing else directly. Asked with the read's filter (`direct`, for
   * the rules): one that won't be watched as asked is refused (thrown).
   */
  ruled(actor: Actor, collection: string, filter?: Filter): Promise<boolean>;
  /** Whether a query lets an actor run it (its `allow`). */
  askable(actor: Actor, collection: string, query: string, params: unknown): boolean;
  call(action: string, input: unknown, actor: Actor): Promise<unknown>;
  emit(type: string, data: Record<string, unknown>, actor: Actor): Promise<void>;
  dispatch(input: WorkInput): Promise<unknown>;
  limits?: BrowserLimits;
}) {
  const limits = {
    sockets: 16,
    watches: 512,
    resumes: 16,
    network: 16,
    line: Math.floor(LISTENER * 0.3),
    contacts: Math.floor(LISTENER * 0.4),
    ...env.limits,
    contact: { sockets: 2, watches: 32, ...env.limits?.contact },
  };
  const { pool } = limits;
  /** Ready connections, by worker id: their session streams and reads. */
  const connections = new Map<string, Connection>();
  /** Every connection let in, ready or not, by its transport connection. */
  const places = new Map<string, Place>();
  /** Each actor's places, by worker id (a browser), each its connections. */
  const held = new Map<string, Map<string, Set<Place>>>();
  /** Contacts' places in each pool (`poolsOf`). */
  const pools = new Map<string, Set<Place>>();
  /** The most connections a pool holds. */
  const mostIn = (name: string) =>
    name === "contacts"
      ? limits.contacts
      : name.startsWith("line:")
      ? limits.line
      : limits.network * scaleOf(name.slice("from:".length));
  /** The most one actor holds: browsers, and reads watched on each connection. */
  const own = (actor: Actor) => actor.kind === "contact" ? limits.contact : limits;
  const DAY = 24 * 60 * 60 * 1000;
  /** What a browser shows to reconnect without a new ticket: once, for its worker id, for a day. */
  const resumes = expiring<string, { actor: Actor; workerId: string }>(DAY);
  /** Each actor's resume credentials, oldest first. */
  const lately = expiring<string, string[]>(DAY);
  /** How many times someone was ended; and when each was last (that count), for a day. */
  let ends = 0;
  const ended = expiring<string, number>(DAY);
  /** Whether an actor was ended after `since` (a count of ends). */
  const endedSince = (actor: Actor, since: number) => (ended.get(whoOf(actor)) ?? 0) > since;

  /** Why a browser can't come in on `workerId` now (a refusal to throw), if it can't. */
  const full = (actor: Actor, workerId: string, since: number) => {
    if (endedSince(actor, since)) return refusal("forbidden", "Signed out: sign in again");
    const theirs = held.get(whoOf(actor));
    const same = theirs?.get(workerId);
    const most = own(actor).sockets;
    // A tab already on two connections (one maybe half-open, after a network flap) isn't
    // refused: `take` closes its oldest, and Oxian replaces the older at Ready anyway.
    if (!same && (theirs?.size ?? 0) >= most) {
      return refusal(
        "too_many",
        `Connected ${most} times already, the most anyone may: close a tab first`,
        { public: true },
      );
    }
    const named = poolsOf(actor);
    const crowded = named.find((name) => (pools.get(name)?.size ?? 0) >= mostIn(name)) ??
      (named.length && pool && pool.held.size >= pool.most ? "contacts" : undefined);
    if (!crowded) return undefined;
    return refusal(
      "too_many",
      crowded.startsWith("from:")
        ? "Too many connections from here: close a tab, or try again later"
        : "This chat is busy right now: try again in a few minutes",
      { public: true },
    );
  };

  /** A connection let in takes its place: as its actor's (its browser's), and in its pools. */
  const take = (place: Place) => {
    const who = whoOf(place.actor);
    // A tab on two connections already gives up its oldest (never ready after this: refused there).
    const old = held.get(who)?.get(place.workerId);
    while (old && old.size >= 2) release(old.values().next().value!);
    places.set(place.via, place);
    if (!held.has(who)) held.set(who, new Map());
    const theirs = held.get(who)!;
    if (!theirs.has(place.workerId)) theirs.set(place.workerId, new Set());
    theirs.get(place.workerId)!.add(place);
    for (const name of poolsOf(place.actor)) {
      if (!pools.has(name)) pools.set(name, new Set());
      pools.get(name)!.add(place);
    }
    if (place.actor.kind === "contact") pool?.held.add(place);
  };

  /** A connection gone gives its place back. */
  const release = (place: Place) => {
    if (places.get(place.via) !== place) return;
    places.delete(place.via);
    const who = whoOf(place.actor);
    const theirs = held.get(who);
    const same = theirs?.get(place.workerId);
    same?.delete(place);
    if (same && !same.size) theirs!.delete(place.workerId);
    if (theirs && !theirs.size) held.delete(who);
    for (const name of poolsOf(place.actor)) {
      const there = pools.get(name);
      there?.delete(place);
      if (there && !there.size) pools.delete(name);
    }
    pool?.held.delete(place);
  };

  /** A ready browser: its session stream opens, and its reads may come. */
  const ready = (workerId: string, via: string) => {
    const place = places.get(via);
    // Ended since it came in (signed out, erased), or never let in here: it isn't anyone's.
    if (!place || place.workerId !== workerId || endedSince(place.actor, place.since)) {
      throw refusal("forbidden", "Signed out: sign in again");
    }
    const { actor } = place;
    connections.get(workerId)?.close();
    const encoder = new TextEncoder();
    let lines!: ReadableStreamDefaultController<Uint8Array>;
    let open = true;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => void (lines = controller),
      cancel: () => void (open = false),
    });
    // Results that come in the same turn (a commit's reads, told together) go in one line.
    let due: Push[] = [];
    const connection: Connection = {
      actor,
      via,
      watches: new Map(),
      push: (frame) => {
        due.push(frame);
        if (due.length > 1) return;
        queueMicrotask(() => {
          const line = due;
          due = [];
          if (open) lines.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        });
      },
      close: () => {
        for (const watch of connection.watches.values()) watch.close();
        connection.watches.clear();
        if (open) lines.close();
        open = false;
        if (connections.get(workerId) === connection) connections.delete(workerId);
      },
    };
    connections.set(workerId, connection);
    void env.dispatch({ workload: SESSION, target: { workerId }, body }).catch(() =>
      connection.close()
    );
  };

  /** A read, watched: its first result now, and each new one pushed. */
  const watch = (connection: Connection, key: string, remote: Remote): Promise<Answer> => {
    // Checked and taken at once, nothing awaited between: a batch can't overrun it.
    const most = own(connection.actor).watches;
    if (!connection.watches.has(key) && connection.watches.size >= most) {
      return Promise.resolve({
        error: {
          message: `This connection watches ${most} reads, the most it may: ` +
            "stop watching some first",
          code: "too_many",
        },
      });
    }
    const first = Promise.withResolvers<Answer>();
    // Asked again: the new watch replaces the old, whose first answer, if still due, is the new one's.
    connection.watches.get(key)?.close(first.promise);
    const observation = env.observers.observe(READ_VIEW, remote, { actor: connection.actor });
    let last: string | undefined;
    const off = observation.subscribe(() => {
      const output = observation.get();
      if (output.status === "loading") return;
      const now = answer(output, connection.actor);
      const text = JSON.stringify(now);
      if (last === undefined) first.resolve(now);
      else if (text !== last) connection.push({ key, ...now });
      last = text;
    });
    connection.watches.set(key, {
      close: (next) => {
        off();
        observation.close();
        first.resolve(next ?? { error: { message: "No longer watched", code: "cancelled" } });
      },
    });
    return first.promise;
  };

  /** What a browser asks, as its person; anything else isn't a browser's to ask. */
  const ask = async (workload: string, body: Record<string, unknown>, connection: Connection) => {
    switch (workload) {
      case READ: {
        const reads = body.reads as { key: string; read: Remote }[];
        const { actor } = connection;
        const refused = (key: string, message: string) => ({
          key,
          error: { message, code: "forbidden" },
        });
        // A key asked twice in one batch is one read.
        const once = [...new Map(reads.map((r) => [r.key, r])).values()];
        return await Promise.all(once.map(async ({ key, read }) => {
          // A contact's read is small: each one is matched against every change it might see.
          if (actor.kind === "contact" && sizeOf(read) > CONTACT_READ) {
            return refused(
              key,
              `A contact's read says ${CONTACT_READ} bytes at most: name what of its own it reads`,
            );
          }
          // A named query runs when it lets the person (its own reads keep to the rules);
          // read directly, a collection must be one the rules speak for.
          if ("query" in read) {
            if (!env.askable(actor, read.collection, read.query, read.params ?? null)) {
              return refused(
                key,
                `${actor.kind} ${actor.id} may not run "${read.collection}.${read.query}".`,
              );
            }
          } else if ("collection" in read.op) {
            // A contact's would run again on every change to the collection: theirs aren't these.
            if (actor.kind === "contact" && !["find", "findOne", "count"].includes(read.op.op)) {
              return refused(
                key,
                `A contact reads "${read.op.collection}" directly only with find, findOne or ` +
                  "count, naming what of its own it reads",
              );
            }
            let ruled: boolean;
            try {
              ruled = await env.ruled(actor, read.op.collection, filterOf(read));
            } catch (error) {
              return { key, error: { ...toldTo(actor, error), code: "forbidden" } };
            }
            if (!ruled) {
              return refused(
                key,
                `No rule lets a browser read "${read.op.collection}" directly: ` +
                  "read it through one of its queries",
              );
            }
          }
          return { key, ...await watch(connection, key, read) };
        }));
      }
      case UNWATCH:
        for (const key of body.keys as string[]) {
          connection.watches.get(key)?.close();
          connection.watches.delete(key);
        }
        return null;
      case CALL:
        return await env.call(String(body.action), body.input ?? {}, connection.actor);
      case EMIT:
        await env.emit(
          String(body.type),
          (body.data ?? {}) as Record<string, unknown>,
          connection.actor,
        );
        return null;
    }
  };

  return {
    /** How many browsers are connected (ready). */
    count: () => connections.size,
    /**
     * Ends every browser's session stream (closing the runtime doesn't wait
     * them out), gives back every place (a pool shared with other runtimes
     * keeps none of this one's), and forgets every resume credential.
     */
    close: () => {
      for (const connection of [...connections.values()]) connection.close();
      for (const place of [...places.values()]) release(place);
      resumes.close();
      lately.close();
      ended.close();
    },
    /**
     * How many times someone was ended so far: a browser coming in now is
     * let in after those (`since`), and an end after refuses it.
     */
    ends: () => ends,
    /** A connection's provider config at admission: who it is, and when it came in (`ends`). */
    config: (actor: Actor, since: number): JsonObject => ({
      actor: actor as unknown as JsonObject,
      since,
    }),
    /**
     * Refuses (thrown) a browser coming in as `actor` on `workerId` now: as
     * many browsers as they may (`too_many`), a pool it's in full; or ended since it began coming in
     * (`forbidden`). Only checks: `take` takes its place.
     */
    room: (actor: Actor, workerId: string, since: number) => {
      const refused = full(actor, workerId, since);
      if (refused) throw refused;
    },
    /**
     * Oxian's handshake hook, as a browser is let in (before Welcome): it
     * takes its place, or is refused as `room` says (thrown). It keeps it
     * until it goes (`gone`), ready or not.
     */
    take: (workerId: string, via: string, config: JsonObject) => {
      const actor = config.actor as unknown as Actor;
      const since = Number(config.since);
      const refused = full(actor, workerId, since);
      if (refused) throw refused;
      take({ actor, workerId, via, since });
    },
    /**
     * A resume credential for a browser just admitted on `workerId`: it works
     * once, on that worker id. A new one drops their oldest past 16.
     */
    resume: (actor: Actor, workerId: string) => {
      const secret = crypto.randomUUID() + crypto.randomUUID();
      resumes.set(secret, { actor, workerId });
      const who = whoOf(actor);
      const theirs = (lately.get(who) ?? []).filter((kept) => resumes.get(kept));
      theirs.push(secret);
      while (theirs.length > limits.resumes) resumes.delete(theirs.shift()!);
      lately.set(who, theirs);
      return {
        credential: { kind: "resume" as const, capability: secret },
        expiresAtMs: Date.now() + DAY,
      };
    },
    /**
     * Who a resume credential is, shown by `workerId`, once: it's used up
     * either way, and someone else's (another worker id) is no one.
     */
    resumed: (secret: string, workerId: string): Actor | undefined => {
      const kept = resumes.get(secret);
      resumes.delete(secret);
      return kept?.workerId === workerId ? kept.actor : undefined;
    },
    /**
     * Ends an actor's browsers (signed out, erased): their resume credentials
     * go; each ready connection, by worker id, is given to `drain`, which
     * ends it; one let in but not yet ready is refused when it says it is. A
     * browser comes back only with a new ticket, which only a cookie that's
     * still someone gets. How many connections it had.
     */
    end: (actor: Actor, drain: (workerId: string) => void): number => {
      const who = whoOf(actor);
      ended.set(who, ++ends);
      for (const secret of lately.get(who) ?? []) resumes.delete(secret);
      lately.delete(who);
      const theirs = [...held.get(who)?.values() ?? []].flatMap((same) => [...same]);
      for (const workerId of new Set(theirs.map((place) => place.workerId))) {
        const connection = connections.get(workerId);
        if (!connection) continue;
        connection.close();
        drain(workerId);
      }
      return theirs.length;
    },
    /**
     * Oxian's ready hook, for a browser's connection (`via`, the transport
     * connection it came on): refused (thrown) when it wasn't let in here, or
     * its actor was ended since.
     */
    ready: (workerId: string, via: string) => ready(workerId, via),
    /**
     * Oxian's disconnect hook: its place is given back, and its reads stop
     * being watched. Only the connection that went: a browser back on a new
     * one before the old one is noticed gone keeps its new stream.
     */
    gone: (workerId: string, via: string) => {
      const place = places.get(via);
      if (place) release(place);
      const connection = connections.get(workerId);
      if (connection?.via === via) connection.close();
    },
    /** Oxian's admission for a worker's calls outside any job: a browser's, as its person. */
    admit: (
      context: { workload: string; definition: { providerId: string; workerId: string } },
    ) => {
      if (context.definition.providerId !== BROWSER) return undefined;
      if (![READ, UNWATCH, CALL, EMIT].includes(context.workload)) return undefined;
      return async ({ input }: { input: ReadableStream<Uint8Array> }) => {
        const connection = connections.get(context.definition.workerId);
        try {
          if (!connection) throw new Error("This connection isn't ready");
          return encode({ value: await ask(context.workload, await decode(input), connection) });
        } catch (error) {
          return encode({ error: toldTo(connection?.actor, error) });
        }
      };
    },
  };
}
