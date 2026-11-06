/**
 * The REST API: the runtime's own paths under `/api/`, which `runtime.fetch`
 * answers for whoever plugins' `who` say a request is (a key's person, with
 * its scope; a session from the app's own page; anonymous, where `allow`s
 * and the rules let it). Everything is checked as it is over the socket:
 * each Action's and query's `allow`, the caller's scope, and the rules.
 *
 * - `GET /api/collections/<name>?filter=<json>&sort=<json>&limit=&skip=`:
 *   `find`; `&count=true`, how many match; `GET …/<id>`: one, by id (404
 *   when it isn't there, or not where the caller reaches).
 * - `POST /api/collections/<name>`: inserts the body (201, with where it is).
 * - `PATCH …/<id>`: updates it: the body is an update document, or plain
 *   fields to set (`$set`). `PUT …/<id>`: replaces it. `DELETE …/<id>`:
 *   deletes it. On the collection with `?filter=<json>` instead of an id:
 *   the first that matches (`updateOne`, `replaceOne`, `deleteOne`), and
 *   `?upsert=true` inserts one when none does. Each answers as MongoDB does.
 * - `POST /api/actions/<name>`: calls an Action, the body its input; an
 *   `Idempotency-Key` is the call's id, the caller's own (sent again, it
 *   answers what the first did, without doing it twice).
 * - `GET /api/queries/<collection>.<query>?params=<json>`, or `POST` with
 *   the params as the body: runs a named query.
 * - `GET /api/views/<name>?item=<json>`: what a View shows, rendered here.
 * - `POST /api/events/<type>`: emits a declared event (204). An actor with a
 *   scope (a key) emits nothing.
 * - `GET /api/events`: what happens, as it commits, of what the caller may
 *   see (see `follow`).
 * - **A watch:** any GET above asking for `Accept: text/event-stream` gets
 *   its result, then each new result after a commit that changes it, as
 *   server-sent events (`data:` each result, `event: failed` a failure).
 * - `GET /api/`: the reference: what this caller may use.
 *
 * **Writes from outside** (see `admitted` and `writeOutside`, owner.ts): a
 * collection reaches an outsider only where a rule speaks for it (for
 * writes, a rule asked about writes), never `sys.*`; private fields are
 * never returned, never filtered by, never written; the owner's guard keeps
 * every write within their reach; the schema checks it; and every write
 * records its events, as theirs.
 *
 * Errors are JSON, `{ error: { code, message } }`, with the status their
 * code says; a contact or anonymous caller is told only the words of a
 * failure meant for anyone (`public`). Streams send a comment every 20 s
 * (the runtime's clock), asking `who` again: one whose credential no longer
 * proves who it followed (signed out, the key revoked) says so (`revoked`)
 * and ends; ending an actor (`disconnect`) ends theirs at once. Any origin
 * may call it from a browser with a key (a key is a header, never sent by
 * itself); with a session's cookie, only the app's own page can.
 */
import { callIdOf, holderOf, type Scope } from "./actor.ts";
import { bodyOf } from "./body.ts";
import { READ_VIEW, type Remote } from "./browsers.ts";
import type { Registry } from "./registry.ts";
import { matches } from "./mongo.ts";
import type { Observation, Output } from "./observe.ts";
import type { ReadOp, WriteOp } from "./ops.ts";
import type { Owner } from "./owner.ts";
import type { Clock } from "./schedules.ts";
import type { Actor, Event, Filter, FindOptions } from "./store.ts";
import { failure as said } from "./wire.ts";

/** How often a stream says it's alive, and asks who it follows again (ms). */
export const PING_MS = 20_000;

/** The largest body taken (files go in as base64): 16 MB. */
export const MAX_BODY = 16 * 1024 * 1024;

/** The status each error code answers with. */
const STATUS: Record<string, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_here: 403,
  needs_share: 403,
  not_found: 404,
  method: 405,
  duplicate_key: 409,
  id_conflict: 409,
  too_large: 413,
  transcription_failed: 422,
  too_many: 429,
  cancelled: 499,
  unavailable: 501,
  offline: 503,
};

