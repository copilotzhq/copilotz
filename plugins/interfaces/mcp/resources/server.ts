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
 * - **Who calls.** With the app's `caller` settings, the caller's address,
 *   as its front says it (the runtime's `callerFrom`); a request that came around
 *   the front (without its secret) is refused (403).
 * - **At once.** Tool calls running at once: in the runtime (`mcp.atOnce`,
 *   4), on the line (`limits.atOnce`, 4), from one caller's address
 *   (`addressAtOnce`, 2: a batch's every call counts) and in one
 *   conversation (`chatAtOnce`, 2), each call taking its places until it's
 *   done. Past any, it's busy (503, `Retry-After`, -31000, its own code),
 *   before anything runs; in a batch, that call's answer says so (and a
 *   batch busy for every call is a 503). A batch with more tool calls than
 *   one caller may run at once could never be served: it's refused
 *   (-32600). A call that hasn't answered within the line's `timeout` is
 *   answered "still working" while it goes on, as long as few do (2 on the
 *   line, 1 from an address); else it's stopped (see tools.ts).
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
 *   `tools/call` (see tools.ts); with widgets (a line whose tools are shown
 *   through the app's web Views, and the app's `widgets` resource: see
 *   widgets.ts), `resources/list` and `resources/read` (the widgets'
 *   template), and the widgets' own calls: the entries only they may call,
 *   refused without their grant, which the model never has.
 *
 * Sources: https://modelcontextprotocol.io/specification/2026-07-28 (transport,
 * versioning, tools), https://modelcontextprotocol.io/specification/2025-11-25,
 * https://developers.openai.com/apps-sdk/reference (ChatGPT's `_meta`).
 */
import {
  type Caller,
  callerFrom,
  linksOf,
  type Route,
  type Runtime,
  secretsOf,
} from "../../../../runtime/mod.ts";
import type { Widgets } from "../../../../hosts/web/mod.ts";
import { addressKey, callIdOf, threadOf, userOf } from "../shared/keys.ts";
import { appOnly, atOnceOf, callerOf, type Line, lineOf, PATH, READ } from "../shared/settings.ts";
import { busy, hold, isBusy } from "./running.ts";
import {
  called,
  conversationHere,
  listed,
  mirrored,
  offeredOf,
  type Said,
  usable,
} from "./tools.ts";
import {
  appCalled,
  CALL,
  grantedContact,
  NOT_YOURS,
  resourceRead,
  resourcesListed,
  templateOf,
  widgetMeta,
} from "./widgets.ts";

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
/**
 * An answer to one message: none (a notification), or a JSON-RPC response,
 * with its HTTP status (and, busy, when to try again).
 */
type Answered = { status: number; body?: Record<string, unknown>; again?: true };

const BUSY_TEXT = "Busy: too many calls at once. Try again in a moment.";
const AGAIN = { "retry-after": "1" };

const headers = { "content-type": "application/json", "cache-control": "no-store" };

const respond = (status: number, body?: unknown, more: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === undefined ? { "cache-control": "no-store" } : headers), ...more },
  });

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

/**
 * Answers a request to `/mcp/<line>`. The app's widgets (the template, and snapshots of what a
 * View reads) are its `widgets` resource, when it has one.
 */
