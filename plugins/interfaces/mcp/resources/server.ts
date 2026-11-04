/**
 * The MCP route: each line's server at `POST /mcp/<line>` (under many orgs,
 * `/o/<org>/mcp/<line>`), MCP's Streamable HTTP transport, written here
 * with no dependency. It keeps no session: every request carries all it
 * needs, as ChatGPT sends them (it stopped echoing `Mcp-Session-Id` in 2026)
 * and as MCP 2026-07-28 says.
 *
 * - **HTTP.** A POST, `application/json`, within the line's `body` limit,
 *   answered with JSON (never a stream). GET and DELETE answer 405: there's
 *   no stream to open and no session to end. A request with an `Origin` (a
 *   browser's page) is refused unless the line names it: no browser calls
 *   MCP. No cookie is read: whoever calls is nobody but their
 *   conversation's contact.
 * - **At once.** Tool calls running at once, on the line (`limits.atOnce`,
 *   8) and in this process (`mcp.atOnce`, 8): past either, the server is
 *   busy (503, `Retry-After`, -31000, its own code), before anything runs.
 * - **JSON-RPC 2.0.** One message a request. A notification (or a reply)
 *   answers 202. Bad JSON is -32700, a malformed message -32600, an unknown
 *   method -32601, bad params -32602; what fails inside says -32603 and
 *   nothing more (it's logged here). A batch (a list of messages) is taken
 *   only from a 2025-03-26 client (later versions have none; that one's
 *   servers must take them): at most 10 messages, answered one after
 *   another, as one call at once.
 * - **Versions.** 2026-07-28 (modern: no handshake; each request says its
 *   version and capabilities in `_meta`, and repeats its method and name in
 *   headers, which must match: else 400, -32020) and 2025-11-25, 2025-06-18
 *   and 2025-03-26 (legacy: `initialize`, answered without a session id; a
 *   request without `MCP-Protocol-Version` is 2025-03-26). Any other is 400,
 *   -32022, with those it takes.
 * - **Methods.** `initialize`, `server/discover`, `ping`, `tools/list`,
 *   `tools/call` (see tools.ts). Tools are all the server has.
 *
 * Sources: https://modelcontextprotocol.io/specification/2026-07-28 (transport,
 * versioning, tools), https://modelcontextprotocol.io/specification/2025-11-25,
 * https://developers.openai.com/apps-sdk/reference (ChatGPT's `_meta`).
 */
import { linksOf, type Runtime } from "../../../../runtime/mod.ts";
import { atOnceOf, type Line, lineOf, PATH } from "../shared/settings.ts";
import { called, listed, mirrored, offeredOf, type Said, usable } from "./tools.ts";

/** What the web host hands the route: the runtime. */
export type McpHost = { runtime: Pick<Runtime, "call" | "describe" | "observe"> };

/** The version without a handshake, and the ones with one, newest first. */
const MODERN = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"];
const VERSIONS = [MODERN, ...LEGACY];
/** What a request without `MCP-Protocol-Version` is (MCP 2025-06-18 and later say so). */
const UNSAID = "2025-03-26";

/** JSON-RPC's codes, and MCP's own. */
const PARSE = -32700;
const REQUEST = -32600;
const METHOD = -32601;
const PARAMS = -32602;
const INTERNAL = -32603;
const MISMATCH = -32020;
const UNSUPPORTED = -32022;
/** This server's own: too many calls at once (outside JSON-RPC's reserved range, as MCP asks). */
const BUSY = -31000;

/** The most messages a batch takes. */
const BATCH = 10;

/** How long a client may keep what `tools/list` and `server/discover` say (tools change on deploys). */
const TTL_MS = 300_000;

type Id = string | number;
type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type Params = Record<string, unknown> & { _meta?: Record<string, unknown> };
/** An answer to one message: none (a notification), or a JSON-RPC response, with its HTTP status. */
type Answered = { status: number; body?: Record<string, unknown> };

const headers = { "content-type": "application/json", "cache-control": "no-store" };

const respond = (status: number, body?: unknown, more: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === undefined ? { "cache-control": "no-store" } : headers), ...more },
  });

/** Tool calls running in this process, every line's; and each line's, by runtime. */
let running = 0;
const runningOn = new WeakMap<object, Map<string, number>>();