/** Who may call from a browser, and with what. */
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, accept, idempotency-key, last-event-id",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value ?? null), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS,
      ...headers,
    },
  });

/** An error as the API says it. */
const failed = (status: number, code: string, message: string, headers = {}) =>
  json({ error: { code, message } }, status, headers);

/** A refusal, by its code. */
const fault = (code: string, message: string) =>
  Object.assign(new Error(message), { code, public: true });

const enc = encodeURIComponent;

/** What the runtime gives the API: the owner's own ways in for outsiders (see owner.ts). */
export type ApiEnv = {
  registry: Registry;
  owner(): Owner;
  clock: Clock;
  /** Throws why an outsider may not make an op on a collection directly (`admitted`). */
  admitted(actor: Actor, op: ReadOp | WriteOp): Promise<void>;
  /** An outsider's own read, admitted, under the rules, without private fields. */
  read(actor: Actor, op: ReadOp): Promise<unknown>;
  /** An outsider's own write, admitted, as theirs (see `writeOutside`). */
  write(actor: Actor, op: WriteOp): Promise<unknown>;
  /** Whether a query lets an actor run it (its `allow`, and the actor's scope). */
  askable(actor: Actor, collection: string, query: string, params: unknown): boolean;
  ruled(
    actor: Actor,
    collection: string,
    filter: Filter | undefined,
    access: "read" | "write",
  ): Promise<boolean>;
  /** The filter an actor's reads of a collection keep to; none: unrestricted. */
  rule(actor: Actor, collection: string): Promise<Filter | undefined>;
  /** One read, watched as an actor (checked before): what a browser's watched read is. */
  watch(remote: Remote, actor: Actor): Observation<unknown>;
};

export type Api = {
  /**
   * Answers a request under `/api/`, as `actor`; `again` asks who the
   * request is now, unkept (a stream asks it at each ping).
   */
  answer(request: Request, actor: Actor, again: () => Promise<Actor>): Promise<Response>;
  /** Ends an actor's streams, at once: they were signed out, their key revoked. */
  end(actor: Actor): void;
  /** Ends every stream (the runtime closes). */
  close(): void;
};

/** Whether a request asks to watch: `Accept: text/event-stream`. */
const watching = (request: Request) =>
  request.method === "GET" && /\btext\/event-stream\b/i.test(request.headers.get("accept") ?? "");

/** A search parameter's JSON, or `fallback` when it isn't there. */
function param<T>(url: URL, name: string, fallback: T): T {
  const given = url.searchParams.get(name);
  if (given === null) return fallback;
  try {
    return JSON.parse(given) as T;
  } catch {
    throw fault("invalid", `\`${name}\` is JSON.`);
  }
}

/** A search parameter that's a whole number of at least 0, if it's there. */
function whole(url: URL, name: string): number | undefined {
  const given = url.searchParams.get(name);
  if (given === null) return undefined;
  const n = Number(given);
  if (!Number.isInteger(n) || n < 0) throw fault("invalid", `\`${name}\` is a whole number.`);
  return n;
}

