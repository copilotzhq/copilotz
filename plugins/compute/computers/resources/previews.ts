/**
 * Previews on the web (see design/cloud-computers.md, "Previews"): the web
 * host's routes (the `routes` resource) for what jobs serve, once the app
 * says where (`previews` in the computers resource).
 *
 * - Every request to `<label>.<domain>` (a host route: `*-preview.<domain>`)
 *   goes to the preview's computer, over its own connection (no inbound
 *   network: a person's computer or a cloud one alike), as one HTTP
 *   exchange with the port (`computer.http`), streamed both ways. A
 *   computer that's asleep is woken first, when the app has a wake hook
 *   (`computerWake`: `{ wake, touch }`, Actions called with `{ computer }`);
 *   each request keeps it awake. WebSockets aren't carried (yet): 501.
 * - Who opens it: anyone, for `link`. For `members`, a cookie for that host
 *   (`cz_preview`: who, until when, signed with the `key`, for 12 hours).
 *   Without one, the browser goes to the app (`GET <app>/__copilotz/
 *   previews/grant?host=&to=`), where a signed-in member of its space is
 *   given a short-lived grant, back on the preview's host
 *   (`/__copilotz/grant?g=&to=`), which becomes the cookie. Only paths on
 *   the preview are gone back to (`to`).
 */
import type { Actor, Resources, Runtime } from "../../../../runtime/mod.ts";

/**
 * The web host's routes, as its `routes` resource takes them (hosts/web/routes.ts,
 * which plugins don't import): by host or path, and what a `serve` route is given.
 */
type Served = { runtime: Runtime; whom(): Promise<Actor | null>; host: string };
type Route =
  & ({ path: string } | { host: string | ((resources: Resources) => string | undefined) })
  & { methods?: string[] }
  & { serve(request: Request, served: Served): Response | Promise<Response> };
import { previewUrl, schemeOf } from "../actions/preview.ts";
import type { Preview } from "../collections/preview.ts";
import { personOf } from "../shared/person.ts";
import { type PreviewsSettings, settingsOf } from "../shared/settings.ts";
import { type HttpRequestHead, type HttpResponseHead, WORK } from "../shared/workloads.ts";

/** Where the app gives a member a grant for a preview. */
export const GRANT = "/__copilotz/previews/grant";
/** Where a preview's host turns a grant into its cookie. */
export const LANDING = "/__copilotz/grant";
/** The cookie that lets a member into a preview's host. */
export const COOKIE = "cz_preview";

/** How long the cookie lasts, and a grant on its way to becoming one (seconds). */
const COOKIE_S = 12 * 3600;
const GRANT_S = 120;
/** How often each computer is said to be in use, at most, while its previews are asked. */
const TOUCH_MS = 10_000;
/** How long a computer woken for a request has to connect. */
const WAKE_MS = 90_000;
/** The most a chunk of a request's body is, on its way (under Oxian's 1 MiB). */
const CHUNK = 256 * 1024;

