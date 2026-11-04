/**
 * Who a browser is, and how people sign in, as the app's plugins declare
 * them and the web host answers them. The host keeps every cookie: it reads
 * them, sets them (httpOnly, so the page's code never sees them; `Secure`
 * anywhere but this machine over http) and clears them; plugins see only
 * the secret a cookie holds, and say who it is.
 *
 * - **Entrances** (the `entrances` resource, by name): each is a cookie and
 *   the query that says who its secret is (`{ secret }` in, an actor or null
 *   out, asked as the system). The identity plugin declares people's
 *   sessions (`session`); the contacts plugin, the visitors of its web
 *   lines. A request is whoever the first entrance, in order, says it is.
 *   One may let a newcomer in (`arrive`): asked to connect without a cookie
 *   that's anyone (`POST /connect`), it makes them someone and gives the
 *   secret the host keeps in its cookie, or refuses (a limit), or passes.
 * - **Sign-in** (the `signIn` resource, by name: `POST /signin/<name>`): an
 *   Action, called as the system with the request's JSON, that answers a
 *   person and a session; the host keeps the session in its entrance's
 *   cookie. Google sign-in declares `google`; dev sign-in, `dev` (this
 *   machine only: `local`). What the page's sign-in shows of each is its
 *   `page` (Google's client id, for its button).
 * - **From the app's page only:** a browser says where a request comes from
 *   (`Origin`, `Sec-Fetch-Site`), and connecting, signing in and out from
 *   any other site is refused, so another site can't make its visitors
 *   arrive here, nor sign anyone in as someone else.
 *
 * ```ts
 * resources: {
 *   entrances: { session: { cookie: "session", query: "credential.actor", end: "session.end" } },
 *   signIn: { google: { action: "google.sign-in", page: (r) => ({ clientId: r.google.clientId }) } },
 * }
 * ```
 */
import type { Actor, Resources, Runtime } from "../../runtime/mod.ts";
import { type Front, hostOf } from "./routes.ts";

/** One way a browser is someone: a cookie, and who its secret is. */
export type Entrance = {
  /** The cookie it reads: letters, digits, `-` and `_`. */
  cookie: string;
  /** Who its secret is: a query (`<collection>.<query>`), given `{ secret }`, answering an actor or null. */
  query: string;
  /**
   * A newcomer coming in, on `POST /connect` without a cookie that's anyone:
   * who they are now, and the secret for the cookie (kept `days`, 30 unless
   * said); nothing, to let the next entrance decide; or a refusal, thrown (a
   * `failure`: `too_many` is a 429, its message said when it's public). It's
   * given the request (its headers say who calls, as the app's front does)
   * and what the page asked (`asked`: `/connect`'s JSON, `web({ arrive })`).
   */
  arrive?(
    request: Request,
    door: Door,
  ): Arrived | null | undefined | Promise<Arrived | null | undefined>;
  /** Ends what its secret is, on `POST /signout`: an Action, called as its actor with `{ secret }`. */
  end?: string;
  /** Where it's asked among the others, lower first (0 unless said); then by name. */
  order?: number;
  /**
   * The cookie's `SameSite`: `lax` (the default: it comes along when another
   * site links here, as an OAuth provider's redirect does) or `strict` (only
   * from the app's own pages).
   */
  sameSite?: "lax" | "strict";
  /**
   * Its cookie is this host's alone: named `__Host-<cookie>` wherever it's
   * Secure, so no other host under the same domain (a preview's, a sibling
   * app's) can set one in its place, to make a browser someone it chose.
   * Over http on this machine, where nothing's Secure, it's its plain name.
   */
  hostOnly?: boolean;
};

/** What an entrance letting someone in is given. */
export type Door = {
  runtime: Runtime;
  /** What the page asked for coming in (`/connect`'s JSON object; `{}` when none). */
  asked: Record<string, unknown>;
  /** The host the request is for, as the app's front says. */
  host: string;
};

/** Someone let in: who, and the secret their cookie keeps, for `days` (30 unless said). */
export type Arrived = { actor: Actor; secret: string; days?: number };

/** One way to sign in: `POST /signin/<name>`. */
export type SignIn = {
  /** Signs someone in: called as the system with the request's JSON; answers `{ person, session }`. */
  action: string;
  /** From this machine only (a loopback address): for trying things out. */
  local?: boolean;
  /** What the page's sign-in shows of it (plain JSON), or a function of the app's resources. */
  page?: Record<string, unknown> | ((resources: Resources) => Record<string, unknown> | undefined);
  /** The entrance whose cookie keeps the session (`session` unless said). */
  entrance?: string;
};

/** A cookie a request carries, by name. */
export const cookieOf = (request: Request, name: string): string | undefined =>
  request.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

export const loopback = (url: URL): boolean =>
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

