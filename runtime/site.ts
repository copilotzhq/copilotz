/**
 * The site a request is for, and whether another site sent it: what
 * `runtime.fetch` decides once, before it dispatches anything.
 *
 * - **The front.** An app behind a front of its own (a Cloudflare worker)
 *   reaches the runtime at an internal address. The front vouches for a
 *   request with its secret (`x-copilotz-front`), the same secret it gives
 *   callers' addresses with (`resources.caller.front`, see caller.ts); then
 *   the host it forwards (`x-forwarded-host`) is the request's. Without the
 *   secret, forwarded headers are anyone's, and ignored. Routes see the
 *   request with the front's header as it came (a plugin counting callers by
 *   address checks it, `callerFrom`); one passing a request on drops it.
 * - **The site** (`siteOf`): the address as the browser asked for it, on the
 *   host the front says. Routes match it, and cookies are named and secured
 *   by it.
 * - **The app's own hosts** (`resources.hosts`, patterns: `app.example.com`,
 *   `*.run.app`): when the app names them, a request to any other host is
 *   answered only by routes that take its host (a preview's, or `*` for
 *   every other host: the hosts a directory's orgs claimed), never by the
 *   app's paths; and the app's own are never a host route's. Unnamed, every
 *   host is the app's, but a host route still takes the hosts it names (a
 *   preview's), and one for every other host (`*`) takes none.
 * - **Other sites** (`crossSite`): a browser says where a request comes from
 *   (`Origin` on every POST, `Sec-Fetch-Site`). A request that may change
 *   something (anything but GET, HEAD and OPTIONS), sent from a page of
 *   another site, is refused unless it carries its own credential
 *   (`Authorization`, which no other site can make a browser send). So
 *   another site can't make its visitors arrive here, sign them in as
 *   someone it chose, or act with their cookies. Webhooks (Meta, Twilio,
 *   Stripe) send no `Origin`, and pass.
 */
import { loopbackAddress } from "./address.ts";

/** The header the app's front carries its secret in. */
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
export const vouched = (request: Request, secret: string | undefined): boolean => {
  const said = request.headers.get(FRONT);
  return !!secret && said !== null && same(said, secret);
};

/**
 * The address a request is for, as its browser asked for it: its URL, on
 * the host the front says when the front vouches for it. A front's request
 * is for a public host, though it reaches the app at a private address.
 */
export function siteOf(request: Request, secret: string | undefined): URL {
  const url = new URL(request.url);
  const host = vouched(request, secret)
    ? request.headers.get("x-forwarded-host")?.split(",")[0].trim().toLowerCase()
    : undefined;
  if (!host || host === url.host) return url;
  try {
    const said = new URL(`http://${host}`);
    url.hostname = said.hostname;
    url.port = said.port;
  } catch {
    // Not a host at all: the front's word is no one's.
  }
  return url;
}

/**
 * The `hosts` resource: the app's own hosts, an entry each (a pattern, see
 * `hostMatches`): `{ "app.example.com": true, "*.run.app": true }`. A later
 * plugin adds one, or takes one away with `null`, as with any resource.
 */
export type HostsSettings = Record<string, true>;

/** A host pattern: a host (and maybe a port), or `*` then the rest of one (`*.run.app`). */
const HOST = /^\*?[a-z0-9.-]+(:\d{1,5})?$/;

const HOSTS_EXAMPLE = '{ "app.example.com": true, "*.run.app": true }';

/** What's wrong with the app's `hosts` resource, if anything (checked at start). */
export function hostsProblem(hosts: unknown): string | undefined {
  if (hosts === undefined) return undefined;
  if (
    typeof hosts !== "object" || hosts === null || Array.isArray(hosts) ||
    !Object.keys(hosts).length
  ) {
    return `hosts names the app's own hosts, an entry each: ${HOSTS_EXAMPLE}`;
  }
  for (const [pattern, own] of Object.entries(hosts)) {
    if (own !== true) {
      return `hosts: "${pattern}" is true, one of the app's own hosts (not ${
        JSON.stringify(own)
      }): ${HOSTS_EXAMPLE}`;
    }
    if (!HOST.test(pattern)) {
      return `hosts: "${pattern}" isn't a host (app.example.com), nor * and the rest of one (*.run.app)`;
    }
  }
  return undefined;
}

/**
 * Whether a host matches a pattern: exactly, or `*<suffix>` for any one
 * first label then the suffix (`*.run.app`: `x.run.app`, not `a.b.run.app`).
 * Without a port in the pattern, the host's is ignored. Case doesn't matter.
 */
export function hostMatches(pattern: string, host: string): boolean {
  const wanted = pattern.toLowerCase();
  const plain = host.toLowerCase().replace(/\.$/, "");
  const asked = /:\d+$/.test(wanted) ? plain : plain.replace(/:\d+$/, "");
  if (!wanted.startsWith("*")) return asked === wanted;
  const suffix = wanted.slice(1);
  const first = asked.slice(0, asked.length - suffix.length);
  return asked.endsWith(suffix) && first.length > 0 && !first.includes(".");
}

/**
 * Whether a host is the app's own, as its `hosts` resource names them:
 * undefined when it names none (every host is then the app's).
 */
export function ownHost(hosts: unknown, host: string): boolean | undefined {
  if (!hosts || typeof hosts !== "object") return undefined;
  return Object.keys(hosts).some((pattern) => hostMatches(pattern, host));
}

/** Whether a host name is this machine's own: `localhost`, 127.0.0.0/8, `::1`. */
export const loopback = (hostname: string): boolean =>
  hostname.toLowerCase() === "localhost" || loopbackAddress(hostname);

/**
 * Whether a host name is this machine's or one on its network: loopback, a
 * private or link-local address (10/8, 172.16/12, 192.168/16, 169.254/16,
 * fc00::/7, fe80::/10), or a `.local` name. Plain http there is a LAN's.
 */
export function nearby(hostname: string): boolean {
  const name = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (loopback(name) || name.endsWith(".local")) return true;
  const four = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(name);
  if (four) {
    const [a, b] = [Number(four[1]), Number(four[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254);
  }
  if (!name.includes(":")) return false;
  const first = parseInt(name.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/** Methods that change nothing, which any site may send. */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a request is another site's, and refused: it may change something
 * (not GET, HEAD or OPTIONS), carries no `Authorization`, and its browser
 * says it comes from elsewhere: `Sec-Fetch-Site` other than `same-origin`
 * (or `none`, typed by the person), or an `Origin` that isn't `site`'s host
 * over https (http only to this machine or one on its network). A sibling
 * host under the same domain is another site. Without either header, it's
 * not a browser's (or an old one's), and nothing a page does can send it.
 */
export function crossSite(request: Request, site: URL): boolean {
  if (SAFE.has(request.method) || request.headers.has("authorization")) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  let from: URL;
  try {
    from = new URL(origin);
  } catch {
    return true;
  }
  if (from.origin !== origin) return true;
  if (from.protocol !== "https:" && !(from.protocol === "http:" && nearby(from.hostname))) {
    return true;
  }
  return from.host !== site.host;
}
