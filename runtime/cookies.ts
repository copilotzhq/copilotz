/**
 * Cookies, as the runtime keeps them for plugins: a route reads, sets and
 * clears its credential's cookie through `ctx.cookies`, and `who` reads it;
 * no plugin writes `Set-Cookie` itself. What they guarantee:
 *
 * - **Names:** `__Host-<name>` wherever the cookie is Secure, always on the
 *   whole app (`Path=/`) and never with a `Domain`, so no other host under
 *   the same domain (a preview's, a sibling app's) can set one in its
 *   place. The plain name only over http to this machine or one on its
 *   network, where a browser drops Secure cookies. Secure or not goes by the
 *   site the browser asked for (`siteOf`), not the internal address.
 * - **Renamed by the app** (`resources.cookies`): `names` maps a name to the
 *   one it goes by (`{ session: "dir" }`), and `suffix` follows every other
 *   (`_<org>`): runtimes that share a host keep theirs apart, the runtime
 *   knowing nothing of why.
 * - **One plugin's each:** a name is the first plugin's to set or clear it;
 *   another may only when one of the two builds on the other (`requires`),
 *   as Google's sign-in sets identity's session, or both build on the same
 *   one (Google's and dev sign-in's, and the directory's sign-out, all set
 *   or clear identity's). Anything else is refused: a mistake in a plugin's
 *   code, so it throws, and the request is a 500.
 * - **Attributes:** always `HttpOnly`; `SameSite=Lax` unless the plugin asks
 *   for `Strict` (a site visitor's, which only the app's own pages send).
 *   Clearing a cookie goes by the same name and attributes.
 * - **Values:** up to 512 cookie-safe characters (letters, digits and
 *   `._~+/=-`), anything else refused; a cookie holding anything else reads
 *   as none. A credential's secret is its plugin's to make long (identity's
 *   sessions are); a value that's no secret (which org a browser is in) may
 *   be short.
 * - **Never kept:** a response that sets or clears one is `no-store`.
 */
import type { Cookies, Resources } from "./define.ts";
import { nearby } from "./site.ts";

/** A plugin's mistake with a cookie: its code's, so a 500, never the caller's. */
const wrong = (message: string) => new Error(message);

/** How the app renames cookies: by name, and a suffix for every other. */
export type CookieSettings = { names?: Record<string, string>; suffix?: string };

/** A cookie's name, before or after renaming: letters, digits, `-` and `_`. */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** What a cookie's value may be: plain characters, so it never ends the header. */
const VALUE = /^[A-Za-z0-9._~+/=-]{1,512}$/;

/** Whether a value is one a cookie can keep as it is. */
export const cookieSafe = (value: unknown): value is string =>
  typeof value === "string" && VALUE.test(value);

/** How long a cookie lasts, unless the plugin says: 30 days. */
const DAYS = 30;

/** What's wrong with the app's `cookies` resource, if anything (checked at start). */
export function cookiesProblem(settings: unknown): string | undefined {
  if (settings === undefined) return undefined;
  const { names, suffix } = (settings ?? {}) as CookieSettings;
  if (
    suffix !== undefined && (typeof suffix !== "string" || !/^[A-Za-z0-9_-]{0,40}$/.test(suffix))
  ) {
    return "cookies.suffix is letters, digits, - and _ (40 at most)";
  }
  for (const [name, renamed] of Object.entries(names ?? {})) {
    if (typeof renamed !== "string" || !NAME.test(renamed)) {
      return `cookies.names.${name} is letters, digits, - and _`;
    }
  }
  return undefined;
}

/** Whether cookies for a request to `site` are Secure: anywhere but plain http nearby. */
export const secureAt = (site: URL): boolean =>
  site.protocol === "https:" || !nearby(site.hostname);

/** The name a cookie goes by for a request to `site`, renamed as the app says. */
export function cookieName(site: URL, resources: Resources, name: string): string {
  if (!NAME.test(name)) throw wrong(`Cookie "${name}": its name is letters, digits, - and _`);
  const { names, suffix } = (resources.cookies ?? {}) as CookieSettings;
  const renamed = names?.[name] ?? `${name}${suffix ?? ""}`;
  if (!NAME.test(renamed)) throw wrong(`Cookie "${name}" is renamed to "${renamed}": not a name`);
  return `${secureAt(site) ? "__Host-" : ""}${renamed}`;
}

