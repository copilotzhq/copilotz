/**
 * Plugins' routes, as `runtime.fetch` matches them. Each key is a
 * `URLPattern`: a pathname (`/hooks/whatsapp/:name`), or a whole pattern
 * with a host (`https://*-preview.example.com/:path*`), which takes every request to a host it
 * matches, whatever its path.
 *
 * **The order a request is matched in**, the same every time:
 * 1. Routes with a host, before anything else (the runtime's own paths
 *    included): a host a route takes is that route's alone. A host with no
 *    wildcard comes first, then the longer pattern. One for every host (its
 *    hostname `*`) takes only the hosts that aren't the app's own (see
 *    site.ts, `hosts`): with none named, none.
 * 2. Routes by pathname, the more specific first, segment by segment from
 *    the left: at the first segment where two differ in kind, a literal one
 *    (`/google`) comes before one with a parameter (`/:name`), which comes
 *    before one with a wildcard (`/*`); a pattern that goes deeper comes
 *    before one it's a start of. So `/api/views` before `/api/*`,
 *    `/mcp/:name` before `/mcp/*`, and the catch-all `/*` last of all.
 * 3. Among patterns alike, the order plugins declare them in.
 */
import type { Route } from "./define.ts";
import { invalid } from "./errors.ts";

/** A route, as the runtime keeps it: its pattern, compiled, and whose it is. */
export type RouteEntry = {
  key: string;
  plugin: string;
  route: Route;
  pattern: URLPattern;
  /** Whether it takes a host, whatever the path. */
  host: boolean;
  /** A host route for every host (`*`): only the hosts that aren't the app's own. */
  others: boolean;
};

/** The paths the runtime answers itself, which no plugin's route takes: and all under `/api/`. */
export const OWN = ["/connect", "/oxian", "/api"];

/** How specific a segment is: a literal 3, with a parameter 2, with a wildcard 1. */
const rankOf = (segment: string) => /\*/.test(segment) ? 1 : /[:({]/.test(segment) ? 2 : 3;

/** Which of two pathname patterns comes first: negative when `a` does. */
function specific(a: string, b: string): number {
  const [x, y] = [a.split("/").slice(1).map(rankOf), b.split("/").slice(1).map(rankOf)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return y[i] - x[i];
  }
  return y.length - x.length;
}

/** Plugins' routes, compiled and in the order they're matched (checked: a bad key stops the start). */
export function routeTable(
  routes: Record<string, { route: Route; plugin: string }>,
): RouteEntry[] {
  const hosts: RouteEntry[] = [];
  const paths: RouteEntry[] = [];
  for (const [key, { route, plugin }] of Object.entries(routes)) {
    if (typeof route !== "function") throw invalid(`${plugin}: routes["${key}"] is a function`);
    const host = key.includes("://");
    if (!host && !key.startsWith("/")) {
      throw invalid(`${plugin}: routes["${key}"] is a pathname ("/…") or a whole URL pattern`);
    }
    if (!host && (OWN.includes(key) || key.startsWith("/api/"))) {
      throw invalid(`${plugin}: routes["${key}"] is the runtime's own path`);
    }
    let pattern: URLPattern;
    try {
      pattern = host ? new URLPattern(key) : new URLPattern({ pathname: key });
    } catch (error) {
      throw invalid(
        `${plugin}: routes["${key}"] isn't a URL pattern (${(error as Error).message})`,
      );
    }
    (host ? hosts : paths).push({
      key,
      plugin,
      route,
      pattern,
      host,
      others: host && pattern.hostname === "*",
    });
  }
  hosts.sort((a, b) =>
    Number(a.pattern.hostname.includes("*")) - Number(b.pattern.hostname.includes("*")) ||
    b.key.length - a.key.length
  );
  paths.sort((a, b) => specific(a.key, b.key));
  return [...hosts, ...paths];
}

/** A match's parameters: every group the URL filled in, the path's (and a host route's, its host's). */
function paramsOf(result: URLPatternResult, host: boolean): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of host ? [result.hostname, result.pathname] : [result.pathname]) {
    for (const [name, value] of Object.entries(part.groups)) {
      if (value !== undefined) params[name] = value;
    }
  }
  return params;
}

/**
 * The first route that takes `url` (a host route only when `hosts`), and its
 * parameters. A host route for every host only when `others`: the host isn't
 * the app's own.
 */
export function matchRoute(
  table: RouteEntry[],
  url: URL,
  options: { hosts: boolean; others?: boolean },
): { entry: RouteEntry; params: Record<string, string> } | undefined {
  for (const entry of table) {
    if (entry.host !== options.hosts) continue;
    if (entry.others && !options.others) continue;
    const result = entry.host
      ? entry.pattern.exec(url.href)
      : entry.pattern.exec({ pathname: url.pathname });
    if (result) return { entry, params: paramsOf(result, entry.host) };
  }
  return undefined;
}
