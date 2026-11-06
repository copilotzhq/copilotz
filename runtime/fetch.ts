/**
 * `runtime.fetch`: the runtime as a fetch handler. A host only calls it
 * (`Deno.serve(runtime.fetch)`; Node and Bun: `listen(runtime.fetch)` from
 * `copilotz/web/node`; workerd: `export default { fetch: runtime.fetch }`),
 * and so does another runtime's route forwarding a request
 * (`other.fetch(request)`). What a listener gives beside the request (Deno's
 * `info`, Bun's server) says where it came from (see address.ts). It
 * answers every request:
 *
 * - **The site** is decided once, first: the address as the browser asked
 *   for it, on the host the app's front says (`resources.caller.front`, see
 *   site.ts), and under the app's base (`resources.page.base`: `/o/<org>/x`
 *   is `/x`). Routes are given the request as that.
 * - **Routes with a host** (a preview's): every request to a host they take.
 *   With the app's own hosts named (`resources.hosts.own`, see site.ts), a
 *   request to any other host is theirs alone (a 404 when none takes it),
 *   and the app's own hosts are never theirs.
 * - **The socket** (`/oxian`, and `<base>/oxian`): Oxian's worker protocol,
 *   for browsers (with a ticket), remote executors (with the key) and
 *   plugins' workers. The runtime accepts it itself (see `accept`).
 * - **Requests from other sites** are refused (403, see `crossSite`).
 * - **`POST /connect`** (internal: the page's client): a one-time ticket for
 *   whoever the request is, `{ ticket, actor }`; 401 for anonymous, 429
 *   (with `retry-after`) past an actor's tickets a minute.
 * - **Plugins' routes** (see routes.ts), as whoever the request is.
 * - `GET /health`, when no route takes it: `ok`. Anything else is a 404.
 *
 * **Who** a request is comes from plugins' `who`, asked in plugin order: the
 * first that answers wins; with none, `{ kind: "anonymous", id: "" }`. What
 * they query is kept a few seconds per query and params (`WHO_MS`), so a
 * page's burst of requests asks once; ending an actor (`disconnect`) drops
 * what's kept for them at once, and their tickets.
 *
 * Something a route throws is answered by its code (`failure`: `invalid`
 * 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `too_many` 429,
 * else 500, logged), with its words only when they're for anyone (`public`).
 */
import type { Hypervisor, HypervisorRequestDecision } from "@oxian/oxian-js";
import { upgradeWebSocket } from "@oxian/oxian-js/http";
import { adaptWebSocket } from "@oxian/oxian-js/transport";
import { carry, clientAddress, setClientAddress } from "./address.ts";
import { cookieReader, cookiesFor, cookiesProblem, withCookies } from "./cookies.ts";
import { linksOf } from "./links.ts";
import type { Actor } from "./store.ts";
import type { Owner } from "./owner.ts";
import { canonical, type Registry } from "./registry.ts";
import { matchRoute, routeTable } from "./routes.ts";
import { crossSite, hostsProblem, ownHost, siteOf } from "./site.ts";
import type { Tickets } from "./tickets.ts";

/** Who a request is when no plugin says. */
const ANONYMOUS: Actor = Object.freeze({ kind: "anonymous", id: "" });

/** Where the socket is, under the app's base or not. */
export const SOCKET = "/oxian";
/** Where the page's client trades its cookie for a ticket. */
const CONNECT = "/connect";

/** How long what a `who` queried is kept (ms), and how many answers at most. */
const WHO_MS = 5_000;
const WHO_MOST = 10_000;

/** A refusal's status, by its code. */
const STATUS: Record<string, number> = {
  too_many: 429,
  forbidden: 403,
  invalid: 400,
  not_found: 404,
  unauthorized: 401,
};

/** What the runtime answers in JSON is someone's (a ticket, an error): never kept. */
const json = (value: unknown, init: ResponseInit = {}) => {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const [name, said] of new Headers(init.headers)) headers.set(name, said);
  return new Response(JSON.stringify(value), { status: init.status ?? 200, headers });
};

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * An error as the runtime answers it: its code's status, its words only when
 * they're for anyone, and past a limit, when to try again (`retryAfter`, in
 * seconds, when the error says; else a minute).
 */
export function refused(error: unknown, fallback: string): Response {
  const { code, public: open, retryAfter } = (error ?? {}) as {
    code?: string;
    public?: boolean;
    retryAfter?: unknown;
  };
  const status = (code && STATUS[code]) || 500;
  const said = open === true && error instanceof Error && error.message ? error.message : fallback;
  if (status === 500) console.error(`${fallback}:`, error instanceof Error ? error.message : error);
  return json({ error: said.slice(0, 300) }, {
    status,
    ...(status === 429
      ? { headers: { "retry-after": String(typeof retryAfter === "number" ? retryAfter : 60) } }
      : {}),
  });
}

