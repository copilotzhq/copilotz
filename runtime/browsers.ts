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
 */
import type { JsonObject, WorkInput } from "@oxian/oxian-js";
import type { ViewContext } from "./define.ts";
import type { Observers, Output } from "./observe.ts";
import type { ReadOp } from "./ops.ts";
import type { Actor } from "./store.ts";
import { decode, encode, failure } from "./wire.ts";

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

const answer = (output: Output): Answer =>
  output.status === "failed" ? { error: failure(output.error) } : {
    value: (output as { value: unknown }).value ?? null,
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
  /** Whether a rule speaks for an actor's reads of a collection: a browser reads nothing else directly. */
  ruled(actor: Actor, collection: string): Promise<boolean>;
  /** Whether a query lets an actor run it (its `allow`). */
  askable(actor: Actor, collection: string, query: string, params: unknown): boolean;
  call(action: string, input: unknown, actor: Actor): Promise<unknown>;
  emit(type: string, data: Record<string, unknown>, actor: Actor): Promise<void>;
  dispatch(input: WorkInput): Promise<unknown>;
}) {
  const connections = new Map<string, Connection>();
  /** What a browser shows to reconnect without a new ticket: a secret of its own, for a day. */
  const resumes = new Map<string, { actor: Actor; until: number }>();
  const DAY = 24 * 60 * 60 * 1000;

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
    const first = Promise.withResolvers<Answer>();
    // Asked again: the new watch replaces the old, whose first answer, if still due, is the new one's.
    connection.watches.get(key)?.close(first.promise);
    const observation = env.observers.observe(WIRE, READ_VIEW, remote, { actor: connection.actor });
    let last: string | undefined;
    const off = observation.subscribe(() => {
      const output = observation.get();
      if (output.status === "loading") return;
      const now = answer(output);
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
          } else if ("collection" in read.op && !await env.ruled(actor, read.op.collection)) {
            return refused(
              key,
              `No rule lets a browser read "${read.op.collection}" directly: ` +
                "read it through one of its queries",
            );
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
    /** A connection's provider config at admission: who it is. */
    config: (actor: Actor): JsonObject => ({ actor: actor as unknown as JsonObject }),
    /** A resume credential for a browser just admitted. */
    resume: (actor: Actor) => {
      const now = Date.now();
      for (const [secret, kept] of resumes) if (kept.until < now) resumes.delete(secret);
      const secret = crypto.randomUUID() + crypto.randomUUID();
      resumes.set(secret, { actor, until: now + DAY });
      return {
        credential: { kind: "resume" as const, capability: secret },
        expiresAtMs: now + DAY,
      };
    },
    /** Who a resume credential is, while it lasts. */
    resumed: (secret: string): Actor | undefined => {
      const kept = resumes.get(secret);
      return kept && kept.until > Date.now() ? kept.actor : undefined;
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
          return encode({ error: failure(error) });
        }
      };
    },
  };
}
