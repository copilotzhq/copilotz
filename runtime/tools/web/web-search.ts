interface WebSearchParams {
  query: string;
  count?: number;
  region?: string;
  language?: string;
  safeSearch?: "strict" | "moderate" | "off";
  timeRange?: "day" | "week" | "month" | "year";
  timeout?: number;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const ENDPOINT = "https://html.duckduckgo.com/html";
const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const MAX_ATTEMPTS = 3;

interface BrowserHeaderProfile {
  name: string;
  acceptLanguage: string;
  headers: Record<string, string>;
}

export const browserHeaderProfiles: BrowserHeaderProfile[] = [
  {
    name: "chrome-windows",
    acceptLanguage: "en-US,en;q=0.9",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Sec-CH-UA":
        '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
  },
  {
    name: "chrome-macos",
    acceptLanguage: "en-US,en;q=0.9",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Sec-CH-UA":
        '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"macOS"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
  },
  {
    name: "chrome-linux",
    acceptLanguage: "en-US,en;q=0.9",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Sec-CH-UA":
        '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Linux"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
  },
  {
    name: "edge-windows",
    acceptLanguage: "en-US,en;q=0.9",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Sec-CH-UA":
        '"Microsoft Edge";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
  },
  {
    name: "firefox-windows",
    acceptLanguage: "en-US,en;q=0.5",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    },
  },
  {
    name: "firefox-macos",
    acceptLanguage: "en-US,en;q=0.5",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:126.0) Gecko/20100101 Firefox/126.0",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    },
  },
];

function randomInt(max: number): number {
  if (max <= 1) return 0;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % max;
}

export function selectBrowserHeaderProfile(
  excludedNames: string[] = [],
): BrowserHeaderProfile {
  const excluded = new Set(excludedNames);
  const candidates = browserHeaderProfiles.filter((profile) =>
    !excluded.has(profile.name)
  );
  const pool = candidates.length > 0 ? candidates : browserHeaderProfiles;
  return pool[randomInt(pool.length)];
}

function normalizeLocale(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/_/g, "-");
  const parts = normalized.split("-").filter(Boolean);
  if (parts.length === 1) return parts[0].toLowerCase();

  const [language, region] = parts;
  return `${language.toLowerCase()}-${region.toUpperCase()}`;
}

export function resolveAcceptLanguage(
  params: Pick<WebSearchParams, "region" | "language">,
  fallback: string,
): string {
  const fromLanguage = params.language
    ? normalizeLocale(params.language)
    : null;
  const fromRegion = params.region
    ? (() => {
      const parts = params.region.trim().toLowerCase().split("-");
      if (parts.length !== 2) return null;
      const [country, language] = parts;
      return normalizeLocale(`${language}-${country}`);
    })()
    : null;
  const primary = fromLanguage ?? fromRegion;
  if (!primary) return fallback;

  const baseLanguage = primary.split("-")[0];
  if (baseLanguage === "en") return `${primary},en;q=0.9`;
  return `${primary},${baseLanguage};q=0.9,en-US;q=0.7,en;q=0.6`;
}

export function buildBrowserHeaders(
  profile: BrowserHeaderProfile,
  params: Pick<WebSearchParams, "region" | "language"> = {},
): Record<string, string> {
  return {
    ...profile.headers,
    "Accept-Language": resolveAcceptLanguage(
      params,
      profile.acceptLanguage,
    ),
  };
}

export function isBotChallenge(html: string): boolean {
  if (/class="[^"]*\bresult__a\b[^"]*"/i.test(html)) return false;
  return /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i
    .test(html);
}

export function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl);
    return url.searchParams.get("uddg") ?? rawUrl;
  } catch {
    return rawUrl;
  }
}

export function cleanHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "--")
    .replace(/&hellip;/g, "...")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDuckDuckGoHtml(
  html: string,
  count = DEFAULT_COUNT,
): SearchHit[] {
  const results: SearchHit[] = [];
  const limit = Math.min(Math.max(Math.floor(count), 1), MAX_COUNT);
  const reResult =
    /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
  const reNext = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")/i;
  const reSnippet =
    /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i;
  const reHref = /href="([^"]*)"/i;

  let match;
  while ((match = reResult.exec(html)) !== null && results.length < limit) {
    const rawAttrs = match[1] || "";
    const rawTitle = match[2] || "";
    const hrefMatch = reHref.exec(rawAttrs);
    const rawUrl = hrefMatch ? hrefMatch[1] : "";

    const end = match.index + match[0].length;
    const trailing = html.slice(end);
    const nextMatch = reNext.exec(trailing);
    const scoped = nextMatch ? trailing.slice(0, nextMatch.index) : trailing;
    const snippetMatch = reSnippet.exec(scoped);

    const title = cleanHtml(rawTitle);
    const url = decodeDuckDuckGoUrl(cleanHtml(rawUrl));
    const snippet = cleanHtml(snippetMatch ? snippetMatch[1] : "");

    if (title && url) results.push({ title, url, snippet });
  }

  return results;
}

