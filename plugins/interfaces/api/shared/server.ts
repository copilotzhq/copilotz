/**
 * The developer API over HTTP, under `/api/`. Code calls with a key
 * (`Authorization: Bearer <key>`), as the key's person, narrowed to its
 * space, and only for what the key lists:
 *
 * - `POST /api/actions/<name>`: calls an Action, the body its input (an
 *   Action that takes a space, `in`, gets the key's when the body names
 *   none); an `Idempotency-Key` header makes it the call's id, so sending it
 *   again answers what the first did, without doing it twice. Answers what
 *   the Action returned.
 * - `POST /api/queries/<collection>.<query>`: runs a query, the body its params.
 * - `GET /api/views/<kind>?item=<json>` (or `?id=`): what a View shows,
 *   `llm` by default (`?medium=`); `?follow=1` keeps sending it as it changes.
 * - `GET /api/events`: what the key may see, as it happens (see events.ts).
 * - `GET /api/`: the key's reference (each Action's description and input
 *   schema, its queries and Views). From the app's own page, signed in, the
 *   catalog of Actions instead, for choosing what a key does.
 *
 * Errors are JSON, `{ error: { code, message } }`, with the status their
 * code says. The runtime checks each Action's and query's `allow` and the
 * rules, as for any outside call; the key's lists are checked here first.
 *
 * It runs in the web host's process (a `serve` route) and needs the runtime
 * the host hands it: calls by id, `allow`, `describe()` and following
 * events are the runtime's public API, not plugin code's.
 */
import type { Actor, Runtime } from "../../../../runtime/mod.ts";
import type { Proven } from "../collections/key.ts";
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

const unauthorized = () =>
  failure(
    401,
    "unauthorized",
    "Call with a developer key: `Authorization: Bearer <key>` (make one in a space's API tab).",
    { "www-authenticate": 'Bearer realm="api"' },
  );

const notAllowed = (what: string, name: string) =>
  fault("forbidden", `This key may not ${what} "${name}": its person can let it, in the API tab.`);

/** The key a request shows, and who calling with it is; null when it shows none that works. */
async function proven(request: Request, runtime: Served["runtime"]): Promise<Proven | null> {
  const [scheme, secret] = (request.headers.get("authorization") ?? "").split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !secret) return null;
  return await runtime.query<Proven | null>("api_key.actor", { secret });
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
function callId(request: Request, proven: Proven): string | undefined {
  const given = request.headers.get("idempotency-key");
  if (given === null) return undefined;
  if (!/^[\x21-\x7e]{1,200}$/.test(given)) {
    throw fault("invalid", "An Idempotency-Key is 1 to 200 visible ASCII characters.");
  }
  return `api:${proven.actor.key}:${given}`;
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
    const key = await proven(request, runtime);
    if (!key) {
      // The app's own page, signed in: every Action, to choose what a key does.
      const person =
        path === "/" && request.method === "GET" && !request.headers.has("authorization")
          ? await host.whom?.().catch(() => null)
          : null;
      if (person?.kind === "person") return json({ actions: catalogOf(runtime.describe()) });
      return unauthorized();
    }
    used(runtime, key);
    const { actor } = key;
    const described = runtime.describe();
    const action = nameAfter(path, "/actions/");
    const query = nameAfter(path, "/queries/");
    const view = nameAfter(path, "/views/");

    if (path === "/") {
      if (request.method !== "GET") throw fault("method", "Use GET for the reference.");
      return json({
        ...referenceOf(described, key.key),
        key: { name: key.key.name, in: key.key.in, hint: key.key.hint },
      });
    }
    if (action !== undefined) {
      if (request.method !== "POST") throw fault("method", "Call Actions with POST.");
      if (!key.key.actions.includes(action)) throw notAllowed("call", action);
      if (!described.actions[action]) throw fault("not_found", `No Action "${action}" here.`);
      const id = callId(request, key);
      let input = await bodyOf(request);
      if (
        input && typeof input === "object" && !Array.isArray(input) && !("in" in input) &&
        takesSpace(described, action)
      ) input = { ...input, in: actor.at };
      return json(await runtime.call(action, input, { actor, ...(id ? { id } : {}) }));
    }
    if (query !== undefined) {
      if (request.method !== "POST") throw fault("method", "Run queries with POST.");
      if (!key.key.queries.includes(query)) throw notAllowed("run", query);
      return json(await runtime.query(query, await bodyOf(request), { actor }));
    }
    if (view !== undefined) {
      if (request.method !== "GET") throw fault("method", "Read Views with GET.");
      if (!(key.key.views ?? []).includes(view)) throw notAllowed("read", view);
      return await viewOf(runtime, url, view, actor);
    }
    if (path === "/events") {
      if (request.method !== "GET") throw fault("method", "Follow events with GET.");
      return eventStream(
        runtime,
        key,
        async () => !!await proven(request, runtime),
      );
    }
    throw fault("not_found", `Nothing at ${url.pathname}: see GET /api/ for what this key can do.`);
  } catch (error) {
    return answerFor(error);
  }
}

/** Notes the key's use, at most once a minute, without waiting for it. */
function used(runtime: Served["runtime"], { key }: Proven) {
  const now = Date.now();
  if (key.used && now - Date.parse(key.used) < USED_EVERY_MS) return;
  void runtime.call("api_key.used", { key: key._id, at: new Date(now).toISOString() })
    .catch(() => {});
}

/** A View as the key reads it: once, or (`follow=1`) as server-sent events while it changes. */
async function viewOf(
  runtime: Served["runtime"],
  url: URL,
  kind: string,
  actor: Proven["actor"],
): Promise<Response> {
  const medium = url.searchParams.get("medium") || "llm";
  let item: unknown = {};
  const given = url.searchParams.get("item");
  if (given !== null) {
    try {
      item = JSON.parse(given);
    } catch {
      throw fault("invalid", "`item` is JSON.");
    }
  } else if (url.searchParams.has("id")) item = { _id: url.searchParams.get("id") };
  const observed = runtime.observe(medium, kind, item, {
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