/** Whether the host's cookies are Secure for a request: anywhere but this machine over http. */
const secure = (url: URL) => url.protocol === "https:" || !loopback(url);

/**
 * A cookie as the host sets it: httpOnly, on the whole app, Secure unless
 * this is the machine itself over http. `maxAge` 0 clears it.
 */
export const setCookie = (
  url: URL,
  value: string,
  maxAge: number,
  name: string,
  sameSite: "lax" | "strict" = "lax",
): string =>
  `${name}=${value}; HttpOnly; SameSite=${sameSite === "strict" ? "Strict" : "Lax"}; Path=/; ` +
  `Max-Age=${maxAge}${secure(url) ? "; Secure" : ""}`;

/**
 * Whether a request comes from the app's own page. A browser says where a
 * request is from: `Sec-Fetch-Site`, and `Origin` (on every cross-site
 * request, and every POST), which must be this host (as the app's front says
 * it), over https anywhere but this machine. Without either, it's not a
 * browser's (or an old one's), and nothing a site does can send it.
 */
export function fromPage(request: Request, front?: Front): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  let from: URL;
  try {
    from = new URL(origin);
  } catch {
    return false;
  }
  if (from.origin !== origin) return false;
  if (from.protocol !== "https:" && !(from.protocol === "http:" && loopback(from))) return false;
  return from.host === hostOf(request, front);
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** What a cookie's value may be: plain characters, so it never ends the header. */
const SECRET = /^[A-Za-z0-9._~+/=-]{16,512}$/;

/** Whether a secret is one a cookie can keep as it is. */
export const cookieSafe = (secret: unknown): secret is string =>
  typeof secret === "string" && SECRET.test(secret);

/** A runtime's entrances, checked, in the order they're asked. */
export function entrancesOf(runtime: Runtime): (Entrance & { name: string })[] {
  const declared = (runtime.describe().resources.entrances ?? {}) as Record<
    string,
    Entrance | null
  >;
  const found: (Entrance & { name: string })[] = [];
  const cookies = new Set<string>();
  for (const [name, entrance] of Object.entries(declared)) {
    if (!entrance) continue;
    if (typeof entrance.cookie !== "string" || !NAME.test(entrance.cookie)) {
      throw new Error(`entrances.${name}: its cookie is letters, digits, - and _`);
    }
    if (cookies.has(entrance.cookie)) {
      throw new Error(`entrances.${name}: another entrance reads the cookie "${entrance.cookie}"`);
    }
    cookies.add(entrance.cookie);
    if (typeof entrance.query !== "string" || !/^[\w-]+\.[\w-]+$/.test(entrance.query)) {
      throw new Error(`entrances.${name}: its query is <collection>.<query>`);
    }
    if (entrance.arrive !== undefined && typeof entrance.arrive !== "function") {
      throw new Error(`entrances.${name}: its arrive is a function`);
    }
    if (entrance.end !== undefined && typeof entrance.end !== "string") {
      throw new Error(`entrances.${name}: its end is an Action's name`);
    }
    if (entrance.sameSite !== undefined && !["lax", "strict"].includes(entrance.sameSite)) {
      throw new Error(`entrances.${name}: its sameSite is lax or strict`);
    }
    if (entrance.hostOnly !== undefined && typeof entrance.hostOnly !== "boolean") {
      throw new Error(`entrances.${name}: its hostOnly is true or false`);
    }
    found.push({ ...entrance, name });
  }
  return found.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.name < b.name ? -1 : 1));
}

/** A runtime's ways to sign in, checked, by name. */
export function signInsOf(
  runtime: Runtime,
  entrances: { name: string }[],
): Map<string, SignIn & { entrance: string }> {
  const declared = (runtime.describe().resources.signIn ?? {}) as Record<string, SignIn | null>;
  const found = new Map<string, SignIn & { entrance: string }>();
  for (const [name, method] of Object.entries(declared)) {
    if (!method) continue;
    if (!/^[a-z0-9-]{1,40}$/.test(name)) {
      throw new Error(`signIn.${name}: its name is lowercase letters, digits and -`);
    }
    if (typeof method.action !== "string" || !method.action) {
      throw new Error(`signIn.${name}: its action is an Action's name`);
    }
    const entrance = method.entrance ?? "session";
    if (!entrances.some((e) => e.name === entrance)) {
      throw new Error(`signIn.${name}: no entrance "${entrance}" keeps its session`);
    }
    found.set(name, { ...method, entrance });
  }
  return found;
}

/** What the page's sign-in shows of each way to sign in, by name. */
export function signInPage(runtime: Runtime): Record<string, Record<string, unknown>> {
  const resources = runtime.describe().resources;
  const methods = signInsOf(runtime, entrancesOf(runtime));
  return Object.fromEntries(
    [...methods].flatMap(([name, method]) => {
      const page = typeof method.page === "function" ? method.page(resources) : method.page ?? {};
      return page ? [[name, page]] : [];
    }),
  );
}

