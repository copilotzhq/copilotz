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
 * - **How much:** an actor has 16 connections at most (one more is refused
 *   at admission), each 512 reads watched (one more is refused, `too_many`,
 *   and those watched keep working; a read asked again is the same one), and
 *   16 resume credentials, each for a day (a new one drops their oldest).
 *   What's past its day is dropped as it passes (see expiring.ts).
 * - **Contacts** (outsiders, anyone with a browser on a web line) hold far
 *   less: 2 connections each, 32 reads watched on each; and together, 16
 *   connections from each network they came from (`actor.from`, its tags:
 *   as many times that as the network counts, `scaleOf`), 1,000 on each web
 *   line (`actor.web`), 2,000 in all. People's connections never count
 *   against those. A contact reads a collection directly only with `find`,
 *   `findOne` or `count`, as the rules let it (`direct`: they refuse a read
 *   that doesn't name what of its own it reads, a chat), so what it watches
 *   runs again only when what it named changes. And it's told only the
 *   words of a failure meant for anyone (`public`), as a model outside the
 *   app is: never a provider's, a store's or the runtime's.
 */
import type { JsonObject, WorkInput } from "@oxian/oxian-js";
import type { ViewContext } from "./define.ts";
import type { Observers, Output } from "./observe.ts";
import type { ReadOp } from "./ops.ts";
import type { Actor, Filter } from "./store.ts";
import { failure as refusal } from "./errors.ts";
import { expiring } from "./expiring.ts";
import { scaleOf } from "./caller.ts";
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
export const WIRE = "wire";

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

const answer = (output: Output, actor: Actor): Answer =>
  output.status === "failed" ? { error: toldTo(actor, output.error) } : {
    value: (output as { value: unknown }).value ?? null,
  };

/** How much a browser may hold: see the module's header. */
export type BrowserLimits = {
  sockets?: number;
  watches?: number;
  resumes?: number;
  /** Each contact's connections, and reads watched on each. */
  contact?: { sockets?: number; watches?: number };
  /** Contacts' connections together: from one network (as many times as it counts), one line, all. */
  network?: number;
  line?: number;
  contacts?: number;
};

/** Who an actor is, for counting what they hold. */
const whoOf = (actor: Actor) => `${actor.kind}:${actor.id}`;

/**
 * The pools a contact's connections are counted in with others' (none for
 * anyone else): every contact's, its web line's, each network's it came from.
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
    line: 1_000,
    contacts: 2_000,
    ...env.limits,
    contact: { sockets: 2, watches: 32, ...env.limits?.contact },
  };
  const connections = new Map<string, Connection>();
  /** Each actor's connections, by worker id. */
  const held = new Map<string, Set<string>>();
  /** Contacts' connections in each pool (`poolsOf`), by worker id. */
  const pools = new Map<string, Set<string>>();
  /** The most connections a pool holds. */
  const mostIn = (pool: string) =>
    pool === "contacts"
      ? limits.contacts
      : pool.startsWith("line:")
      ? limits.line
      : limits.network * scaleOf(pool.slice("from:".length));
  /** Where an actor's connections are counted: as theirs, and in each pool they're in. */
  const places = (actor: Actor): [Map<string, Set<string>>, string][] => [
    [held, whoOf(actor)],
    ...poolsOf(actor).map((pool): [Map<string, Set<string>>, string] => [pools, pool]),
  ];
  /** The most one actor holds: connections, and reads watched on each. */
  const own = (actor: Actor) => actor.kind === "contact" ? limits.contact : limits;
  const DAY = 24 * 60 * 60 * 1000;
  /** What a browser shows to reconnect without a new ticket: a secret of its own, for a day. */
  const resumes = expiring<string, Actor>(DAY);
  /** Each actor's resume credentials, oldest first. */
  const lately = expiring<string, string[]>(DAY);

  /** A ready browser: its session stream opens, and its reads may come. */
  const ready = (workerId: string, actor: Actor, via: string) => {
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
        if (connections.get(workerId) !== connection) return;
        connections.delete(workerId);
        for (const [map, key] of places(actor)) {
          const theirs = map.get(key);
          theirs?.delete(workerId);
          if (!theirs?.size) map.delete(key);
        }
      },
    };
    connections.set(workerId, connection);
    for (const [map, key] of places(actor)) {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(workerId);
    }
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
    const observation = env.observers.observe(WIRE, READ_VIEW, remote, { actor: connection.actor });
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
    /** How many browsers are connected. */
    count: () => connections.size,
    /**
     * Ends every browser's session stream (closing the runtime doesn't wait
     * them out), and forgets every resume credential.
     */
    close: () => {
      for (const connection of [...connections.values()]) connection.close();
      resumes.close();
      lately.close();
    },
    /** A connection's provider config at admission: who it is. */
    config: (actor: Actor): JsonObject => ({ actor: actor as unknown as JsonObject }),
    /**
     * Refuses (`too_many`, thrown) a browser coming in as `actor` on
     * `workerId` when they hold as many connections as they may, this one
     * aside (a browser back on a new connection is the same one).
     */
    room: (actor: Actor, workerId: string) => {
      const others = (of?: Set<string>) => (of?.size ?? 0) - (of?.has(workerId) ? 1 : 0);
      const most = own(actor).sockets;
      if (others(held.get(whoOf(actor))) >= most) {
        throw refusal(
          "too_many",
          `Connected ${most} times already, the most anyone may: close a tab first`,
          { public: true },
        );
      }
      const full = poolsOf(actor).find((pool) => others(pools.get(pool)) >= mostIn(pool));
      if (!full) return;
      throw refusal(
        "too_many",
        full.startsWith("from:")
          ? "Too many connections from here: close a tab, or try again later"
          : "This chat is busy right now: try again in a few minutes",
        { public: true },
      );
    },
    /** A resume credential for a browser just admitted: a new one drops their oldest past 16. */
    resume: (actor: Actor) => {
      const secret = crypto.randomUUID() + crypto.randomUUID();
      resumes.set(secret, actor);
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
    /** Who a resume credential is, while it lasts. */
    resumed: (secret: string): Actor | undefined => resumes.get(secret),
    /**
     * Ends an actor's browsers (signed out, erased): their resume credentials
     * go, and each of their connections, by worker id, is given to `drain`,
     * which ends it: a browser comes back only with a new ticket, which only
     * a cookie that's still someone gets. How many connections it had.
     */
    end: (actor: Actor, drain: (workerId: string) => void): number => {
      const who = whoOf(actor);
      for (const secret of lately.get(who) ?? []) resumes.delete(secret);
      lately.delete(who);
      const theirs = [...held.get(who) ?? []];
      for (const workerId of theirs) {
        connections.get(workerId)?.close();
        drain(workerId);
      }
      return theirs.length;
    },
    /** Oxian's ready hook, for a browser's connection (`via`, the transport connection it came on). */
    ready: (workerId: string, config: JsonObject, via: string) =>
      ready(workerId, config.actor as unknown as Actor, via),
    /**
     * Oxian's disconnect hook: its reads stop being watched. Only the
     * connection that went: a browser back on a new one before the old one
     * is noticed gone keeps its new stream.
     */
    gone: (workerId: string, via: string) => {
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