function safeSearchParam(value: WebSearchParams["safeSearch"]): string | null {
  if (value === "strict") return "1";
  if (value === "off") return "-1";
  return null;
}

function timeRangeParam(value: WebSearchParams["timeRange"]): string | null {
  if (value === "day") return "d";
  if (value === "week") return "w";
  if (value === "month") return "m";
  if (value === "year") return "y";
  return null;
}

function buildSearchUrl(params: WebSearchParams): string {
  const url = new URL(`${ENDPOINT}/`);
  url.searchParams.set("q", params.query);
  if (params.region) url.searchParams.set("kl", params.region);
  if (params.language) url.searchParams.set("kad", params.language);
  const safe = safeSearchParam(params.safeSearch);
  if (safe) url.searchParams.set("kp", safe);
  const timeRange = timeRangeParam(params.timeRange);
  if (timeRange) url.searchParams.set("df", timeRange);
  return url.href;
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof Error) {
    return /HTTP (403|429|500|502|503|504)\b|Search timeout after/i.test(
      error.message,
    );
  }
  return false;
}

export default {
  key: "web_search",
  name: "Web Search",
  description:
    "Search the web and return structured page results. Use this to find relevant pages before fetching a specific URL.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      count: {
        type: "number",
        description: "Maximum number of results to return.",
        default: DEFAULT_COUNT,
        minimum: 1,
        maximum: MAX_COUNT,
      },
      region: {
        type: "string",
        description:
          "Optional DuckDuckGo region code, for example us-en or br-pt.",
      },
      language: {
        type: "string",
        description:
          "Optional preferred result language, for example en_US or pt_BR.",
      },
      safeSearch: {
        type: "string",
        enum: ["strict", "moderate", "off"],
        description: "Safe search preference.",
        default: "moderate",
      },
      timeRange: {
        type: "string",
        enum: ["day", "week", "month", "year"],
        description: "Optional date filter for recent results.",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds.",
        default: 20,
        minimum: 1,
        maximum: 60,
      },
    },
    required: ["query"],
  },
  execute: async ({
    query,
    count = DEFAULT_COUNT,
    region,
    language,
    safeSearch = "moderate",
    timeRange,
    timeout = 20,
  }: WebSearchParams) => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) throw new Error("Search query is required.");

    const attemptedProfiles: string[] = [];
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const profile = selectBrowserHeaderProfile(attemptedProfiles);
      attemptedProfiles.push(profile.name);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

      try {
        const url = buildSearchUrl({
          query: trimmedQuery,
          count,
          region,
          language,
          safeSearch,
          timeRange,
          timeout,
        });
        const response = await fetch(url, {
          signal: controller.signal,
          headers: buildBrowserHeaders(profile, { region, language }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        if (isBotChallenge(html)) {
          if (attempt < MAX_ATTEMPTS) continue;
          return {
            success: false,
            provider: "duckduckgo-html",
            blocked: true,
            query: trimmedQuery,
            results: [],
            count: 0,
          };
        }

        const results = parseDuckDuckGoHtml(html, count);
        return {
          success: true,
          provider: "duckduckgo-html",
          blocked: false,
          query: trimmedQuery,
          results,
          count: results.length,
        };
      } catch (error) {
        const normalizedError = (error as Error).name === "AbortError"
          ? new Error(`Search timeout after ${timeout} seconds`)
          : error;
        lastError = normalizedError;
        if (attempt < MAX_ATTEMPTS && shouldRetry(normalizedError)) continue;
        const message = normalizedError instanceof Error
          ? normalizedError.message
          : String(normalizedError);
        throw new Error(`Web search failed: ${message}`);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    const message = lastError instanceof Error ? lastError.message : "unknown";
    throw new Error(`Web search failed: ${message}`);
  },
};
