/**
 * The directory's HTTP, in words its routes share: its cookies' names, how
 * it answers, and requests it makes of an org on someone's behalf.
 *
 * - **Cookies**, by the names the directory's runtime gives them
 *   (`__Host-` wherever they're Secure): its session (identity's `session`,
 *   which the directory runtime names `dir`), the org a browser is in
 *   (`org`), and each org's session (`s_<org>`, the name that org's runtime
 *   gives identity's `session`, see member.ts). Today's names, so nobody
 *   signs in again.
 */
import { clientAddress, type Runtime, type Runtimes, setClientAddress } from "copilotz";
import { settingsOf } from "./settings.ts";

/** The directory's session: identity's, which the directory's runtime names `dir`. */
export const SESSION = "session";
/** Which org a browser is in. */
export const CURRENT = "org";
/** An org's session, as its runtime names identity's (`s_<org>`). */
export const sessionOf = (org: string) => `s_${org}`;
/** An org's session cookie's name, when its id can be in one (a cookie's name may hold little). */
export const orgCookie = (org: string): string | undefined =>
  /^[A-Za-z0-9_-]{1,62}$/.test(org) ? sessionOf(org) : undefined;

/** The orgs a request holds a session for, by its cookies' names (`s_<org>`, `__Host-` or not). */
export const heldOrgs = (request: Request): string[] => [
  ...new Set(
    (request.headers.get("cookie") ?? "").split(/;\s*/).flatMap((pair) => {
      const found = /^(?:__Host-)?s_([A-Za-z0-9_-]{1,62})=/.exec(pair);
      return found ? [found[1]] : [];
    }),
  ),
];
/** An org's address: `/o/<org>`, where its page, its socket and its webhooks are. */
export const baseOf = (org: string) => `/o/${encodeURIComponent(org)}`;
/** Where the front asks whose a host is. */
export const RESOLVE = "/__copilotz/hosts/resolve";

/** What the directory answers in JSON is someone's: never kept. */
export const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * Whether a GET is a browser navigating (`Sec-Fetch-Mode: navigate`), or,
 * from one that doesn't say, one asking for a page (`Accept` with HTML).
 */
export function navigating(request: Request): boolean {
  if (request.method !== "GET") return false;
  const mode = request.headers.get("sec-fetch-mode");
  if (mode !== null) return mode === "navigate";
  return /text\/html/.test(request.headers.get("accept") ?? "");
}

/** The orgs' runtimes the app gave the directory. */
export function orgsOf(runtime: Pick<Runtime, "describe">): Runtimes {
  const orgs = settingsOf({ resources: runtime.describe().resources }).orgs;
  if (!orgs) {
    throw new Error("directory: give it the orgs' runtimes (directory.orgs: runtimes(open))");
  }
  return orgs;
}

/** Headers a browser sets that say where a request comes from: not the directory's to pass on. */
const ITS_OWN = /^(?:origin|referer|sec-fetch-.+|content-type|content-length)$/;

/**
 * A request the directory makes of an org for someone (entering it): on the
 * same site, with their cookies and the front's headers, from the address
 * they came from; never with where their browser said it came from (the
 * directory's own, not another site's).
 */
export function onBehalf(request: Request, path: string): Request {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!ITS_OWN.test(name)) headers.set(name, value);
  }
  const made = new Request(new URL(path, request.url), { method: "POST", headers });
  const address = clientAddress(request);
  if (address) setClientAddress(made, address);
  return made;
}