/** Whether something an entrance answered is an actor. */
const actorish = (value: unknown): value is Actor =>
  !!value && typeof value === "object" &&
  typeof (value as Actor).kind === "string" && !!(value as Actor).kind &&
  typeof (value as Actor).id === "string" && !!(value as Actor).id;

/** How a host reads who a request is. */
export type Whom = {
  /** Who a request is, by the first entrance whose cookie is someone; null: nobody. */
  (request: Request): Promise<Actor | null>;
  entrances: (Entrance & { name: string })[];
  /** The name an entrance's cookie goes by here, for a request to `url`. */
  named(entrance: Entrance, url: URL): string;
};

/**
 * Who requests are, by a runtime's entrances. `cookie` names a declared
 * cookie here (a host serving many orgs keeps each org's apart).
 */
export function whomOf(runtime: Runtime, cookie: (name: string) => string = (n) => n): Whom {
  const entrances = entrancesOf(runtime);
  const named = (entrance: Entrance, url: URL) =>
    `${entrance.hostOnly && secure(url) ? "__Host-" : ""}${cookie(entrance.cookie)}`;
  const whom = async (request: Request): Promise<Actor | null> => {
    const url = new URL(request.url);
    for (const entrance of entrances) {
      const actor = await recognise(runtime, entrance, cookieOf(request, named(entrance, url)));
      if (actor) return actor;
    }
    return null;
  };
  return Object.assign(whom, { entrances, named });
}

/**
 * Who an entrance's secret is, if anyone. A secret that isn't one a cookie
 * could hold is no one, unasked; the query failing (the store away) throws,
 * so a good cookie is never taken for a stale one and cleared.
 */
export async function recognise(
  runtime: Runtime,
  entrance: Entrance,
  secret: string | undefined,
): Promise<Actor | null> {
  if (!secret || !SECRET.test(secret)) return null;
  const actor = await runtime.query<unknown>(entrance.query, { secret });
  return actorish(actor) ? actor : null;
}

/** The most a JSON body to the host may be: a sign-in's token, what a page asks coming in. */
const BODY = 16_384;

/** A request's JSON object (`{}` with no body); undefined when it's too large or not one. */
export async function jsonOf(request: Request): Promise<Record<string, unknown> | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > BODY) return undefined;
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > BODY) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  if (!size) return {};
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A refusal's status, by its code. */
const STATUS: Record<string, number> = {
  too_many: 429,
  forbidden: 403,
  invalid: 400,
  not_found: 404,
  unauthorized: 401,
};

/** An error as the host answers it: its code's status, its words only when they're for anyone. */
export function refusal(error: unknown, fallback: string): { status: number; error: string } {
  const { code, public: open } = (error ?? {}) as { code?: string; public?: boolean };
  const status = (code && STATUS[code]) || 500;
  const said = open === true && error instanceof Error && error.message ? error.message : fallback;
  if (status === 500) console.error(`${fallback}:`, error instanceof Error ? error.message : error);
  return { status, error: said.slice(0, 300) };
}

/**
 * Coming in: who the request is, by its cookies; else, someone an entrance
 * lets in now. The cookies to set go with it: a newcomer's, and a clearing
 * for each cookie that turned out to be no one (forged, or ended).
 */
export async function arriving(
  runtime: Runtime,
  whom: Whom,
  request: Request,
  door: Door,
): Promise<
  { actor: Actor; cookies: string[] } | { actor: null; cookies: string[] }
> {
  const url = new URL(request.url);
  const stale: { name: string; sameSite?: "lax" | "strict" }[] = [];
  for (const entrance of whom.entrances) {
    const name = whom.named(entrance, url);
    const secret = cookieOf(request, name);
    if (secret === undefined) continue;
    const actor = await recognise(runtime, entrance, secret);
    if (actor) return { actor, cookies: [] };
    stale.push({ name, ...(entrance.sameSite ? { sameSite: entrance.sameSite } : {}) });
  }
  const clear = (except?: string) =>
    stale.filter((s) => s.name !== except).map((s) => setCookie(url, "", 0, s.name, s.sameSite));
  for (const entrance of whom.entrances) {
    if (!entrance.arrive) continue;
    const arrived = await entrance.arrive(request, door);
    if (!arrived) continue;
    if (!actorish(arrived.actor) || !cookieSafe(arrived.secret)) {
      throw new Error(
        `entrances.${entrance.name}: arrive answered no actor, or a secret unfit for a cookie`,
      );
    }
    const days = arrived.days ?? 30;
    const name = whom.named(entrance, url);
    return {
      actor: arrived.actor,
      cookies: [
        ...clear(name),
        setCookie(url, arrived.secret, Math.round(days * 86_400), name, entrance.sameSite),
      ],
    };
  }
  return { actor: null, cookies: clear() };
}