/** A plain object (a filter, a document), or a refusal saying what `what` is. */
function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fault("invalid", `${what} is a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/** A request's JSON body, 16 MB at most; none is `{}`. */
async function bodyJson(request: Request): Promise<unknown> {
  const bytes = await bodyOf(request, MAX_BODY);
  if (!bytes) throw fault("too_large", "The body is too large (16 MB at most).");
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw fault("invalid", "The body isn't JSON.");
  }
}

const allowOnly = (methods: string, what: string) =>
  Object.assign(fault("method", `${what}: ${methods}.`), { allow: methods });

/** How a View sees the caller, as the web host's page says it. */
const viewerOf = (actor: Actor) => ({
  kind: actor.kind,
  name: actor.kind === "person" ? actor.id : `${actor.kind}:${actor.id}`,
});

const CHANGE = /^(.+)\.(created|updated|deleted)$/;

const REVOKED = `event: revoked\ndata: ${
  JSON.stringify({
    error: { code: "unauthorized", message: "No longer signed in, or the key was revoked." },
  })
}\n\n`;

/** One server-sent event: its data as JSON, with its name and id when it has them. */
const frame = (data: unknown, event?: string, id?: number) =>
  `${id !== undefined ? `id: ${id}\n` : ""}${event ? `event: ${event}\n` : ""}data: ${
    JSON.stringify(data ?? null)
  }\n\n`;

export function createApi(env: ApiEnv): Api {
  const { registry, clock } = env;
  /** Each open stream's end, by whose it is (`holderOf`). */
  const open = new Map<string, Set<() => void>>();

  /**
   * A server-sent stream for `actor`: `start` says what it's given to say
   * with, and answers how to stop. It says it's alive every ping, asking
   * `again` who the request is: someone else now, it ends, saying so.
   */
  const stream = (
    actor: Actor,
    again: () => Promise<Actor>,
    start: (say: (text: string) => void) => () => void,
    first = "",
  ): Response => {
    const encoder = new TextEncoder();
    let stop = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let live = true;
        const say = (text: string) => {
          if (!live) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // The caller went away.
          }
        };
        const finish = () => {
          if (!live) return;
          say(REVOKED);
          stop();
          try {
            controller.close();
          } catch {
            // Already closed by the caller going away.
          }
        };
        const holder = holderOf(actor);
        if (!open.has(holder)) open.set(holder, new Set());
        open.get(holder)!.add(finish);
        let unping = () => {};
        const ping = () => {
          unping = clock.wake(clock.now() + PING_MS, async () => {
            // A failure to ask (a moment's) keeps it: the next ping asks again.
            const now = await again().catch(() => actor);
            if (!live) return;
            if (holderOf(now) !== holder) return finish();
            say(": ping\n\n");
            ping();
          });
        };
        say(`retry: 3000\n${first}\n`);
        const unwatch = start(say);
        ping();
        stop = () => {
          live = false;
          unping();
          unwatch();
          open.get(holder)?.delete(finish);
          if (!open.get(holder)?.size) open.delete(holder);
        };
      },
      cancel: () => stop(),
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        ...CORS,
      },
    });
  };

  /** An observation, watched: its result, then each new one; a failure as `failed`. */
  const watched = (
    observation: Observation<unknown>,
    actor: Actor,
    again: () => Promise<Actor>,
  ): Response =>
    stream(actor, again, (say) => {
      let last: string | undefined;
      const show = () => {
        const now: Output<unknown> = observation.get();
        if (now.status === "loading") return;
        const text = now.status === "ready"
          ? frame(now.value)
          : frame({ error: toldTo(actor, now.error) }, "failed");
        if (text === last) return;
        last = text;
        say(text);
      };
      const off = observation.subscribe(show);
      show();
      return () => {
        off();
        observation.close();
      };
    });

  /**
   * `GET /api/events`: the app's events as they commit, as server-sent
   * events, of what the caller may see. It follows the rules, never the
   * scope: a key's scope says what it may ask for, not what it's told of.
   *
   * - **Changes** (`<collection>.created`, `.updated`, `.deleted`) to
   *   documents of collections a rule speaks for the caller's reads of, that
   *   the caller reaches: each with the document as the event has it (never
   *   its private fields), and what changed; a deleted one, only its `_id`.
   * - **Its own calls' outcomes:** `action.completed` and `action.failed` of
   *   the calls it made (by call id), for a long call, to follow.
   *
   * Each event has its log position as its `id`.
   */
  const follow = (actor: Actor, again: () => Promise<Actor>): Response => {
    // Read as the rules let it, whatever its scope lists.
    const { scope: _, ...reader } = actor;
    const holder = holderOf(actor);
    /** Whether a rule speaks for the reader's reads of each collection: it doesn't change. */
    const speaks = new Map<string, Promise<boolean>>();
    const spoken = (collection: string) => {
      if (!speaks.has(collection)) {
        speaks.set(
          collection,
          env.ruled(reader, collection, undefined, "read").catch(() => false),
        );
      }
      return speaks.get(collection)!;
    };
    return stream(actor, again, (say) => {
      let live = true;
      let queued: { event: Event; full(): Promise<Event> }[] = [];
      let chain = Promise.resolve();
      /** Its own calls started since it began following, until they end. */
      const calls = new Set<string>();
      const flush = async (batch: typeof queued) => {
        // The rule each collection's reads keep to now: once a batch (who's where may change).
        const rules = new Map<string, Promise<Filter | undefined>>();
        const ruleOf = (collection: string) => {
          if (!rules.has(collection)) rules.set(collection, env.rule(reader, collection));
          return rules.get(collection)!;
        };
        for (const { event, full } of batch) {
          if (!live) return;
          const change = CHANGE.exec(event.type);
          const def = change ? registry.collections[change[1]] : undefined;
          if (change && def && !change[1].startsWith("sys.")) {
            const [, collection, how] = change;
            if (!await spoken(collection)) continue;
            const { _id, doc, changed } = (await full().catch(() => event)).data as {
              _id: string;
              doc?: Record<string, unknown>;
              changed?: string[];
            };
            const rule = await ruleOf(collection).catch(() => ({ _id: { $in: [] } }));
            if (!doc || (rule && !matches(doc, rule))) continue;
            say(frame(
              {
                seq: event.seq,
                type: event.type,
                at: event.at,
                collection,
                _id,
                ...(how === "deleted" ? {} : { doc, ...(changed ? { changed } : {}) }),
              },
              event.type,
              event.seq,
            ));
            continue;
          }
          // Its own calls (not those they made in turn): started with no cause.
          if (
            event.type === "action.started" && !event.cause && event.actor &&
            holderOf(event.actor) === holder
          ) calls.add(event.id);
          if (
            (event.type === "action.completed" || event.type === "action.failed") &&
            event.cause && calls.delete(event.cause)
          ) {
            // Whole: a result over 16 KiB is a blob reference in the log.
            const data = (await full().catch(() => event)).data as Record<string, unknown>;
            say(frame(
              {
                seq: event.seq,
                type: event.type,
                at: event.at,
                call: event.cause,
                action: data.action,
                ...(event.type === "action.completed"
                  ? { result: data.result }
                  : { error: data.error }),
              },
              event.type,
              event.seq,
            ));
          }
        }
      };
      const unsubscribe = env.owner().subscribe((item) => {
        if (item.kind !== "event") return;
        queued.push(item);
        // What one commit published goes as one batch.
        if (queued.length === 1) {
          setTimeout(() => {
            const batch = queued;
            queued = [];
            chain = chain.then(() => live ? flush(batch) : undefined).catch(() => {});
          }, 0);
        }
      });
      return () => {
        live = false;
        unsubscribe();
      };
    }, `: following what ${actor.kind} ${actor.id} may see\n`);
  };

  /** `GET /api/`: what this caller may use; with a scope, only what it lists. */
  const reference = async (actor: Actor) => {
    if (actor.kind === "anonymous") {
      throw Object.assign(
        fault("unauthorized", "Sign in, or call with a key: `Authorization: Bearer <key>`."),
        { headers: { "www-authenticate": 'Bearer realm="api"' } },
      );
    }
    const scope = actor.scope as Scope | undefined;
    const action = (name: string) => {
      const def = registry.actions[name];
      return {
        name,
        ...(def.description ? { description: def.description } : {}),
        ...(def.input ? { input: def.input } : {}),
        method: "POST" as const,
        path: `/api/actions/${enc(name)}`,
      };
    };
    const query = (name: string) => ({
      name,
      method: "POST" as const,
      path: `/api/queries/${enc(name)}`,
    });
    const view = (name: string) => ({
      name,
      method: "GET" as const,
      path: `/api/views/${enc(name)}`,
    });
    const collection = (name: string, read: boolean, write: boolean) => ({
      name,
      read,
      write,
      path: `/api/collections/${enc(name)}`,
    });
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    const who = {
      kind: actor.kind,
      id: actor.id,
      ...(typeof actor.key === "string" ? { key: actor.key } : {}),
    };
    const events = { method: "GET" as const, path: "/api/events" };
    if (scope !== undefined && scope !== null) {
      const read = new Set(scope.read ?? []);
      const write = new Set(scope.write ?? []);
      return {
        actor: who,
        actions: (scope.call ?? []).filter((name) => registry.actions[name]).map(action),
        queries: (scope.query ?? []).map(query),
        views: (scope.view ?? []).map(view),
        collections: [...new Set([...read, ...write])].map((name) =>
          collection(name, read.has(name), write.has(name))
        ),
        events,
      };
    }
    // Unscoped: everything that lets someone in from outside (an `allow`), and the collections
    // a rule speaks for, for them.
    const collections = await Promise.all(
      Object.keys(registry.collections).filter((name) => !name.startsWith("sys.")).map(
        async (name) => {
          const [read, write] = await Promise.all([
            env.ruled(actor, name, undefined, "read").catch(() => false),
            env.ruled(actor, name, undefined, "write").catch(() => false),
          ]);
          return read || write ? [collection(name, read, write)] : [];
        },
      ),
    );
    return {
      actor: who,
      actions: Object.entries(registry.actions).flatMap(([name, def]) =>
        def.allow ? [action(name)] : []
      ).sort(byName),
      queries: Object.entries(registry.collections).flatMap(([name, def]) =>
        Object.entries(def.queries ?? {}).flatMap(([q, query]) =>
          typeof query === "object" ? [`${name}.${q}`] : []
        )
      ).sort().map(query),
      views: Object.keys(registry.views).filter((name) => name !== READ_VIEW).sort().map(view),
      collections: collections.flat().sort(byName),
      events,
    };
  };

  /** `/api/collections/<name>` and `…/<id>`: reads, watches and writes, as the caller's own. */
  const collections = async (
    request: Request,
    url: URL,
    actor: Actor,
    again: () => Promise<Actor>,
    name: string | undefined,
    id: string | undefined,
  ): Promise<Response> => {
    if (!name) throw fault("not_found", "Name a collection: /api/collections/<name>.");
    const one = id !== undefined;
    const filter: Filter = one ? { _id: id } : object(param(url, "filter", {}), "`filter`");
    const upsert = url.searchParams.get("upsert") === "true";
    const at = (result: unknown, count: "matchedCount" | "deletedCount") => {
      if (one && !(result as Record<string, number>)[count]) {
        throw fault("not_found", `No "${name}" ${id} where you reach.`);
      }
      return json(result);
    };
    switch (request.method) {
      case "GET": {
        const options: FindOptions = {
          ...(url.searchParams.has("sort")
            ? { sort: object(param(url, "sort", {}), "`sort`") as FindOptions["sort"] }
            : {}),
          ...(whole(url, "limit") !== undefined ? { limit: whole(url, "limit") } : {}),
          ...(whole(url, "skip") !== undefined ? { skip: whole(url, "skip") } : {}),
        };
        const op: ReadOp = one
          ? { op: "findOne", collection: name, filter, options: {} }
          : url.searchParams.get("count") === "true"
          ? { op: "count", collection: name, filter }
          : { op: "find", collection: name, filter, options };
        if (watching(request)) {
          await env.admitted(actor, op);
          return watched(env.watch({ op }, actor), actor, again);
        }
        const value = await env.read(actor, op);
        if (one && value === null) throw fault("not_found", `No "${name}" ${id} where you reach.`);
        return json(value);
      }
      case "POST": {
        if (one) throw allowOnly("GET, PATCH, PUT, DELETE", "A document");
        const doc = object(await bodyJson(request), "A document");
        const done = await env.write(actor, {
          op: "insert",
          collection: name,
          docs: [doc as never],
        });
        const made = (done as { insertedId: string }).insertedId;
        return json(done, 201, { location: `/api/collections/${enc(name)}/${enc(made)}` });
      }
      case "PATCH": {
        const update = object(await bodyJson(request), "An update");
        return at(
          await env.write(actor, {
            op: "update",
            collection: name,
            filter,
            update: update as never,
            options: { ...(upsert ? { upsert } : {}) },
          }),
          "matchedCount",
        );
      }
      case "PUT": {
        const { _id, ...doc } = object(await bodyJson(request), "A document");
        if (_id !== undefined && (!one || _id !== id)) {
          throw fault("invalid", "A replacement keeps its _id: the one in the path.");
        }
        return at(
          await env.write(actor, {
            op: "replace",
            collection: name,
            filter,
            doc,
            options: { ...(upsert ? { upsert } : {}) },
          }),
          "matchedCount",
        );
      }
      case "DELETE":
        return at(
          await env.write(actor, { op: "delete", collection: name, filter, options: {} }),
          "deletedCount",
        );
      default:
        throw one
          ? allowOnly("GET, PATCH, PUT, DELETE", "A document")
          : allowOnly("GET, POST, PATCH, PUT, DELETE", "A collection");
    }
  };

  /** `/api/queries/<collection>.<query>`: run, or watched. */
  const queries = async (
    request: Request,
    url: URL,
    actor: Actor,
    again: () => Promise<Actor>,
    name: string,
  ): Promise<Response> => {
    const dot = name.lastIndexOf(".");
    const [collection, query] = [name.slice(0, dot), name.slice(dot + 1)];
    if (dot < 1 || !registry.collections[collection]?.queries?.[query]) {
      throw fault("not_found", `No query "${name}".`);
    }
    let params: unknown;
    if (request.method === "GET") params = param(url, "params", {});
    else if (request.method === "POST") params = await bodyJson(request);
    else throw allowOnly("GET, POST", "A query");
    if (watching(request)) {
      if (!env.askable(actor, collection, query, params)) {
        throw fault("forbidden", `${actor.kind} ${actor.id} may not run "${name}".`);
      }
      return watched(env.watch({ collection, query, params }, actor), actor, again);
    }
    return json(await env.owner().query(name, params, { actor }));
  };

  /** `/api/views/<name>?item=<json>`: what it shows, once or watched. */
  const views = async (
    request: Request,
    url: URL,
    actor: Actor,
    again: () => Promise<Actor>,
    name: string,
  ): Promise<Response> => {
    if (request.method !== "GET") throw allowOnly("GET", "A View");
    if (!registry.views[name] || name === READ_VIEW) throw fault("not_found", `No View "${name}".`);
    const item = param<unknown>(url, "item", {});
    const observation = env.owner().observe(name, item, { actor, viewer: viewerOf(actor) });
    const first = await observation.ready;
    if (first.status === "failed") {
      observation.close();
      throw first.error;
    }
    if (watching(request)) return watched(observation, actor, again);
    observation.close();
    return json(first.status === "ready" ? first.value : null);
  };

  const answer: Api["answer"] = async (request, actor, again) => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // A credential that proves nobody (a key revoked, or never made) isn't anonymous: it's refused.
    if (actor.kind === "anonymous" && request.headers.has("authorization")) {
      return failed(
        401,
        "unauthorized",
        "That credential proves nobody: it was revoked, or never was.",
        {
          "www-authenticate": 'Bearer realm="api", error="invalid_token"',
        },
      );
    }
    const url = new URL(request.url);
    try {
      let parts: string[];
      try {
        parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
      } catch {
        throw fault("invalid", "The path isn't well encoded.");
      }
      const [kind = "", name, id, ...rest] = parts;
      if (rest.length) throw fault("not_found", `Nothing at ${url.pathname}: see GET /api/.`);
      // A stream is held open: nobody holds one anonymously (events followed, a watch).
      const followed = kind === "events" && !name && id === undefined;
      if (actor.kind === "anonymous" && (followed || watching(request))) {
        throw Object.assign(
          fault("unauthorized", "Sign in, or call with a key, to follow what happens."),
          { headers: { "www-authenticate": 'Bearer realm="api"' } },
        );
      }
      if (kind === "" && name === undefined) {
        if (request.method !== "GET") throw allowOnly("GET", "The reference");
        return json(await reference(actor));
      }
      switch (kind) {
        case "collections":
          return await collections(request, url, actor, again, name, id);
        case "actions": {
          if (!name || id !== undefined) break;
          if (request.method !== "POST") throw allowOnly("POST", "Call an Action");
          if (!registry.actions[name]) throw fault("not_found", `No Action "${name}".`);
          const given = request.headers.get("idempotency-key");
          const input = await bodyJson(request);
          return json(
            await env.owner().call(name, input, {
              actor,
              ...(given !== null ? { id: callIdOf(actor, given) } : {}),
            }),
          );
        }
        case "queries":
          if (!name || id !== undefined) break;
          return await queries(request, url, actor, again, name);
        case "views":
          if (!name || id !== undefined) break;
          return await views(request, url, actor, again, name);
        case "events":
          if (id !== undefined) break;
          if (name === undefined || name === "") {
            if (request.method !== "GET") throw allowOnly("GET", "Follow events");
            return follow(actor, again);
          }
          if (request.method !== "POST") throw allowOnly("POST", "Emit an event");
          await env.owner().emit(name, object(await bodyJson(request), "An event's data"), {
            actor,
          });
          return new Response(null, { status: 204, headers: CORS });
      }
      throw fault("not_found", `Nothing at ${url.pathname}: see GET /api/.`);
    } catch (error) {
      return refusal(error, actor);
    }
  };

  return {
    answer,
    end(actor) {
      for (const finish of [...open.get(holderOf(actor)) ?? []]) finish();
    },
    close() {
      for (const ends of [...open.values()]) for (const finish of [...ends]) finish();
      open.clear();
    },
  };
}

/**
 * A failure as an outside caller is told it: a person (a key's too), all
 * of it; a contact or anonymous, its words only when they're for anyone
 * (`public`), else that it failed, and its code.
 */
function toldTo(actor: Actor, error: unknown): { code?: string; message: string } {
  const told = said(error);
  if (actor.kind === "person" || told.public) {
    return { ...(told.code ? { code: told.code } : {}), message: told.message };
  }
  return { ...(told.code ? { code: told.code } : {}), message: "Something went wrong." };
}

/** What a thrown error answers: its code's status, as the caller may be told it; else a 500. */
function refusal(error: unknown, actor: Actor): Response {
  const { code, allow, headers } = (error ?? {}) as {
    code?: unknown;
    allow?: string;
    headers?: Record<string, string>;
  };
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code !== "string" || !STATUS[code]) {
    // The runtime says an unknown name is invalid; to a caller, it isn't there.
    if (/^Unknown (action|query|collection)/.test(message)) {
      return failed(404, "not_found", message);
    }
    console.error("api:", message);
    return failed(500, "internal", "Something went wrong.");
  }
  // Refused for being nobody: who they are might be let in.
  if (actor.kind === "anonymous" && code === "forbidden") {
    return failed(
      401,
      "unauthorized",
      "Sign in, or call with a key: `Authorization: Bearer <key>`.",
      {
        "www-authenticate": 'Bearer realm="api"',
      },
    );
  }
  const told = toldTo(actor, error);
  return failed(STATUS[code], code, told.message, {
    ...(allow ? { allow } : {}),
    ...headers,
  });
}