/** Headers for one connection, not passed on (with the front's secret, and the host). */
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "x-copilotz-front",
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const text = (status: number, said: string, headers: Record<string, string> = {}) =>
  new Response(said, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

const redirect = (location: string) =>
  new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

/** The app's hook for computers that sleep (cloud ones): wake one, and say it's in use. */
type Wake = { wake?: string; touch?: string };

/** A runtime's previews' settings, and its wake hook: read once (they don't change as it runs). */
const known = new WeakMap<Runtime, { settings?: PreviewsSettings; hook: Wake }>();
const configOf = (runtime: Runtime) => {
  let config = known.get(runtime);
  if (!config) {
    const resources = runtime.describe().resources;
    config = {
      settings: settingsOf({ resources }).previews,
      hook: (resources.computerWake ?? {}) as Wake,
    };
    known.set(runtime, config);
  }
  return config;
};

/** A cookie a request carries, by name. */
const cookieOf = (request: Request, name: string) =>
  request.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/**
 * `to` as a path on this host (`/a?b`), as browsers would read it; undefined
 * when it leaves it (`//elsewhere`, `/\elsewhere`, `https://…`).
 */
const pathOn = (to: string) => {
  const here = "https://preview.invalid";
  const url = to.startsWith("/") ? new URL(to, here) : undefined;
  return url?.origin === here ? url.pathname + url.search + url.hash : undefined;
};

/** A preview's label, when `host` is one of this domain's previews' (and only then). */
const labelOf = (host: string, domain: string) => {
  const label = host.slice(0, host.length - domain.length - 1);
  return host === `${label}.${domain}` && /^[a-z0-9]{10}-preview$/.test(label) ? label : undefined;
};

// Grants and cookies: what they say, as base64url JSON, and its HMAC-SHA-256 with the key.
type Signed = { use: "grant" | "cookie"; host: string; person: string; exp: number };

const base64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
const unbase64url = (said: string) =>
  Uint8Array.from(atob(said.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

const keys = new Map<string, Promise<CryptoKey>>();
const keyOf = (secret: string) => {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keys.set(secret, key);
  }
  return key;
};

async function sign(secret: string, said: Signed): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(said)));
  const mac = await crypto.subtle.sign("HMAC", await keyOf(secret), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(mac))}`;
}

/** What a grant or cookie says, if the key signed it, it's for `use` and `host`, and it's not past. */
async function verify(
  secret: string,
  token: string | undefined | null,
  use: Signed["use"],
  host: string,
) {
  const [body, mac] = (token ?? "").split(".");
  if (!body || !mac) return undefined;
  try {
    const good = await crypto.subtle.verify(
      "HMAC",
      await keyOf(secret),
      unbase64url(mac),
      encoder.encode(body),
    );
    if (!good) return undefined;
    const said = JSON.parse(decoder.decode(unbase64url(body))) as Signed;
    return said.use === use && said.host === host && said.exp > Date.now() / 1000
      ? said
      : undefined;
  } catch {
    return undefined;
  }
}

const touched = new Map<string, number>();
/** Says a computer is in use (its previews are being asked), at most every few seconds. */
function touch(runtime: Runtime, computer: string, hook: Wake) {
  if (!hook.touch || (touched.get(computer) ?? 0) > Date.now() - TOUCH_MS) return;
  touched.set(computer, Date.now());
  runtime.call(hook.touch, { computer }).catch(() => {});
}

/** The request's headers for the computer's server: not this connection's, nor the cookie's grant. */
function headersFor(request: Request, host: string): [string, string][] {
  const named = new Set(
    (request.headers.get("connection") ?? "").split(",").map((n) => n.trim().toLowerCase()),
  );
  const out: [string, string][] = [];
  request.headers.forEach((value, name) => {
    if (HOP.has(name) || named.has(name) || /^x-forwarded-(host|proto)$/.test(name)) return;
    if (name === "cookie") {
      const kept = value.split(/;\s*/).filter((c) => c && !c.startsWith(`${COOKIE}=`)).join("; ");
      if (kept) out.push([name, kept]);
      return;
    }
    out.push([name, value]);
  });
  out.push(["x-forwarded-host", host], ["x-forwarded-proto", schemeOf(host)]);
  return out;
}

/** What goes to the computer: the head, one JSON line, then the request's body as it comes. */
function bodyFor(head: HttpRequestHead, request: Request): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let headSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headSent) {
        headSent = true;
        controller.enqueue(encoder.encode(`${JSON.stringify(head)}\n`));
        return;
      }
      if (!request.body) return controller.close();
      // Read only once it's asked for: a computer found offline leaves the body for a retry.
      reader ??= request.body.getReader();
      const { done, value } = await reader.read();
      if (done) return controller.close();
      for (let i = 0; i < value.length; i += CHUNK) {
        controller.enqueue(value.subarray(i, i + CHUNK));
      }
    },
    cancel: (reason) => reader?.cancel(reason),
  });
}

/** The computer's answer: its head (the first line), and the rest, its body, as it comes. */
async function answerOf(output: ReadableStream<Uint8Array>) {
  const reader = output.getReader();
  let held = new Uint8Array(0);
  let ended = false;
  while (held.indexOf(10) < 0 && !ended) {
    const { done, value } = await reader.read();
    if (done) ended = true;
    else {
      const more = new Uint8Array(held.length + value.length);
      more.set(held);
      more.set(value, held.length);
      held = more;
      if (held.length > 1024 * 1024) throw new Error("its answer's head is too long");
    }
  }
  // Ended with no line: a head with no body, or a failure (one JSON value, `Failed`).
  const newline = held.indexOf(10);
  const end = newline < 0 ? held.length : newline;
  const head = JSON.parse(decoder.decode(held.subarray(0, end))) as
    | HttpResponseHead
    | { error?: { message?: string } };
  const rest = held.subarray(Math.min(end + 1, held.length));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (rest.length) controller.enqueue(rest);
    },
    async pull(controller) {
      const read = await reader.read();
      if (read.done) controller.close();
      else controller.enqueue(read.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { head, body };
}

/** Sends the request to the preview's computer (woken first, if it sleeps and can), and answers what it does. */
async function forward(
  request: Request,
  url: URL,
  runtime: Runtime,
  preview: Preview,
  host: string,
): Promise<Response> {
  const { hook } = configOf(runtime);
  const head: HttpRequestHead = {
    scope: { space: preview.space, folder: preview.folder, who: preview.who },
    port: preview.port,
    method: request.method,
    path: url.pathname + url.search,
    headers: headersFor(request, host),
  };
  const send = () =>
    runtime.workers.dispatch("computer", preview.computer, WORK.http, bodyFor(head, request), {
      signal: request.signal,
    });
  const offline = (error: unknown) => (error as { code?: string }).code === "offline";
  let job;
  try {
    job = await send();
  } catch (error) {
    if (!offline(error)) throw error;
    if (!hook.wake) return text(503, "This preview's computer is offline.");
    try {
      await runtime.call(hook.wake, { computer: preview.computer });
    } catch (why) {
      const said = why instanceof Error ? why.message : String(why);
      return text(503, `This preview's computer is offline, and didn't wake: ${said}`);
    }
    // Woken, it connects in a moment.
    for (const until = Date.now() + WAKE_MS; !job;) {
      try {
        job = await send();
      } catch (again) {
        if (!offline(again) || Date.now() > until || request.signal.aborted) {
          return text(503, "This preview's computer didn't wake in time: try again.");
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  touch(runtime, preview.computer, hook);
  job.done.catch(() => {});
  const { head: said, body } = await answerOf(job.output);
  if (!said || typeof said !== "object" || !("status" in said)) {
    await body.cancel().catch(() => {});
    const why = said && "error" in said ? said.error?.message : undefined;
    return text(502, `This preview's computer couldn't answer${why ? `: ${why}` : "."}`);
  }
  const headers = new Headers();
  for (const [name, value] of said.headers ?? []) {
    const lower = name.toLowerCase();
    if (!HOP.has(lower) && lower !== "content-length") headers.append(name, value);
  }
  // Answers that have no body, by their status or the method, send none.
  const bodiless = request.method === "HEAD" || [101, 103, 204, 205, 304].includes(said.status);
  if (bodiless) await body.cancel().catch(() => {});
  const status = Number.isInteger(said.status) && said.status >= 200 && said.status <= 599
    ? said.status
    : 502;
  return new Response(bodiless ? null : body, { status, headers });
}

/** Every request to a preview's host. */
async function servePreview(request: Request, served: Served): Promise<Response> {
  const { runtime, host } = served;
  const { settings } = configOf(runtime);
  const label = settings && labelOf(host, settings.domain);
  const preview = label
    ? await runtime.query<Preview | null>("preview.label", { label }).catch(() => null)
    : null;
  if (!settings || !preview) return text(404, "There's no preview here.");
  const url = new URL(request.url);
  if (url.pathname === LANDING) return await land(url, host, settings);
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return text(
      501,
      "Previews don't carry WebSockets yet, so live reload won't connect: reload the page by hand.",
    );
  }
  if (preview.visibility !== "link") {
    const allowed = await verify(settings.key, cookieOf(request, COOKIE), "cookie", host);
    if (!allowed) {
      if (!settings.app) {
        return text(500, "This app doesn't say where people sign in (previews.app).");
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return text(401, "Open this preview in your browser first, to be let in.");
      }
      const to = url.pathname + url.search;
      return redirect(
        `${settings.app}${GRANT}?host=${encodeURIComponent(host)}&to=${encodeURIComponent(to)}`,
      );
    }
  }
  return await forward(request, url, runtime, preview, host).catch((error) => {
    console.error("previews:", error instanceof Error ? error.message : error);
    return text(502, "This preview's computer couldn't answer.");
  });
}

/** On the preview's host: a grant from the app becomes the cookie, and the browser goes on. */
async function land(url: URL, host: string, settings: PreviewsSettings): Promise<Response> {
  const to = pathOn(url.searchParams.get("to") ?? "/");
  if (!to) return text(400, "A preview only goes on to its own pages.");
  const grant = await verify(settings.key, url.searchParams.get("g"), "grant", host);
  if (!grant) return text(403, "This link has expired: open the preview again.");
  const cookie = await sign(settings.key, {
    use: "cookie",
    host,
    person: grant.person,
    exp: Math.floor(Date.now() / 1000) + COOKIE_S,
  });
  const response = redirect(to);
  // Host-only (no Domain): the preview's alone, never its neighbours'.
  response.headers.set(
    "set-cookie",
    `${COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_S}`,
  );
  return response;
}

/** On the app: a signed-in member of the preview's space is sent back with a grant. */
async function grantPreview(request: Request, served: Served): Promise<Response> {
  const { runtime } = served;
  const { settings } = configOf(runtime);
  if (!settings) return text(404, "This app doesn't serve previews.");
  const url = new URL(request.url);
  const host = (url.searchParams.get("host") ?? "").toLowerCase();
  const to = pathOn(url.searchParams.get("to") ?? "/");
  // Only a preview's host of this domain gets a grant: never one elsewhere.
  const label = labelOf(host, settings.domain);
  if (!label || !to) return text(400, "That isn't a preview's address.");
  const preview = await runtime.query<Preview | null>("preview.label", { label });
  if (!preview) return text(404, "There's no such preview.");
  const actor: Actor | null = await served.whom().catch(() => null);
  const person = actor?.kind === "person" ? personOf(actor) : undefined;
  if (!actor || !person) {
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Sign in</title><p>Sign in to the app ` +
        `(<a href="/">here</a>), then open the preview's link again.</p>`,
      { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  const { can } = await runtime.call<{ can: boolean }>("space.can", {
    space: preview.space,
    verb: "read",
  }, { actor });
  if (!can) return text(403, "Only this space's members can open this preview.");
  const grant = await sign(settings.key, {
    use: "grant",
    host,
    person,
    exp: Math.floor(Date.now() / 1000) + GRANT_S,
  });
  const back = new URL(LANDING, previewUrl(settings.domain, label));
  back.searchParams.set("g", grant);
  back.searchParams.set("to", to);
  return redirect(back.href);
}

/** The pattern previews' hosts match, when the app serves them. */
const previewHosts = (resources: Resources) => {
  const domain = settingsOf({ resources }).previews?.domain;
  return domain ? `*-preview.${domain}` : undefined;
};

/** The web host's routes for previews (the `routes` resource). */
export const previewRoutes: Record<string, Route> = {
  "computer.previews": { host: previewHosts, serve: servePreview },
  "computer.previews.grant": { path: GRANT, methods: ["GET"], serve: grantPreview },
};
