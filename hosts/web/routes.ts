/**
 * Plugins' own HTTP, as the web host answers it: a `routes` resource, by name.
 * A path ending in `/` takes everything under it; any other, itself alone.
 *
 * - `{ path, action }`: the request becomes a call to that Action (its input
 *   an `HttpRequest`), as the person its session cookie signs in, or else a
 *   visitor (`{ kind: "visitor", id: "" }`): the Action's `allow` decides.
 *   It answers with an `HttpAnswer`. Webhooks, OAuth callbacks, an API.
 * - `{ path, serve }`: a function that answers the request itself, here in
 *   the host's process, for files as they are (downloads), never for data.
 *
 * `methods` limits which methods it takes (all by default). Paths the host
 * serves itself can't be taken.
 *
 * ```ts
 * resources: { routes: { "whatsapp.hook": { path: "/hooks/whatsapp", action: "whatsapp.hook" } } }
 * ```
 */
import type { Actor, Infer, Runtime } from "../../runtime/mod.ts";

export type Route =
  & { path: string; methods?: string[] }
  & ({ action: string } | { serve(request: Request): Response | Promise<Response> });

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
    if (name !== "cookie") headers[name] = value;
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

/**
 * Answers the requests a plugin's route takes; undefined for any other. `whom`
 * says who the request's session signs in, if anyone.
 */
export function routeServer(
  runtime: Runtime,
  whom: (request: Request) => Promise<Actor | null>,
): (request: Request) => Promise<Response> | undefined {
  const routes = Object.entries(
    (runtime.describe().resources.routes ?? {}) as Record<string, Route | null>,
  ).filter((entry): entry is [string, Route] => !!entry[1]);
  for (const [name, route] of routes) {
    if (!route.path.startsWith("/")) {
      throw new Error(`routes.${name}: its path must start with "/"`);
    }
    if (OWN.some((own) => route.path.startsWith(own) || own.startsWith(route.path))) {
      throw new Error(`routes.${name}: "${route.path}" is the web host's own`);
    }
  }
  // The longest path first, so a more specific route wins.
  routes.sort(([, a], [, b]) => b.path.length - a.path.length);
  const match = (url: URL, method: string) =>
    routes.find(([, route]) =>
      (route.path.endsWith("/")
        ? url.pathname.startsWith(route.path)
        : url.pathname === route.path) &&
      (!route.methods || route.methods.includes(method))
    );

  return (request) => {
    const url = new URL(request.url);
    const found = match(url, request.method);
    if (!found) return undefined;
    const [name, route] = found;
    return (async () => {
      if ("serve" in route) return await route.serve(request);
      const asked = await read(request, url);
      if (asked instanceof Response) return asked;
      const actor = (await whom(request).catch(() => null)) ?? VISITOR;
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
    })();
  };
}
