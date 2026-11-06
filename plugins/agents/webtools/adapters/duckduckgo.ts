/**
 * DuckDuckGo's HTML page as the `search` port: no key, no cost. It is a page
 * made for browsers, so it is asked as one (a coherent set of browser headers,
 * rotated between attempts) and read by its markup. A bot challenge, or a
 * page with neither results nor a "no results" notice, is a public error
 * the agent can read, not a crash: the page's markup is not an API, and
 * DuckDuckGo may turn a busy caller away.
 */
import { failure } from "../../../../runtime/mod.ts";
import type { SearchAdapter, SearchResult } from "../contract.ts";
import { decode } from "../shared/text.ts";

const ENDPOINT = "https://html.duckduckgo.com/html/";
const ATTEMPTS = 3;
const MAX_COUNT = 20;

type Profile = { name: string; language: string; headers: Record<string, string> };

const FETCH = {
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};
const CHROME_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9," +
  "image/avif,image/webp,image/apng,*/*;q=0.8";
const FIREFOX_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

const chrome = (
  name: string,
  os: string,
  platform: string,
  brand = "Google Chrome",
  tail = "",
): Profile => ({
  name,
  language: "en-US,en;q=0.9",
  headers: {
    "User-Agent":
      `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36${tail}`,
    Accept: CHROME_ACCEPT,
    "Sec-CH-UA": `"${brand}";v="125", "Chromium";v="125", "Not.A/Brand";v="24"`,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": `"${platform}"`,
    ...FETCH,
  },
});

const firefox = (name: string, os: string): Profile => ({
  name,
  language: "en-US,en;q=0.5",
  headers: {
    "User-Agent": `Mozilla/5.0 (${os}; rv:126.0) Gecko/20100101 Firefox/126.0`,
    Accept: FIREFOX_ACCEPT,
    ...FETCH,
  },
});

export const profiles: Profile[] = [
  chrome("chrome-windows", "Windows NT 10.0; Win64; x64", "Windows"),
  chrome("chrome-macos", "Macintosh; Intel Mac OS X 14_5", "macOS"),
  chrome("chrome-linux", "X11; Linux x86_64", "Linux"),
  chrome(
    "edge-windows",
    "Windows NT 10.0; Win64; x64",
    "Windows",
    "Microsoft Edge",
    " Edg/125.0.0.0",
  ),
  firefox("firefox-windows", "Windows NT 10.0; Win64; x64"),
  firefox("firefox-macos", "Macintosh; Intel Mac OS X 14.5"),
];

/** A profile other than those already tried (any, when all were). */
export function pick(tried: string[] = []): Profile {
  const rest = profiles.filter((p) => !tried.includes(p.name));
  const pool = rest.length ? rest : profiles;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return pool[bytes[0] % pool.length];
}

/** DuckDuckGo's region (`br-pt`: country, language) when both are known. */
export function regionOf(language?: string, country?: string): string | undefined {
  const l = language?.trim().toLowerCase().split(/[-_]/)[0];
  const c = country?.trim().toLowerCase();
  return l && c ? `${c}-${l}` : undefined;
}

/** `Accept-Language` for the results' language and country, else the profile's. */
export function acceptLanguage(profile: Profile, language?: string, country?: string): string {
  const l = language?.trim().toLowerCase().split(/[-_]/)[0];
  if (!l) return profile.language;
  const c = country?.trim().toUpperCase();
  const primary = c ? `${l}-${c}` : l;
  return l === "en" ? `${primary},en;q=0.9` : `${primary},${l};q=0.9,en-US;q=0.7,en;q=0.6`;
}

/** A page of DuckDuckGo that turns the caller away instead of searching. */
export function isChallenge(html: string): boolean {
  if (/class="[^"]*\bresult__a\b[^"]*"/i.test(html)) return false;
  return /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i.test(html);
}

/** The address a result really leads to: DuckDuckGo wraps it as `/l/?uddg=<address>`. */
export function unwrap(raw: string): string {
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    return url.searchParams.get("uddg") ?? raw;
  } catch {
    return raw;
  }
}

const plain = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** The results on a page, in order, at most `count`. */
export function parse(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  const limit = Math.min(Math.max(Math.floor(count), 1), MAX_COUNT);
  const link = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
  const next = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")/i;
  const snippet = /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i;
  let m;
  while ((m = link.exec(html)) !== null && results.length < limit) {
    const href = /href="([^"]*)"/i.exec(m[1])?.[1] ?? "";
    // The snippet is the first one before the next result.
    const after = html.slice(m.index + m[0].length);
    const until = next.exec(after);
    const s = snippet.exec(until ? after.slice(0, until.index) : after);
    const title = plain(m[2]);
    const url = unwrap(plain(href));
    if (title && url) results.push({ title, url, snippet: plain(s?.[1] ?? "") });
  }
  return results;
}

const unavailable = () =>
  failure(
    "unavailable",
    "Search is unavailable right now; try read_page on a known site.",
    { public: true },
  );

export const duckduckgo: SearchAdapter = {
  subject: "duckduckgo",
  async search({ connection, query, count, language, country, fetch, signal }) {
    const url = new URL(connection.endpoint ?? ENDPOINT);
    url.searchParams.set("q", query);
    const region = regionOf(language, country);
    if (region) url.searchParams.set("kl", region);
    const tried: string[] = [];
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const profile = pick(tried);
      tried.push(profile.name);
      let html: string;
      try {
        const response = await fetch(url.href, {
          headers: {
            ...profile.headers,
            "Accept-Language": acceptLanguage(profile, language, country),
          },
          credentials: "omit",
          signal,
        });
        if (!response.ok) {
          // Turned away or busy: another set of headers may pass.
          if (attempt < ATTEMPTS && [403, 429, 500, 502, 503, 504].includes(response.status)) {
            continue;
          }
          throw unavailable();
        }
        html = await response.text();
      } catch (error) {
        if (signal.aborted || (error as { code?: string }).code) throw error;
        if (attempt < ATTEMPTS) continue;
        throw unavailable();
      }
      if (isChallenge(html)) {
        if (attempt < ATTEMPTS) continue;
        throw unavailable();
      }
      const results = parse(html, count);
      if (results.length) return results;
      // A search that found nothing says so; a page that says nothing isn't an answer.
      if (/no[- ]results|No results\./i.test(html)) return [];
      throw unavailable();
    }
    throw unavailable();
  },
};
