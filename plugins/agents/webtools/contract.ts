/**
 * The web tools' contract: their settings (the `webTools` resource), the
 * `search` port's adapter shape, and what `webTools` gives agents.
 */
import type { Context } from "../../../runtime/mod.ts";

/** One search result. */
export type SearchResult = { title: string; url: string; snippet: string };

/** What a search adapter is asked for. */
export type SearchRequest = {
  /** Where the engine is and the key it takes, from `webTools.search`. */
  connection: { apiKey?: string; endpoint?: string; options?: Record<string, unknown> };
  query: string;
  /** How many results at most (the tool has already capped it). */
  count: number;
  /** The results' language (ISO-639-1, `pt`) and country (ISO-3166 alpha-2, `br`), when asked for. */
  language?: string;
  country?: string;
  /** The runtime's `ctx.fetch`: the only way an adapter reaches the engine. */
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
};

/**
 * A search engine, as the `search` port: `adapters.search.<name>`, chosen by
 * `webTools.search.adapter`. Brave or Google are one more of these.
 */
export type SearchAdapter = {
  /** What the engine's use is recorded as in the usage ledger (`subject`). */
  subject?: string;
  search(request: SearchRequest): Promise<SearchResult[]>;
};

/** Finds a host's addresses; the default asks the platform's resolver. Tests give theirs. */
export type Resolve = (host: string) => Promise<string[]>;

/** `resources.webTools`: an app patches it like any resource. */
export type WebToolsSettings = {
  search?: {
    /** The search adapter (`"duckduckgo"`, the default; `"serper"`; `"fake"` offline). */
    adapter?: string;
    /** The engine's key (Serper's). */
    apiKey?: string;
    /** Another address for the engine, when it isn't the adapter's own. */
    endpoint?: string;
    /** Whatever the adapter takes besides. */
    options?: Record<string, unknown>;
    /** The most results one search returns (10). */
    maxResults?: number;
  };
  /** How long a search or a page may take, in ms (15 s). */
  timeout?: number;
  /** The most of a page that is read, in bytes (2 MB); more fails. */
  maxBytes?: number;
  /** How much text one `read_page` answer holds, in characters (20,000). */
  pageChars?: number;
  /** How many redirects a page may follow (4). */
  redirects?: number;
  /** How many pages one agent turn may read (8). */
  readsPerTurn?: number;
  /** Ports besides 80 and 443 a page may be fetched on. */
  ports?: number[];
  /** The user agent pages are asked with. */
  userAgent?: string;
  /** Hosts whose addresses are looked up some other way (tests; a resolver over DoH). */
  resolve?: Resolve;
};

export type WebToolsContext = Pick<Context, "resources" | "adapters" | "fetch" | "signal">;