/** A cookie a request carries, by its full name. */
export const cookieOf = (request: Request, name: string): string | undefined =>
  request.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/** A `Set-Cookie` as the runtime writes it; `maxAge` 0 clears the cookie. */
const header = (
  site: URL,
  name: string,
  value: string,
  maxAge: number,
  sameSite: "lax" | "strict",
) =>
  `${name}=${value}; HttpOnly; SameSite=${sameSite === "strict" ? "Strict" : "Lax"}; Path=/; ` +
  `Max-Age=${maxAge}${secureAt(site) ? "; Secure" : ""}`;

/**
 * Which plugin set or cleared each name first, for a runtime, and whether two
 * plugins are related (one `requires` the other, or both the same one): only
 * a related plugin may set another's.
 */
export type CookieOwners = {
  owners: Map<string, string>;
  related(a: string, b: string): boolean;
};

/**
 * The cookies of a request to `site`, as `plugin`'s route keeps them: what it
 * reads, and the `Set-Cookie`s it made (`made`), for the runtime to put on
 * its response.
 */
export function cookiesFor(
  request: Request,
  site: URL,
  resources: Resources,
  plugin: string,
  { owners, related }: CookieOwners,
): Cookies & { made: string[] } {
  const made: string[] = [];
  const claim = (name: string) => {
    const owner = owners.get(name);
    if (owner === undefined) owners.set(name, plugin);
    else if (owner !== plugin && !related(owner, plugin)) {
      throw wrong(`Cookie "${name}" is ${owner}'s: ${plugin} can't set it too`);
    }
  };
  const sameSiteOf = (sameSite: unknown) => {
    if (sameSite !== undefined && sameSite !== "lax" && sameSite !== "strict") {
      throw wrong(`A cookie's sameSite is "lax" or "strict"`);
    }
    return (sameSite ?? "lax") as "lax" | "strict";
  };
  return {
    made,
    get: (name) => {
      const value = cookieOf(request, cookieName(site, resources, name));
      return cookieSafe(value) ? value : undefined;
    },
    set: (name, secret, options = {}) => {
      if (!cookieSafe(secret)) {
        throw wrong(`Cookie "${name}": its value is 1 to 512 cookie-safe characters`);
      }
      const days = options.days ?? DAYS;
      if (typeof days !== "number" || !(days > 0)) {
        throw wrong(`Cookie "${name}": days is a number over 0`);
      }
      const sameSite = sameSiteOf(options.sameSite);
      claim(name);
      made.push(
        header(
          site,
          cookieName(site, resources, name),
          secret,
          Math.round(days * 86_400),
          sameSite,
        ),
      );
    },
    clear: (name, options = {}) => {
      const sameSite = sameSiteOf(options.sameSite);
      claim(name);
      made.push(header(site, cookieName(site, resources, name), "", 0, sameSite));
    },
  };
}

/** A cookie-reading view for `who`: `get` alone. */
export function cookieReader(
  request: Request,
  site: URL,
  resources: Resources,
): Pick<Cookies, "get"> {
  return {
    get: (name) => {
      const value = cookieOf(request, cookieName(site, resources, name));
      return cookieSafe(value) ? value : undefined;
    },
  };
}

/**
 * A response with these `Set-Cookie`s on it, never kept (`no-store`). Its
 * headers change in place when they can (a WebSocket's acceptance is that
 * very response); a response whose headers can't change is copied.
 */
export function withCookies(response: Response, made: string[]): Response {
  if (!made.length) return response;
  try {
    for (const cookie of made) response.headers.append("set-cookie", cookie);
    response.headers.set("cache-control", "no-store");
    return response;
  } catch {
    const headers = new Headers(response.headers);
    for (const cookie of made) headers.append("set-cookie", cookie);
    headers.set("cache-control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
