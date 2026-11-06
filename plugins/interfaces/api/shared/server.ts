/**
 * The developer API over HTTP, under `/api/`. Code calls with a key
 * (`Authorization: Bearer <key>`), as the key's person, in its space, and
 * only for what its scope lists:
 *
 * - `POST /api/actions/<name>`: calls an Action, the body its input (an
 *   Action that takes a space, `in`, gets the key's when the body names
 *   none); an `Idempotency-Key` header makes it the call's id, so sending it
 *   again answers what the first did, without doing it twice. Answers what
 *   the Action returned.
 * - `POST /api/queries/<collection>.<query>`: runs a query, the body its params.
 * - `GET /api/views/<name>?item=<json>` (or `?id=`): what a View shows
 *   (`llm.thread`); `?follow=1` keeps sending it as it changes.
 * - `GET /api/events`: what the key may see, as it happens (see events.ts).
 * - `GET /api/`: the key's reference (each Action's description and input
 *   schema, its queries, Views and collections). From the app's own page,
 *   signed in, the catalog of Actions instead, for choosing what a key does.
 *
 * Errors are JSON, `{ error: { code, message } }`, with the status their
 * code says. The runtime checks everything a call from outside is checked
 * for: each Action's and query's `allow`, the key's scope, and the rules.
 *
 * It runs in the web host's process (a `serve` route) and needs the runtime
 * the host hands it: calls by id, `describe()` and following events are the
 * runtime's public API, not plugin code's.
 */
import type { Actor, Runtime } from "../../../../runtime/mod.ts";
import type { ApiKey } from "../collections/key.ts";
import type { KeyActor } from "./actor.ts";
import { eventStream } from "./events.ts";
import { answerFor, bodyOf, CORS, failure, fault, json } from "./http.ts";
import { catalogOf, referenceOf, takesSpace } from "./reference.ts";

/** What the web host hands a `serve` route: the runtime, and who the request's session signs in. */
export type Served = {
  runtime: Pick<Runtime, "call" | "query" | "describe" | "subscribe" | "observe">;
  whom?(): Promise<Actor | null>;
};

/** A key's last use is noted at most this often. */
const USED_EVERY_MS = 60_000;

/** When each key's use was last noted, by runtime: at most once a minute each. */
const noted = new WeakMap<object, Map<string, number>>();

const unauthorized = () =>
  failure(
    401,
    "unauthorized",
    "Call with a developer key: `Authorization: Bearer <key>` (make one in a space's API tab).",
    { "www-authenticate": 'Bearer realm="api"' },
  );

/** Who calls with a request's key (its person, with its scope); null when none that works. */
async function proven(request: Request, runtime: Served["runtime"]): Promise<KeyActor | null> {
  const [scheme, secret] = (request.headers.get("authorization") ?? "").split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !secret) return null;
  return await runtime.query<KeyActor | null>("api_key.actor", { secret });
}

/** The key calling, as its person reads it (its name, its space): the system's read. */
async function keyOf(runtime: Served["runtime"], actor: KeyActor): Promise<ApiKey> {
  const key = await runtime.query<ApiKey | null>("api_key.get", { key: actor.key });
  if (!key) throw fault("unauthorized", "The key was revoked.");
  return key;
}

/** The name after a prefix of the path, decoded: `/api/actions/chat.send` → `chat.send`. */
const nameAfter = (path: string, prefix: string) => {
  try {
    return path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : undefined;
  } catch {
    return undefined;
  }
};

/** An Action's call id, from the caller's `Idempotency-Key`: its own, within the key's. */
function callId(request: Request, actor: KeyActor): string | undefined {
  const given = request.headers.get("idempotency-key");
  if (given === null) return undefined;
  if (!/^[\x21-\x7e]{1,200}$/.test(given)) {
    throw fault("invalid", "An Idempotency-Key is 1 to 200 visible ASCII characters.");
  }
  return `api:${actor.key}:${given}`;
}

