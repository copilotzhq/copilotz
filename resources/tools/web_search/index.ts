interface WebSearchParams {
  query: string;
  count?: number;
  region?: string;
  language?: string;
  safeSearch?: "strict" | "moderate" | "off";
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

function buildSearchUrl(params: WebSearchParams): string {
  const url = new URL(`${ENDPOINT}/`);
  url.searchParams.set("q", params.query);
  if (params.region) url.searchParams.set("kl", params.region);
  if (params.language) url.searchParams.set("kad", params.language);
  const safe = safeSearchParam(params.safeSearch);
  if (safe) url.searchParams.set("kp", safe);
  return url.href;
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
    timeout = 20,
  }: WebSearchParams) => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) throw new Error("Search query is required.");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

    try {
      const url = buildSearchUrl({
        query: trimmedQuery,
        count,
        region,
        language,
        safeSearch,
        timeout,
      });
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept: "text/html",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      if (isBotChallenge(html)) {
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
      if ((error as Error).name === "AbortError") {
        throw new Error(`Search timeout after ${timeout} seconds`);
      }
      throw new Error(`Web search failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeoutId);
    }
  },
};