export const serveMcp: Route = async (request, { runtime }) => {
  const resources = runtime.describe().resources;
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
  // Around the app's front, straight to it: refused, when the front vouches for callers.
  const caller = callerFrom(request, callerOf({ resources }));
  if (caller === "refused") {
    return respond(403, fault(undefined, REQUEST, "Not through the app's front"));
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
  const links = linksOf(resources);
  if (!links) return respond(500, fault(undefined, INTERNAL, "Internal error"));
  const org = (resources.org as { id?: string } | undefined)?.id;
  const context: Context = {
    runtime,
    line,
    resources,
    request,
    caller,
    scope: { line: line.name, ...(org ? { org } : {}), secrets: secretsOf(links) },
    atOnce: atOnceOf({ resources }),
    ...(resources.widgets ? { widgets: resources.widgets as Widgets } : {}),
    origin: linksOf(resources)?.origin,
  };
  if (Array.isArray(parsed)) {
    // Batches were MCP's only in 2025-03-26.
    const version = request.headers.get("mcp-protocol-version") ?? UNSAID;
    if (version !== UNSAID || !parsed.length || parsed.length > BATCH) {
      return respond(
        400,
        fault(undefined, REQUEST, `One message a request (from 2025-03-26, ${BATCH} at most)`),
      );
    }
    // More tool calls than one caller may run at once could never be served: not a busy moment.
    const calls = parsed.filter((m) => isObject(m) && m.method === "tools/call").length;
    const most = line.limits.addressAtOnce;
    if (caller && !caller.exempt && calls > most) {
      return respond(
        400,
        fault(undefined, REQUEST, `A batch takes at most ${most} tool calls (addressAtOnce)`),
      );
    }
    const bodies = [];
    for (const message of parsed) {
      const { body } = await answered(context, message, true);
      if (body) bodies.push(body);
    }
    // Every call in it busy: the batch is (and may be sent again).
    const busyAll = bodies.length > 0 &&
      bodies.every((b) => (b.error as { code?: number } | undefined)?.code === BUSY);
    return bodies.length
      ? respond(busyAll ? 503 : 200, bodies, busyAll ? AGAIN : {})
      : respond(202);
  }
  const { status, body, again } = await answered(context, parsed, false);
  return respond(status, body, again ? AGAIN : {});
};

/** A request's id, when it's one JSON-RPC takes. */
const idOf = (id: unknown): Id | undefined =>
  (typeof id === "string" && id.length <= 200) || Number.isSafeInteger(id) ? id as Id : undefined;

type Context = {
  runtime: Pick<Runtime, "call" | "cancel" | "describe" | "observe" | "query">;
  line: Line;
  resources: Record<string, Record<string, unknown>>;
  request: Request;
  /** Who calls, as the front says (undefined without the app's `caller` settings). */
  caller?: Exclude<Caller, "refused">;
  scope: { line: string; org?: string; secrets: string[] };
  /** Calls the runtime runs at once. */
  atOnce: number;
  /** The app's widgets, when it has the `widgets` resource; and the app's own origin (`links`). */
  widgets?: Widgets;
  origin?: string;
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
        return ok(initialized(c.line, params, await withWidgets(c)));
      case "server/discover":
        return ok(discovered(c.line, await withWidgets(c)));
      case "ping":
        return ok({});
      case "tools/list": {
        if (params.cursor !== undefined) {
          return failed(status(PARAMS), rpc, PARAMS, "No such cursor");
        }
        const names = await offeredOf(c.runtime, c.line, usable(c.runtime, c.line));
        const template = await templateOf(c.line, c.widgets, c.origin);
        return ok({
          tools: listed(c.line, c.resources, names, c.runtime.describe().actions, template?.uri),
          ttlMs: TTL_MS,
          cacheScope: "public",
        });
      }
      case "resources/list":
      case "resources/templates/list":
      case "resources/read": {
        // The template is large (an app's whole widget code): a caller reads it a few times a
        // minute, not in a loop.
        if (method === "resources/read" && !counted(c, "read", READS_A_MINUTE)) throw busy();
        // Resources are the widgets' template: without widgets, there are none to ask about.
        if (!await withWidgets(c)) return failed(status(METHOD), rpc, METHOD, "Method not found");
        if (method === "resources/list") {
          return ok(await resourcesListed(c.line, c.widgets, c.origin));
        }
        if (method === "resources/templates/list") return ok({ resourceTemplates: [] });
        const read = await resourceRead(c.line, c.widgets, c.origin, params.uri);
        if (!read) {
          return failed(
            status(PARAMS),
            rpc,
            PARAMS,
            `No such resource: ${String(params.uri).slice(0, 200)}`,
          );
        }
        return ok(read);
      }
      case "tools/call": {
        const tool = params.name;
        const input = params.arguments ?? {};
        const template = await templateOf(c.line, c.widgets, c.origin);
        const theirs = typeof tool === "string" && (
          tool === READ || (Object.hasOwn(c.line.tools, tool) && appOnly(c.line.tools[tool]))
        );
        // What only the widgets call exists only where they do.
        if (
          typeof tool !== "string" || (theirs && !template) ||
          (tool !== READ && !usable(c.runtime, c.line).includes(tool))
        ) {
          return failed(status(PARAMS), rpc, PARAMS, `Unknown tool: ${String(tool).slice(0, 128)}`);
        }
        if (!isObject(input)) return failed(status(PARAMS), rpc, PARAMS, "arguments is an object");
        const odd = oddIn(input);
        if (odd) return failed(status(PARAMS), rpc, PARAMS, odd);
        const conversation = saidOf(meta);
        if (!conversation) {
          return failed(status(PARAMS), rpc, PARAMS, "openai/session and openai/subject are text");
        }
        if (theirs) return ok(await widgetCalled(c, tool, input, rpc, conversation, meta));
        const { conversation: whose, ...result } = await called(c.runtime, c.line, c.scope, {
          tool,
          input,
          request: rpc,
          said: conversation,
          caller: c.caller,
          atOnce: c.atOnce,
        });
        // Drawn by a widget: what it draws, for the widget alone (`_meta`: never the model's).
        const drawn = template && c.widgets && c.line.tools[tool]?.widget && whose &&
          !(result as { isError?: boolean }).isError;
        return ok(
          drawn
            ? {
              ...result,
              _meta: await widgetMeta(
                c.runtime,
                c.widgets!,
                c.line,
                c.scope,
                { tool, input },
                whose,
              ),
            }
            : result,
        );
      }
      default:
        return failed(status(METHOD), rpc, METHOD, "Method not found");
    }
  } catch (error) {
    if (isBusy(error)) {
      return { ...failed(batched ? 200 : 503, rpc, BUSY, BUSY_TEXT), again: true };
    }
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

/** How many times a minute one caller's address reads the template, and asks for the tools. */
const READS_A_MINUTE = 30;

/** What's asked of a line besides tool calls, by caller's address, this minute (in this process). */
const asked = new Map<string, { minute: number; count: number }>();

/** Counts one of a caller's asks; false past `most` a minute. Callers the front exempts aren't counted. */
function counted(c: Context, what: string, most: number): boolean {
  if (c.caller?.exempt) return true;
  const minute = Math.floor(Date.now() / 60_000);
  const key = `${c.line.name}|${what}|${c.caller?.counted ?? "unknown"}`;
  const seen = asked.get(key);
  const count = seen?.minute === minute ? seen.count : 0;
  if (count >= most) return false;
  asked.set(key, { minute, count: count + 1 });
  if (asked.size > 10_000) { for (const [k, v] of asked) if (v.minute !== minute) asked.delete(k); }
  return true;
}

/** Whether the line's widgets are served here: a template to draw them in. */
const withWidgets = async (c: Context) => !!await templateOf(c.line, c.widgets, c.origin);

/**
 * A call to what only the line's widgets call (see widgets.ts): refused to anyone without the
 * widget's grant (the model never has one), and to a grant from another conversation than the
 * one the call names; else made, as the conversation's contact, within its places at once.
 */
async function widgetCalled(
  c: Context,
  tool: string,
  input: Record<string, unknown>,
  request: string | number,
  said: Said,
  meta: Record<string, unknown> | undefined,
) {
  const [secret] = c.scope.secrets;
  // The conversation the call names (ChatGPT's always do): its contact and chat, under whichever
  // of the app's secrets it was made with.
  const named = said.session === undefined
    ? undefined
    : await conversationHere(c.runtime, c.scope, {
      session: said.session,
      ...(said.subject ? { subject: said.subject } : {}),
    });
  const contact = await grantedContact(
    c.scope,
    c.line,
    input,
    meta,
    () => Promise.resolve(named?.contact),
  );
  if (!contact) return { content: [{ type: "text", text: NOT_YOURS }], isError: true };
  const entry = tool === READ ? undefined : c.line.tools[tool];
  const { _grant: _, ...rest } = input;
  // A tool only the widgets call runs as any tool does, for the grant's conversation (what it
  // would read after is the widget's to ask: a tool takes only its own input).
  if (entry && !entry.action) {
    const { _reads: _after, ...own } = rest;
    const { conversation: _whose, ...result } = await called(c.runtime, c.line, c.scope, {
      tool,
      input: own,
      request,
      said,
      caller: c.caller,
      atOnce: c.atOnce,
      contact,
      ...(named ? { thread: named.thread } : {}),
    });
    return result;
  }
  const address = c.caller && !c.caller.exempt ? c.caller.counted : undefined;
  const thread = named?.thread ?? await threadOf(secret, contact);
  const release = hold(c.runtime, [
    { key: "runtime", most: c.atOnce },
    { key: `line:${c.line.name}`, most: c.line.limits.atOnce },
    ...(address
      ? [{ key: `address:${c.line.name}|${address}`, most: c.line.limits.addressAtOnce }]
      : []),
    { key: `chat:${c.line.name}|${thread}`, most: c.line.limits.chatAtOnce },
  ]);
  if (!release) throw busy();
  try {
    // The call's id: its own (`_call`, which a retry of it shares), never the JSON-RPC request's
    // alone (a host may number its requests from 1 again: two taps would be one call).
    const own = typeof rest[CALL] === "string" && /^[\w-]{8,64}$/.test(rest[CALL] as string)
      ? rest[CALL] as string
      : crypto.randomUUID();
    const [id, user, counted] = await Promise.all([
      callIdOf(thread, own, tool, rest),
      said.subject ? userOf(secret, c.scope, said.subject) : undefined,
      address ? addressKey(secret, address) : undefined,
    ]);
    return await appCalled(c.runtime, c.line, c.scope, {
      tool,
      input: rest,
      contact,
      thread,
      id,
      ...(user ? { user } : {}),
      ...(counted ? { address: counted } : {}),
    });
  } finally {
    release();
  }
}

/** Who the server is. */
const serverOf = (line: Line) => ({
  name: line.name,
  ...(line.title ? { title: line.title } : {}),
  version: line.version,
});

/** What the server has: tools, and with widgets, their template (a resource). */
const capabilitiesOf = (widgets: boolean) => widgets ? { tools: {}, resources: {} } : { tools: {} };

/** A legacy client's handshake: the version it asked for when taken, else the newest legacy one. */
function initialized(line: Line, params: Params, widgets: boolean) {
  const asked = params.protocolVersion;
  return {
    protocolVersion: typeof asked === "string" && LEGACY.includes(asked) ? asked : LEGACY[0],
    capabilities: capabilitiesOf(widgets),
    serverInfo: serverOf(line),
    ...(line.instructions ? { instructions: line.instructions } : {}),
  };
}

/** What `server/discover` says: versions, what it has, who it is. */
const discovered = (line: Line, widgets: boolean) => ({
  supportedVersions: VERSIONS,
  capabilities: capabilitiesOf(widgets),
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
