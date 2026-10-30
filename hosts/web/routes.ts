/**
 * Plugins' own HTTP, as the web host answers it: a `routes` resource, by name.
 * A path ending in `/` takes everything under it; any other, itself alone.
 *
 * - `{ path, action }`: the request becomes a call to that Action (its input
 *   an `HttpRequest`), as the person its session cookie signs in, or else a
 *   visitor (`{ kind: "visitor", id: "" }`): the Action's `allow` decides.
 *   It answers with an `HttpAnswer`. Webhooks, OAuth callbacks, an API.
 * - `{ path, serve }`: a function that answers the request itself, here in
 *   the host's process: files as they are (downloads), or an API that must
 *   stream, choose call ids or keep a request's secrets out of the log. It's
 *   given the runtime and who the request's session signs in (`Served`).
 * - `{ host, serve }` (or `action`): every request to a host, whatever its
 *   path, and never the app's page, code or socket there: what a computer
 *   serves (a preview), an app of the app's own. `host` is a pattern: a host
 *   exactly (`docs.example.com`), or `*<suffix>`, any first label ending so
 *   (`*-preview.copilotz.app` takes `abc123-preview.copilotz.app`, not
 *   `a.b-preview.copilotz.app`). It may be a function of the app's
 *   resources, for a domain its settings name, answering nothing for no
 *   route. A port in a pattern must match too; without one, any port does.
 *
 * `methods` limits which methods it takes (all by default). Paths the host
 * serves itself can't be taken.
 *
 * The host a request is for is its own (`Host`), or, from the app's front
 * (a Cloudflare worker before it, with `front: { secret }`), the one the
 * front says (`x-forwarded-host`), when it carries the front's secret
 * (`x-copilotz-front`). Anyone else's forwarded headers are ignored.
 *
 * ```ts
 * resources: { routes: { "whatsapp.hook": { path: "/hooks/whatsapp", action: "whatsapp.hook" } } }
 * ```
 */
import type { Actor, Infer, Resources, Runtime } from "../../runtime/mod.ts";

export type Route =
  & ({ path: string } | { host: string | ((resources: Resources) => string | undefined) })
  & { methods?: string[] }
  & ({ action: string } | { serve(request: Request, host: Served): Response | Promise<Response> });

/**
 * What a `serve` route is given: the runtime, who the request's session
 * signs in, and the host the request is for (as the front says, when it's
 * trusted: not always `request.url`'s).
 */
export type Served = { runtime: Runtime; whom(): Promise<Actor | null>; host: string };

/** The app's front (a Cloudflare worker before it): the secret it vouches for requests with. */
export type Front = { secret: string };

/** The header the front puts its secret in. */
export const FRONT = "x-copilotz-front";

/** Whether two strings are the same, taking as long whatever their first difference. */
const same = (a: string, b: string) => {
  let differ = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    differ |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return differ === 0;
};

/** Whether the front vouches for a request: it carries the front's secret. */
export const vouched = (request: Request, front?: Front): boolean => {
  const said = request.headers.get(FRONT);
  return !!front?.secret && said !== null && same(said, front.secret);
};

/**
 * The host a request is for, lowercased: the front's word for it
 * (`x-forwarded-host`) when the front vouches for the request, else its own.
 */
export function hostOf(request: Request, front?: Front): string {
  const forwarded = vouched(request, front)
    ? request.headers.get("x-forwarded-host")?.split(",")[0].trim()
    : undefined;
  return (forwarded || new URL(request.url).host).toLowerCase();
}

/**
 * Whether a host matches a pattern: exactly, or `*<suffix>` for any first
 * label ending so. Without a port in the pattern, the host's is ignored.
 */
export function hostMatches(pattern: string, host: string): boolean {
  const wanted = pattern.toLowerCase();
  const asked = /:\d+$/.test(wanted) ? host : host.replace(/:\d+$/, "");
  if (!wanted.startsWith("*")) return asked === wanted;
  const suffix = wanted.slice(1);
  const first = asked.slice(0, asked.length - suffix.length);
  return asked.endsWith(suffix) && first.length > 0 && !first.includes(".");
}

/**
 * What an Action a route calls is given, the request read: its schema, for
 * the Action's `input`. The path asked for, and its query's parameters (the
 * last of each name); headers lowercased, the cookie left out (the actor is
 * who it signs in); the body as text, or base64 when it isn't text
 * (`base64: true`).
 */
export const httpRequest = {
  type: "object",
  properties: {
    method: { type: "string" },
    path: { type: "string" },
    query: { type: "object", additionalProperties: { type: "string" } },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: { type: "string" },
    base64: { type: "boolean", const: true },
  },
  required: ["method", "path", "query", "headers"],
  additionalProperties: false,
} as const;

export type HttpRequest = Infer<typeof httpRequest>;

/** What it answers: `body` is sent as it is when a string, else as JSON. */
export type HttpAnswer = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Sends the browser there (302). */
  redirect?: string;
};

/** Who calls when nobody's signed in. */
export const VISITOR: Actor = { kind: "visitor", id: "" };

/** Paths the web host answers itself. */
const OWN = ["/app/", "/assets/", "/files/", "/oxian", "/connect", "/signin", "/signout"];

/** Bodies larger than this are refused (10 MB). */
const MAX_BODY = 10 * 1024 * 1024;

const textual = (type: string) =>
  !type || /^text\/|json|xml|x-www-form-urlencoded|javascript/.test(type);