/** A place for a call to run, on its line and in this process: its release; none when busy. */
function place(runtime: object, line: Line, most: number): (() => void) | undefined {
  const lines = runningOn.get(runtime) ?? new Map<string, number>();
  runningOn.set(runtime, lines);
  const here = lines.get(line.name) ?? 0;
  if (running >= most || here >= line.limits.atOnce) return undefined;
  running++;
  lines.set(line.name, here + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running--;
    lines.set(line.name, (lines.get(line.name) ?? 1) - 1);
  };
}

const fault = (id: Id | undefined, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  ...(id !== undefined ? { id } : {}),
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

const failed = (
  status: number,
  id: Id | undefined,
  code: number,
  message: string,
  data?: unknown,
): Answered => ({ status, body: fault(id, code, message, data) });

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Answers a request to `/mcp/<line>`. */
export async function serveMcp(request: Request, host?: McpHost): Promise<Response> {
  if (!host?.runtime) return respond(501, fault(undefined, INTERNAL, "No runtime here"));
  const resources = host.runtime.describe().resources;
  const url = new URL(request.url);
  const name = url.pathname.slice(PATH.length).replace(/\/$/, "");
  const line = /^[\w-]{1,60}$/.test(name) ? lineOf({ resources }, name) : undefined;
  if (!line) return respond(404, fault(undefined, REQUEST, "No MCP server here"));
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  }
  // A browser's page: only from an origin the line names (none, unless it says).
  const origin = request.headers.get("origin");
  if (origin !== null && !(line.origins ?? []).includes(origin)) {
    return respond(403, fault(undefined, REQUEST, "Not from this origin"));
  }
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    return respond(415, fault(undefined, REQUEST, "Send JSON (application/json)"));
  }
  const text = await bodyOf(request, line.limits.body);
  if (text === undefined) return respond(413, fault(undefined, REQUEST, "Too large"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return respond(400, fault(undefined, PARSE, "Parse error"));
  }
  const secret = linksOf(resources)?.secret;
  if (!secret) return respond(500, fault(undefined, INTERNAL, "Internal error"));
  const org = (resources.org as { id?: string } | undefined)?.id;
  const context: Context = {
    runtime: host.runtime,
    line,
    resources,
    request,
    scope: { line: line.name, ...(org ? { org } : {}), secret },
  };
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (Array.isArray(parsed)) {
    // Batches were MCP's only in 2025-03-26.
    const version = request.headers.get("mcp-protocol-version") ?? UNSAID;
    if (version !== UNSAID || !parsed.length || parsed.length > BATCH) {
      return respond(
        400,
        fault(undefined, REQUEST, `One message a request (from 2025-03-26, ${BATCH} at most)`),
      );
    }
  }
  // A request that calls tools takes a place first: one, a batch's calls going one by one.
  const calls = messages.some((m) => isObject(m) && m.method === "tools/call");
  const release = calls ? place(host.runtime, line, atOnceOf({ resources })) : () => {};
  if (!release) {
    const id = !Array.isArray(parsed) && isObject(parsed) ? idOf(parsed.id) : undefined;
    return respond(503, fault(id, BUSY, "Busy: too many calls at once. Try again in a moment."), {
      "retry-after": "1",
    });
  }
  try {
    if (!Array.isArray(parsed)) {
      const { status, body } = await answered(context, parsed, false);
      return respond(status, body);
    }
    const bodies = [];
    for (const message of parsed) {
      const { body } = await answered(context, message, true);
      if (body) bodies.push(body);
    }
    return bodies.length ? respond(200, bodies) : respond(202);
  } finally {
    release();
  }
}

/** A request's id, when it's one JSON-RPC takes. */
const idOf = (id: unknown): Id | undefined =>
  (typeof id === "string" && id.length <= 200) || Number.isSafeInteger(id) ? id as Id : undefined;

type Context = {
  runtime: McpHost["runtime"];
  line: Line;
  resources: Record<string, Record<string, unknown>>;
  request: Request;
  scope: { line: string; org?: string; secret: string };
};

