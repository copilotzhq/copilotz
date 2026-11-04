/**
 * The OpenAPI plugin's contract: its options and settings (the `openapi`
 * resource, one entry per API, which an app patches per deployment), what
 * `openapi()` returns, and what a tool gives an agent for a file.
 */
import type { Context, Plugin } from "../../../runtime/mod.ts";
import type { Tool } from "../chat/contract.ts";

/** Computes headers for each call (auth that changes, a token per person): the Action's context. */
export type OpenApiHeaders = (
  ctx: Context,
  request: { operation: string; method: string; url: string },
) => Record<string, string> | Promise<Record<string, string>>;

/**
 * An API's settings: `resources.openapi.<name>`. What `openapi()` is given
 * is where they start; an app patches them like any resource.
 */
export type OpenApiSettings = {
  /** Where the API is; the spec's `servers[0].url` when not said. */
  baseUrl?: string;
  /** Sent with every call, after the operation's own: static values, or a hook. */
  headers?: Record<string, string> | OpenApiHeaders;
  /** Query parameters sent with every call (a key some APIs take in the URL). */
  query?: Record<string, string>;
  /** How long a call may take, in ms (30 s). */
  timeout?: number;
  /**
   * The most a response may be, in bytes (100 KB), so a huge one can't flood
   * an agent's prompt; a larger one fails. File fields count apart.
   */
  maxBytes?: number;
  /**
   * By operation id, response fields that hold a file as a data URL or base64
   * (`["image"]`, `["data.*.b64_json"]`: `*` is every item). A tool saves them
   * as files of its conversation and gives the agent a reference instead.
   * A response that is a file (an image, a PDF) always is.
   */
  files?: Record<string, string[]>;
  /** The most a file may be, decoded, and all of one response's together (10 MB). */
  maxFileBytes?: number;
  /** Media types a file may have (`image/*` matches every image); see `FILE_TYPES`. */
  fileTypes?: string[];
  /** The `fetch` to call with (a proxy, a test's). */
  fetch?: typeof fetch;
};

/** What `openapi()` takes: the API's name, its spec, which operations, and its settings. */
export type OpenApiOptions = OpenApiSettings & {
  /**
   * Names its plugin, its Actions (`<name>.<operation>`), its tools
   * (`<name>_<operation>`) and its settings (`resources.openapi.<name>`).
   */
  name: string;
  /** An OpenAPI 3.0 or 3.1 document, as an object or JSON text (parse YAML first). */
  spec: Record<string, unknown> | string;
  /** Only these operations (by operation id); all of them when not said. */
  operations?: string[];
};

/** An operation, as the plugin made it: its tool's and Action's names, and its request. */
export type OpenApiOperation = { tool: string; action: string; method: string; path: string };

/** An ordinary plugin, with each operation's tool to wrap, by operation id. */
export type OpenApi = Plugin & {
  /** Each operation's tool: `{ ...api.tools.getTrip, run }` makes one of your own. */
  tools: Record<string, Tool>;
  operations: Record<string, OpenApiOperation>;
  /** Operations left out, and why (a body that isn't JSON). */
  skipped: Record<string, string>;
};

/** What an agent is given in a file's place: the `file` document it was saved as. */
export type OpenApiFile = { file: string; name: string; type: string; size: number };