const STATUS: Record<string, number> = {
  forbidden: 403,
  invalid: 400,
  not_found: 404,
  unauthorized: 401,
};

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** Reads a request as an Action takes it. */
async function read(request: Request, url: URL): Promise<HttpRequest | Response> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    // The front's secret is the host's, never a plugin's to see (or log).
    if (name !== "cookie" && name !== FRONT) headers[name] = value;
  });
  const asked: HttpRequest = {
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
  };
  if (!request.body) return asked;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY) return plain(413, "Too large");
  if (textual(headers["content-type"] ?? "")) {
    return { ...asked, body: new TextDecoder().decode(bytes) };
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { ...asked, body: btoa(binary), base64: true };
}

/** An Action's answer, as a response. */
function answer(value: unknown): Response {
  const said = (value ?? {}) as HttpAnswer;
  if (said.redirect) {
    return new Response(null, {
      status: 302,
      headers: { location: said.redirect, ...said.headers },
    });
  }
  const text = typeof said.body === "string";
  return new Response(
    said.body === undefined ? null : text ? said.body as string : JSON.stringify(said.body),
    {
      status: said.status ?? 200,
      headers: {
        ...(said.body === undefined
          ? {}
          : { "content-type": text ? "text/plain; charset=utf-8" : "application/json" }),
        ...said.headers,
      },
    },
  );
}

/** A runtime's routes, checked: those by path, the longest first, and those by host. */
function declared(runtime: Runtime) {
  const resources = runtime.describe().resources;
  const routes = Object.entries((resources.routes ?? {}) as Record<string, Route | null>)
    .filter((entry): entry is [string, Route] => !!entry[1]);
  const paths: { name: string; route: Route & { path: string } }[] = [];
  const hosts: { name: string; route: Route; pattern: string }[] = [];
  for (const [name, route] of routes) {
    if ("host" in route) {
      const pattern = typeof route.host === "function" ? route.host(resources) : route.host;
      if (pattern === undefined) continue;
      if (!/^\*?[a-z0-9.-]+(:\d+)?$/i.test(pattern)) {
        throw new Error(`routes.${name}: "${pattern}" isn't a host, or *<suffix>`);
      }
      hosts.push({ name, route, pattern });
      continue;
    }
    if (!route.path.startsWith("/")) {
      throw new Error(`routes.${name}: its path must start with "/"`);
    }
    if (OWN.some((own) => route.path.startsWith(own) || own.startsWith(route.path))) {
      throw new Error(`routes.${name}: "${route.path}" is the web host's own`);
    }
    paths.push({ name, route });
  }
  // The longest path first, so a more specific route wins; an exact host before a pattern.
  paths.sort((a, b) => b.route.path.length - a.route.path.length);
  hosts.sort((a, b) =>
    Number(a.pattern.startsWith("*")) - Number(b.pattern.startsWith("*")) ||
    b.pattern.length - a.pattern.length
  );
  return { paths, hosts };
}

/** Answers a request as a route does: its `serve`, or a call to its Action. */
async function answered(
  runtime: Runtime,
  name: string,
  route: Route,
  request: Request,
  url: URL,
  served: Served,
): Promise<Response> {
  if ("serve" in route) return await route.serve(request, served);
  const asked = await read(request, url);
  if (asked instanceof Response) return asked;
  const actor = (await served.whom().catch(() => null)) ?? VISITOR;
  try {
    return answer(await runtime.call(route.action, asked, { actor }));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code && STATUS[code]) {
      return plain(STATUS[code], error instanceof Error ? error.message : String(error));
    }
    console.error(`routes.${name}:`, error instanceof Error ? error.message : error);
    return plain(500, "Something went wrong");
  }
}

/**
 * Whether a route by host takes a request: for what must decide at once,
 * before anything asynchronous (Node's socket upgrade).
 */
export function hostRouted(
  runtime: Runtime,
  options: { front?: Front } = {},
): (request: Request) => boolean {
  const { hosts } = declared(runtime);
  return (request) => {
    if (!hosts.length) return false;
    const host = hostOf(request, options.front);
    return hosts.some((h) => hostMatches(h.pattern, host));
  };
}

/**
 * Answers the requests a route by host takes (all of a host's), and only
 * those; undefined for any other. For a host serving many orgs, a host an
 * org claimed is its routes' alone.
 */
export function hostServer(
  runtime: Runtime,
  whom: (request: Request) => Promise<Actor | null>,
  options: { front?: Front } = {},
): (request: Request) => Promise<Response> | undefined {
  const { hosts } = declared(runtime);
  return (request) => {
    if (!hosts.length) return undefined;
    const host = hostOf(request, options.front);
    const found = hosts.find((h) =>
      hostMatches(h.pattern, host) && (!h.route.methods || h.route.methods.includes(request.method))
    );
    if (!found) return undefined;
    return answered(runtime, found.name, found.route, request, new URL(request.url), {
      runtime,
      whom: () => whom(request),
      host,
    });
  };
}

/**
 * Answers the requests a plugin's route takes; undefined for any other. `whom`
 * says who the request's session signs in, if anyone. A request to a host a
 * route takes is that route's, whatever its path; any other goes by path.
 */
export function routeServer(
  runtime: Runtime,
  whom: (request: Request) => Promise<Actor | null>,
  options: { front?: Front } = {},
): (request: Request) => Promise<Response> | undefined {
  const { paths } = declared(runtime);
  const hosted = hostServer(runtime, whom, options);
  const match = (url: URL, method: string) =>
    paths.find(({ route }) =>
      (route.path.endsWith("/")
        ? url.pathname.startsWith(route.path)
        : url.pathname === route.path) &&
      (!route.methods || route.methods.includes(method))
    );

  return (request) => {
    const byHost = hosted(request);
    if (byHost) return byHost;
    const url = new URL(request.url);
    const found = match(url, request.method);
    if (!found) return undefined;
    return answered(runtime, found.name, found.route, request, url, {
      runtime,
      whom: () => whom(request),
      host: hostOf(request, options.front),
    });
  };
}
