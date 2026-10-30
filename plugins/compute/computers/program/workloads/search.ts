/**
 * A web search from the computer, with no API key: DuckDuckGo's HTML page,
 * fetched and read into `{ title, url, snippet }`, its redirect links turned
 * back into the real ones. When the fetch is turned away (or the page has no
 * results), the same search goes through the browser, if there is one.
 *
 * The fetch says what it is (`copilotz-computer/<version>`), over HTTP/1.1
 * with `node:http(s)`. DuckDuckGo turned away every search Deno's `fetch`
 * sent, whatever user agent it gave (its HTTP/2 and TLS give it away),
 * while the same POST over `node:https` came back with results under Deno,
 * Node and Bun alike, as did curl's, Node's and Bun's own.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import process from "node:process";
import type { SearchInput, SearchResult } from "../../shared/workloads.ts";
import { VERSION } from "../version.ts";
import { fail } from "./answer.ts";

/** Where searches go, unless `COPILOTZ_SEARCH_URL` (or an option) says otherwise. */
export const SEARCH_URL = "https://html.duckduckgo.com/html/";

/** The same search in the browser: its results, and whether it was turned away there too. */
export type BrowserSearch = (
  input: SearchInput & { query: string; limit: number },
  signal?: AbortSignal,
) => Promise<{ results: SearchResult[]; blocked: boolean }>;

/** Who the fetch says it is: itself, not a browser it isn't. */
export const AGENT = `copilotz-computer/${VERSION}`;

/** The most of a page it reads. */
const MOST = 2 * 1024 * 1024;

/** POSTs `form` to `url` over HTTP/1.1: its status, and its page as text. */
function post(url: string, form: URLSearchParams, signal: AbortSignal) {
  const target = new URL(url);
  const send = target.protocol === "https:"
    ? httpsRequest
    : target.protocol === "http:"
    ? httpRequest
    : fail(`A search URL is http(s), not ${target.protocol}`);
  const body = new TextEncoder().encode(form.toString());
  return new Promise<{ status: number; html: string }>((resolve, reject) => {
    signal.throwIfAborted();
    const request = send(target, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
        "user-agent": AGENT,
        accept: "text/html",
        "accept-language": "en-US,en;q=0.9",
      },
    }, (response) => {
      let html = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        html += chunk;
        if (html.length > MOST) request.destroy(new Error("The search page is too large"));
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, html }));
      response.on("error", reject);
    });
    const abort = () => request.destroy(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    request.on("close", () => signal.removeEventListener("abort", abort));
    request.on("error", reject);
    request.end(body);
  });
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#x27": "'",
  "#39": "'",
};

/** HTML as plain text: tags out, entities decoded, spaces collapsed. */
function plain(html: string) {
  return html.replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      const lower = name.toLowerCase();
      if (ENTITIES[lower]) return ENTITIES[lower];
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
      return whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** A result's link as it really is: DuckDuckGo's `/l/?uddg=` redirects undone; its ads, none. */
function real(href: string, base: string): string | undefined {
  let url: URL;
  try {
    url = new URL(plain(href), base);
  } catch {
    return undefined;
  }
  const target = url.searchParams.get("uddg");
  if (target) return target;
  if (/(^|\.)duckduckgo\.com$/.test(url.hostname) && url.pathname.startsWith("/y.js")) {
    return undefined;
  }
  return url.href;
}

/** The results in a DuckDuckGo HTML page, in order. */
export function parseResults(html: string, base = SEARCH_URL): SearchResult[] {
  const results: SearchResult[] = [];
  let last: SearchResult | undefined;
  // Each result's link (`result__a`), and its snippet (`result__snippet`) after it.
  const marked =
    /<(a|div|span|td)\b([^>]*\bclass\s*=\s*["'][^"']*\bresult__(a|snippet)\b[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const [, , attributes, kind, inner] of html.matchAll(marked)) {
    if (kind === "a") {
      const href = /\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'/i.exec(attributes);
      const url = href ? real(href[1] ?? href[2], base) : undefined;
      last = url ? { title: plain(inner), url, snippet: "" } : undefined;
      if (last) results.push(last);
    } else if (last && !last.snippet) {
      last.snippet = plain(inner);
    }
  }
  return results;
}

/** Whether a page is DuckDuckGo turning a robot away. */
export const turnedAway = (html: string) =>
  /anomaly-modal|challenge-form|g-recaptcha|are you a human|bots use DuckDuckGo/i.test(html);

/** Searches the web: `limit` results (8 unless asked), by fetch, else through the browser. */
export async function search(
  input: SearchInput,
  options: { url?: string; browser?: BrowserSearch; signal?: AbortSignal } = {},
): Promise<SearchResult[]> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) fail("query is required");
  const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(input.limit!, 25)) : 8;
  const url = options.url ?? process.env.COPILOTZ_SEARCH_URL ?? SEARCH_URL;
  const signal = AbortSignal.any([
    AbortSignal.timeout(20_000),
    ...options.signal ? [options.signal] : [],
  ]);
  let blocked = false;
  try {
    const { status, html } = await post(url, new URLSearchParams({ q: query, b: "" }), signal);
    const results = parseResults(html, url);
    if (results.length) return results.slice(0, limit);
    blocked = status < 200 || status > 299 || status === 202 || turnedAway(html);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    blocked = true;
  }
  if (options.browser) {
    try {
      // The browser has its own deadline; the fetch's has passed or nearly.
      const found = await options.browser({ ...input, query, limit }, options.signal);
      if (found.results.length || !found.blocked) return found.results.slice(0, limit);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // The browser couldn't search either: what the fetch found stands.
    }
  }
  if (blocked) {
    fail(
      options.browser
        ? "The search was turned away, in the browser too: try again in a while"
        : "The search was turned away, and there's no browser to try it in",
      "blocked",
    );
  }
  return [];
}