/** Whether something a `who` answered is an actor. */
const actorish = (value: unknown): value is Actor =>
  !!value && typeof value === "object" &&
  typeof (value as Actor).kind === "string" && !!(value as Actor).kind &&
  typeof (value as Actor).id === "string" && !!(value as Actor).id;

/** The app's base (`resources.page.base`), checked: a path, without a trailing slash. */
function baseOf(page: unknown): string | undefined {
  const base = (page as { base?: unknown } | undefined)?.base;
  if (base === undefined || base === "") return undefined;
  if (typeof base !== "string" || !/^(\/[^/?#\s]+)+$/.test(base)) {
    throw new Error(`page.base is a path under the host, such as "/o/acme" (no trailing slash)`);
  }
  return base;
}

/**
 * What a listener gives beside the request, when it says anything: Deno's
 * `info` (the socket's peer, and a request Deno itself can upgrade), or
 * Bun's server (`requestIP`).
 */
export type ListenerInfo = unknown;

/** Whether `info` is `Deno.serve`'s: the request is Deno's own, which it can upgrade. */
// deno-lint-ignore no-explicit-any
const fromDeno = (info: any): info is { remoteAddr: { hostname?: unknown } } =>
  // deno-lint-ignore no-explicit-any
  typeof (globalThis as any).Deno?.upgradeWebSocket === "function" &&
  !!info && typeof info === "object" && typeof info.remoteAddr === "object" && "completed" in info;

/**
 * The request `Deno.serve` gave, which Deno alone can upgrade, by each
 * request made from it: the site's, under the base, and so a socket another
 * runtime's route forwarded here (`other.fetch(request)`) is still Deno's to
 * accept.
 */
const upgradable = new WeakMap<Request, Request>();

/** The peer a listener saw, from what it gave beside the request: Deno's `info`, Bun's server. */
// deno-lint-ignore no-explicit-any
function peerOf(request: Request, info: any): string | undefined {
  if (!info || typeof info !== "object") return undefined;
  const hostname = info.remoteAddr?.hostname;
  if (typeof hostname === "string" && hostname) return hostname;
  if (typeof info.requestIP === "function") {
    const address = info.requestIP(request)?.address;
    if (typeof address === "string" && address) return address;
  }
  return undefined;
}

/**
 * Accepts the socket an upgrade decision admitted, wherever the runtime runs:
 * - `Deno.serve(runtime.fetch)`: Deno's own upgrade of the request it gave,
 *   whichever runtime it was forwarded to (`upgradable`);
 * - workerd: a `WebSocketPair`;
 * - any of Oxian's listeners (`listen` from `copilotz/web/node`, on Node,
 *   Bun or Deno) and a runtime forwarding to this one: Oxian's route
 *   upgrade, which the listener completes with the client's socket.
 */
function accept(
  request: Request,
  decision: HypervisorRequestDecision & { kind: "upgrade" },
  native: boolean,
) {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const protocol = decision.protocol;
  const attach = (socket: WebSocket, close: () => void) => {
    try {
      decision.attach(adaptWebSocket(socket), protocol);
      return true;
    } catch {
      close();
      decision.cancel("connection_rejected");
      return false;
    }
  };
  if (native) {
    let upgraded: { socket: WebSocket; response: Response };
    try {
      upgraded = g.Deno.upgradeWebSocket(request, {
        ...(protocol ? { protocol } : {}),
        idleTimeout: 0,
      });
    } catch {
      decision.cancel("invalid_upgrade");
      return plain(400, "Invalid WebSocket upgrade");
    }
    const { socket, response } = upgraded;
    return attach(socket, () => socket.close(4400, "connection_rejected"))
      ? response
      : plain(400, "WebSocket connection rejected");
  }
  if (typeof g.WebSocketPair === "function") {
    const [client, server] = Object.values(new g.WebSocketPair()) as WebSocket[];
    (server as WebSocket & { accept(): void }).accept();
    return attach(server, () => server.close(4400, "connection_rejected"))
      ? new Response(null, { status: 101, webSocket: client } as ResponseInit)
      : plain(400, "WebSocket connection rejected");
  }
  // Oxian's route upgrade, for any of its listeners: the decision is attached once the listener
  // opens the route's socket. A listener that knows the runtime takes the decision itself
  // instead (`upgradeOf`), with its own socket, so nothing stands between them.
  const { socket, response } = upgradeWebSocket(request, protocol ? { protocol } : {});
  let taken = false;
  const take = () => !taken && (taken = true);
  socket.addEventListener("open", () => {
    if (take()) attach(socket as unknown as WebSocket, () => socket.close(1011, "rejected"));
  }, { once: true });
  socket.addEventListener("close", () => {
    if (take()) decision.cancel("upgrade_closed");
  }, { once: true });
  upgrades.set(
    response,
    Object.freeze({
      kind: "upgrade" as const,
      protocol,
      attach(connection, negotiated) {
        if (!take()) throw new TypeError("This socket's admission was taken already");
        decision.attach(connection, negotiated ?? protocol);
      },
      cancel(reason) {
        if (take()) decision.cancel(reason);
      },
    }),
  );
  return response;
}

/** The decisions behind the route upgrades `accept` answered, by their response. */
const upgrades = new WeakMap<Response, HypervisorRequestDecision & { kind: "upgrade" }>();

/**
 * The Hypervisor's own upgrade decision behind a response `runtime.fetch`
 * answered for its socket, when it answered with Oxian's route upgrade: a
 * listener of Oxian's that awaits its `prepare` (`listen`, Node's) hands it
 * the client's socket directly, which carries Oxian's frames as they are
 * (a route's socket bounds each message, for routes' own protocols).
 * Undefined for any other response; once taken, the route's socket is never
 * attached.
 */
export const upgradeOf = (
  response: Response,
): (HypervisorRequestDecision & { kind: "upgrade" }) | undefined => upgrades.get(response);

/**
 * What's wrong with how plugins and settings shape the runtime's HTTP, thrown:
 * a route that isn't a pattern or takes the runtime's own paths, a bad
 * `page.base`, a bad `cookies` or `hosts` resource, a `links` secret too
 * short to sign with (rather than failing each link). The owner checks it
 * before it starts anything.
 */
export function checkHttp(registry: Registry): void {
  routeTable(registry.routes);
  baseOf(registry.resources.page);
  linksOf(registry.resources);
  const problem = cookiesProblem(registry.resources.cookies) ??
    hostsProblem(registry.resources.hosts);
  if (problem) throw new Error(problem);
}

/**
 * The runtime's fetch handler, from its registry, the owner's API (`runtime`,
 * given once it's made), its tickets and its Hypervisor. `forget` drops what
 * `who` kept for an actor (the owner's `disconnect` calls it).
 */
export function createFetch(deps: {
  registry: Registry;
  runtime: () => Owner;
  tickets: Tickets;
  hypervisor: Hypervisor;
}): {
  fetch(request: Request, info?: ListenerInfo): Promise<Response>;
  forget(actor: Actor): void;
} {
  const { registry, tickets, hypervisor } = deps;
  const resources = registry.resources;
  // As `checkHttp` found them, before the owner started.
  const table = routeTable(registry.routes);
  const base = baseOf(resources.page);
  const front = () => (resources.caller as { front?: unknown } | undefined)?.front;
  /** Which plugin set each cookie name first, and who may set it too (see cookies.ts). */
  const owners = {
    owners: new Map<string, string>(),
    related: (a: string, b: string) => {
      const [of, by] = [registry.requires[a] ?? [], registry.requires[b] ?? []];
      return of.includes(b) || by.includes(a) || of.some((name) => by.includes(name));
    },
  };

  /** What `who` queried, by query and params, while it lasts. */
  const kept = new Map<string, { until: number; answer: Promise<unknown>; value?: unknown }>();
  const query = (name: string, params?: unknown): Promise<unknown> => {
    const key = `${name}\n${canonical(params ?? null)}`;
    const now = Date.now();
    const found = kept.get(key);
    if (found && found.until > now) return found.answer;
    kept.delete(key);
    if (kept.size >= WHO_MOST) kept.delete(kept.keys().next().value!);
    const entry: { until: number; answer: Promise<unknown>; value?: unknown } = {
      until: now + WHO_MS,
      answer: deps.runtime().query(name, params),
    };
    entry.answer.then((value) => entry.value = value, () => {
      if (kept.get(key) === entry) kept.delete(key);
    });
    kept.set(key, entry);
    return entry.answer;
  };
  const forget = (actor: Actor) => {
    for (const [key, entry] of kept) {
      const value = entry.value as Actor | undefined;
      if (actorish(value) && value.kind === actor.kind && value.id === actor.id) kept.delete(key);
    }
  };

  /** Who a request is: the first plugin's `who` that answers, else anonymous. */
  const whoOf = async (request: Request, site: URL): Promise<Actor> => {
    if (!registry.whos.length) return ANONYMOUS;
    const ctx = {
      resources,
      query: query as <R>(name: string, params?: unknown) => Promise<R>,
      cookies: cookieReader(request, site, resources),
    };
    for (const { plugin, who } of registry.whos) {
      const actor = await who(request, ctx);
      if (actor === null || actor === undefined) continue;
      if (!actorish(actor)) throw new Error(`${plugin}: its who answered no actor`);
      return actor;
    }
    return ANONYMOUS;
  };

  /** The path within the app's base, for a path under it; any other, as it is. */
  const within = (path: string) =>
    base && (path === base || path.startsWith(`${base}/`)) ? path.slice(base.length) || "/" : path;

  /** The request as routes see it: on its site, its path within the base. */
  const innerOf = (request: Request, url: URL, site: URL, path: string): Request => {
    if (site.host === url.host && path === url.pathname) return request;
    const to = new URL(site);
    to.pathname = path;
    const made = new Request(to, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      redirect: request.redirect,
      duplex: "half",
    } as RequestInit);
    const original = upgradable.get(request);
    if (original) upgradable.set(made, original);
    return carry(made, request);
  };

  /** A route's answer to a request, as whoever it is, its cookies applied. */
  const answer = async (
    found: NonNullable<ReturnType<typeof matchRoute>>,
    request: Request,
    site: URL,
  ): Promise<Response> => {
    const { entry, params } = found;
    try {
      const actor = await whoOf(request, site);
      const cookies = cookiesFor(request, site, resources, entry.plugin, owners);
      const response = await entry.route(request, {
        runtime: deps.runtime(),
        actor,
        params,
        cookies,
      });
      if (!(response instanceof Response)) {
        throw new Error(`${entry.plugin}: routes["${entry.key}"] answered no Response`);
      }
      return withCookies(response, cookies.made);
    } catch (error) {
      return refused(error, "Something went wrong");
    }
  };

  /** `POST /connect`: whoever the request is, traded for a one-time ticket. */
  const connect = async (request: Request, site: URL): Promise<Response> => {
    if (request.method !== "POST") {
      return json({ error: "Only POST" }, { status: 405, headers: { allow: "POST" } });
    }
    try {
      const actor = await whoOf(request, site);
      if (actor.kind === ANONYMOUS.kind) return json({ error: "Not signed in" }, { status: 401 });
      return json({ ticket: tickets.issue(actor), actor: { kind: actor.kind, id: actor.id } });
    } catch (error) {
      return refused(error, "Couldn't connect");
    }
  };

  /** The socket: the Hypervisor admits it (a ticket, the key, a worker's secret), then it's accepted. */
  const socket = async (request: Request, url: URL): Promise<Response> => {
    const native = upgradable.get(request);
    let asked = request;
    if (url.pathname !== SOCKET) {
      const at = new URL(url);
      at.pathname = SOCKET;
      asked = new Request(at, { method: request.method, headers: request.headers });
    }
    const decision = hypervisor.prepare(asked);
    if (decision.kind === "response") return await decision.response;
    return accept(native ?? request, decision, native !== undefined);
  };

  const fetch = async (request: Request, info?: ListenerInfo): Promise<Response> => {
    const url = new URL(request.url);
    const peer = clientAddress(request) === undefined ? peerOf(request, info) : undefined;
    if (peer) setClientAddress(request, peer);
    if (fromDeno(info)) upgradable.set(request, request);
    let site: URL;
    try {
      site = siteOf(request, typeof front() === "string" ? front() as string : undefined);
    } catch (error) {
      return refused(error, "Something went wrong");
    }
    const path = within(url.pathname);
    const inner = innerOf(request, url, site, path);
    const at = inner === request ? url : new URL(inner.url);
    // The app's own hosts are never a host route's; any other is host routes' alone.
    const own = ownHost(resources.hosts, site.host);
    if (own !== true) {
      const byHost = matchRoute(table, at, { hosts: true, others: own === false });
      if (byHost) return await answer(byHost, inner, site);
      if (own === false) return plain(404, "Not found");
    }
    if (path === SOCKET) return await socket(request, url);
    if (crossSite(request, site)) {
      return json({ error: "Not from this app's page" }, { status: 403 });
    }
    if (path === CONNECT) return await connect(inner, site);
    const found = matchRoute(table, at, { hosts: false });
    if (found) return await answer(found, inner, site);
    if ((request.method === "GET" || request.method === "HEAD") && path === "/health") {
      return plain(200, "ok");
    }
    return plain(404, "Not found");
  };

  return { fetch, forget };
}