/** A request's body as text, or undefined past `limit` bytes. */
async function bodyOf(request: Request, limit: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

/** A header's value as MCP may encode it (`=?base64?…?=`, for what isn't plain ASCII). */
function decoded(value: string | null): string | null {
  const encoded = value?.match(/^=\?base64\?([A-Za-z0-9+/=]*)\?=$/)?.[1];
  if (encoded === undefined) return value;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

/** One message, answered. In a batch, a request's HTTP status is the batch's (200). */
async function answered(c: Context, raw: unknown, batched: boolean): Promise<Answered> {
  if (!isObject(raw) || raw.jsonrpc !== "2.0") {
    return failed(400, undefined, REQUEST, "Not JSON-RPC 2.0");
  }
  const message = raw as Message;
  const headed = c.request.headers.get("mcp-protocol-version");
  const params = (message.params ?? {}) as Params;
  const meta = isObject(params) && isObject(params._meta) ? params._meta : undefined;
  const said = meta?.["io.modelcontextprotocol/protocolVersion"];
  const version = message.method === "initialize"
    ? undefined
    : headed ?? (typeof said === "string" ? said : UNSAID);
  const asked = idOf(message.id);
  if (version !== undefined && !VERSIONS.includes(version)) {
    return failed(400, asked, UNSUPPORTED, "Unsupported protocol version", {
      supported: VERSIONS,
      requested: version,
    });
  }
  if (headed !== null && typeof said === "string" && headed !== said) {
    return failed(400, asked, MISMATCH, "Header mismatch: MCP-Protocol-Version");
  }
  const modern = version === MODERN;
  // A reply from the client: legacy clients may send one (to nothing we asked); modern ones don't.
  if (message.method === undefined && ("result" in message || "error" in message)) {
    return modern ? failed(400, undefined, REQUEST, "Clients send no replies") : { status: 202 };
  }
  if (typeof message.method !== "string" || !message.method) {
    return failed(400, undefined, REQUEST, "A message has a method");
  }
  const method = message.method;
  if (!("id" in message)) return { status: 202 }; // A notification: nothing to answer.
  const rpc = idOf(message.id);
  if (rpc === undefined) {
    return failed(400, undefined, REQUEST, "A request's id is a string or an integer");
  }
  if (!isObject(params)) return failed(400, rpc, PARAMS, "params is an object");
  if (modern) {
    const wrong = headerProblem(c, method, params, said);
    if (wrong) return failed(400, rpc, wrong.code, wrong.message);
  }
  const ok = (result: Record<string, unknown>): Answered => ({
    status: 200,
    body: { jsonrpc: "2.0", id: rpc, result: modern ? modernOf(c.line, result) : result },
  });
  // A method it doesn't have is a 404 to a modern client (MCP 2026-07-28); else errors in the body.
  const status = (code: number) => !batched && modern && code === METHOD ? 404 : 200;
  try {
    switch (method) {
      case "initialize":
        return ok(initialized(c.line, params));
      case "server/discover":
        return ok(discovered(c.line));
      case "ping":
        return ok({});
      case "tools/list": {
        if (params.cursor !== undefined) {
          return failed(status(PARAMS), rpc, PARAMS, "No such cursor");
        }
        const names = await offeredOf(c.runtime, c.line, usable(c.runtime, c.line));
        return ok({
          tools: listed(c.line, c.resources, names),
          ttlMs: TTL_MS,
          cacheScope: "public",
        });
      }
      case "tools/call": {
        const tool = params.name;
        const input = params.arguments ?? {};
        if (typeof tool !== "string" || !usable(c.runtime, c.line).includes(tool)) {
          return failed(status(PARAMS), rpc, PARAMS, `Unknown tool: ${String(tool).slice(0, 128)}`);
        }
        if (!isObject(input)) return failed(status(PARAMS), rpc, PARAMS, "arguments is an object");
        const odd = oddIn(input);
        if (odd) return failed(status(PARAMS), rpc, PARAMS, odd);
        const conversation = saidOf(meta);
        if (!conversation) {
          return failed(status(PARAMS), rpc, PARAMS, "openai/session and openai/subject are text");
        }
        return ok(
          await called(c.runtime, c.line, c.scope, {
            tool,
            input,
            request: rpc,
            said: conversation,
            http: c.request,
          }),
        );
      }
      default:
        return failed(status(METHOD), rpc, METHOD, "Method not found");
    }
  } catch (error) {
    console.error(`mcp.${c.line.name}: ${method}:`, error instanceof Error ? error.message : error);
    return failed(batched ? 200 : 500, rpc, INTERNAL, "Internal error");
  }
}

/** How deep a tool's input may nest: tools take a few levels; past this, it's no tool's. */
const DEPTH = 64;

/**
 * What's wrong with a call's input before anything reads it, if anything:
 * nested past `DEPTH` (what reads it recursively would run out of stack),
 * or holding what the store reads as a blob reference (an object with a
 * `$blob`: only the app writes those, never a caller). Walked without
 * recursion.
 */
function oddIn(value: unknown): string | undefined {
  const left: [unknown, number][] = [[value, 0]];
  while (left.length) {
    const [at, depth] = left.pop()!;
    if (!at || typeof at !== "object") continue;
    if (depth > DEPTH) return `arguments nest more than ${DEPTH} levels deep`;
    if (!Array.isArray(at) && Object.hasOwn(at, "$blob")) {
      return "arguments hold a blob reference ($blob)";
    }
    for (const item of Object.values(at)) left.push([item, depth + 1]);
  }
  return undefined;
}

/** ChatGPT's fields naming the conversation, when they're text of a sane size; null when not. */
function saidOf(meta: Record<string, unknown> | undefined): Said | null {
  const session = meta?.["openai/session"];
  const subject = meta?.["openai/subject"];
  const fine = (v: unknown) =>
    v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 512);
  if (!fine(session) || !fine(subject)) return null;
  return {
    ...(typeof session === "string" ? { session } : {}),
    ...(typeof subject === "string" ? { subject } : {}),
  };
}

/**
 * What's wrong with a modern request's metadata and headers, if anything:
 * its version and capabilities in `_meta`, and its method, name and
 * mirrored input in headers, matching the body.
 */
function headerProblem(
  c: Context,
  method: string,
  params: Params,
  said: unknown,
): { code: number; message: string } | undefined {
  const meta = params._meta;
  if (typeof said !== "string" || !isObject(meta?.["io.modelcontextprotocol/clientCapabilities"])) {
    return { code: PARAMS, message: "_meta needs its protocolVersion and clientCapabilities" };
  }
  const header = (name: string) => c.request.headers.get(name);
  if (header("mcp-protocol-version") !== said) {
    return { code: MISMATCH, message: "Header mismatch: MCP-Protocol-Version" };
  }
  if (header("mcp-method") !== method) {
    return { code: MISMATCH, message: "Header mismatch: Mcp-Method" };
  }
  if (method !== "tools/call") return undefined;
  if (decoded(header("mcp-name")) !== params.name) {
    return { code: MISMATCH, message: "Header mismatch: Mcp-Name" };
  }
  const input = isObject(params.arguments) ? params.arguments : {};
  for (const { header: name, path } of mirrored(c.line, String(params.name), c.resources)) {
    const value = path.reduce<unknown>((at, key) => isObject(at) ? at[key] : undefined, input);
    if (value === undefined || value === null) continue;
    const given = decoded(header(`mcp-param-${name}`));
    const same = typeof value === "number"
      ? given !== null && Number(given) === value
      : given === String(value);
    if (!same) return { code: MISMATCH, message: `Header mismatch: Mcp-Param-${name}` };
  }
  return undefined;
}

/** Who the server is. */
const serverOf = (line: Line) => ({
  name: line.name,
  ...(line.title ? { title: line.title } : {}),
  version: line.version,
});

const CAPABILITIES = { tools: {} };

/** A legacy client's handshake: the version it asked for when taken, else the newest legacy one. */
function initialized(line: Line, params: Params) {
  const asked = params.protocolVersion;
  return {
    protocolVersion: typeof asked === "string" && LEGACY.includes(asked) ? asked : LEGACY[0],
    capabilities: CAPABILITIES,
    serverInfo: serverOf(line),
    ...(line.instructions ? { instructions: line.instructions } : {}),
  };
}

/** What `server/discover` says: versions, what it has, who it is. */
const discovered = (line: Line) => ({
  supportedVersions: VERSIONS,
  capabilities: CAPABILITIES,
  _meta: { "io.modelcontextprotocol/serverInfo": serverOf(line) },
  ...(line.instructions ? { instructions: line.instructions } : {}),
  ttlMs: TTL_MS,
  cacheScope: "public",
});

/** A result as a modern client takes it: complete, and saying who answered. */
const modernOf = (line: Line, result: Record<string, unknown>) => ({
  resultType: "complete",
  ...result,
  _meta: {
    ...(isObject(result._meta) ? result._meta : {}),
    "io.modelcontextprotocol/serverInfo": serverOf(line),
  },
});