/** Answers a request under `/api/`. */
export async function serveApi(request: Request, host?: Served): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!host?.runtime) {
    return failure(
      501,
      "unavailable",
      "The web host doesn't hand this route the runtime: the API can't answer here.",
    );
  }
  const { runtime } = host;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "/");
  try {
    const actor = await proven(request, runtime);
    if (!actor) {
      // The app's own page, signed in: every Action, to choose what a key does.
      const person =
        path === "/" && request.method === "GET" && !request.headers.has("authorization")
          ? await host.whom?.().catch(() => null)
          : null;
      if (person?.kind === "person") return json({ actions: catalogOf(runtime.describe()) });
      return unauthorized();
    }
    used(runtime, actor);
    const described = runtime.describe();
    const action = nameAfter(path, "/actions/");
    const query = nameAfter(path, "/queries/");
    const view = nameAfter(path, "/views/");

    if (path === "/") {
      if (request.method !== "GET") throw fault("method", "Use GET for the reference.");
      const key = await keyOf(runtime, actor);
      return json({
        ...referenceOf(described, actor.scope),
        key: { name: key.name, in: key.in, hint: key.hint, role: key.role },
      });
    }
    if (action !== undefined) {
      if (request.method !== "POST") throw fault("method", "Call Actions with POST.");
      const id = callId(request, actor);
      let input = await bodyOf(request);
      // An Action that takes a space works in the key's, unless the body names one.
      if (
        input && typeof input === "object" && !Array.isArray(input) && !("in" in input) &&
        takesSpace(described, action)
      ) input = { ...input, in: (await keyOf(runtime, actor)).in };
      return json(await runtime.call(action, input, { actor, ...(id ? { id } : {}) }));
    }
    if (query !== undefined) {
      if (request.method !== "POST") throw fault("method", "Run queries with POST.");
      return json(await runtime.query(query, await bodyOf(request), { actor }));
    }
    if (view !== undefined) {
      if (request.method !== "GET") throw fault("method", "Read Views with GET.");
      return await viewOf(runtime, url, view, actor);
    }
    if (path === "/events") {
      if (request.method !== "GET") throw fault("method", "Follow events with GET.");
      return eventStream(runtime, actor, async () => !!await proven(request, runtime));
    }
    throw fault("not_found", `Nothing at ${url.pathname}: see GET /api/ for what this key can do.`);
  } catch (error) {
    return answerFor(error);
  }
}

/** Notes the key's use, at most once a minute, without waiting for it. */
function used(runtime: Served["runtime"], actor: KeyActor) {
  let last = noted.get(runtime);
  if (!last) noted.set(runtime, last = new Map());
  const now = Date.now();
  if (now - (last.get(actor.key) ?? 0) < USED_EVERY_MS) return;
  last.set(actor.key, now);
  void runtime.call("api_key.used", { key: actor.key, at: new Date(now).toISOString() })
    .catch(() => {});
}

/**
 * A View as the key reads it (one its scope lists: the runtime says): once,
 * or (`follow=1`) as server-sent events while it changes.
 */
async function viewOf(
  runtime: Served["runtime"],
  url: URL,
  name: string,
  actor: KeyActor,
): Promise<Response> {
  let item: unknown = {};
  const given = url.searchParams.get("item");
  if (given !== null) {
    try {
      item = JSON.parse(given);
    } catch {
      throw fault("invalid", "`item` is JSON.");
    }
  } else if (url.searchParams.has("id")) item = { _id: url.searchParams.get("id") };
  const observed = runtime.observe(name, item, {
    actor,
    viewer: { name: actor.id, kind: "person" },
  });
  const first = await observed.ready;
  if (first.status === "failed") {
    observed.close();
    throw first.error;
  }
  if (url.searchParams.get("follow") !== "1") {
    observed.close();
    return json(first.status === "ready" ? first.value : null);
  }
  const encoder = new TextEncoder();
  let last = "";
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        const now = observed.get();
        if (now.status !== "ready") return;
        const text = JSON.stringify(now.value ?? null);
        if (text === last) return;
        last = text;
        controller.enqueue(encoder.encode(`event: view\ndata: ${text}\n\n`));
      };
      const unsubscribe = observed.subscribe(send);
      const ping = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 20_000);
      stop = () => {
        unsubscribe();
        clearInterval(ping);
        observed.close();
      };
      send();
    },
    cancel: () => stop(),
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      ...CORS,
    },
  });
}
