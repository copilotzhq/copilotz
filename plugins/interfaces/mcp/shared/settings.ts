/**
 * The MCP plugin's settings (the `mcp` resource): the lines the app
 * declares, by name, and how it knows who's calling. Each line is an MCP
 * server at `/mcp/<name>` that a model outside (ChatGPT, Claude, any MCP
 * client) calls the app's tools through: which tools, how they're shown,
 * the space its conversations' chats live in, and its limits. `lineOf`
 * gives a line with every default filled in, as the plugin uses it;
 * `problemOf` says what's wrong with one, at start.
 */
import type { Resources } from "../../../../runtime/mod.ts";
import { agentsOf, SEND, type Tool, type ToolAnnotations } from "../../../agents/chat/contract.ts";
import { LISTS, rangeOk } from "./caller.ts";

/** How one of the app's tools is offered on a line: what only MCP needs. */
export type McpTool = {
  /** What people see it called, instead of the tool's own `title` (or its name). */
  title?: string;
  /** Its hints (read-only, destructive…), over the tool's own `annotations`. */
  annotations?: ToolAnnotations;
  /** What ChatGPT shows while it runs, and once it's done (64 characters at most). */
  invoking?: string;
  invoked?: string;
};

/** What a line takes before it says no: see `LIMITS`. */
export type McpLimits = {
  /** Bytes a request's body may be. */
  body: number;
  /**
   * Calls running at once on the line, and from one caller's address, and in
   * one conversation: past any, the server is busy.
   */
  atOnce: number;
  addressAtOnce: number;
  chatAtOnce: number;
  /** Seconds a tool may run: past them, it's stopped, and the model is told so. */
  timeout: number;
  /** Calls one conversation may make a minute, and all of the line's conversations together. */
  perMinute: number;
  linePerMinute: number;
  /** New conversations the line takes an hour, and one user starts there (ChatGPT's `openai/subject`). */
  chatsPerHour: number;
  userChatsPerHour: number;
  /** Calls a minute, and new conversations an hour, from one caller's address (see `McpCaller`). */
  ipPerMinute: number;
  ipChatsPerHour: number;
  /** Characters a call's answer may say: past them, it's cut. */
  result: number;
};

/** A line the app declares: an MCP server open to anyone, at `/mcp/<name>`. */
export type McpLine = {
  /** The space its conversations' chats live in (declared with the spaces plugin's `spaces`, or not). */
  in: string;
  /**
   * The tools it offers, by name (the `tools` resource's), each with how
   * it's offered (`{}` as it is). Only these: an app lists what a model
   * outside may call. Each needs its `tool:<name>` View (`llm`), what a
   * model reads of it: a tool without one isn't offered.
   */
  tools: Record<string, McpTool | null>;
  /** What it's called, its version, and what the model is told about using it. */
  title?: string;
  version?: string;
  instructions?: string;
  /**
   * Who calls (`ChatGPT`), as its chats show it: the sender of their steps,
   * and their title. The line's name unless said.
   */
  client?: string;
  /**
   * A client that names no conversation (no `openai/session`, which ChatGPT
   * sends) gets a handle to name it with (`chat`, on every tool), so its
   * calls go on in one chat. Off, a call that names no conversation is
   * refused. On unless said; a line only ChatGPT uses turns it off, so its
   * model isn't shown the field, and nobody else gets a chat there.
   */
  handles?: boolean;
  /** The browser origins it answers (`Origin`): none unless said (no browser calls MCP). */
  origins?: string[];
  limits?: Partial<McpLimits>;
  /** With the orgs host, the org it's for (its id): no other org has it. */
  org?: string;
};

/**
 * Where a caller's address is, when the app's front says it: the header
 * the front sets (`cf-connecting-ip`; `x-forwarded-for`, a list), and why
 * it's believed. A header anyone may send is believed only from the front:
 *
 * - `front`: the front's secret, which it sends in `x-copilotz-front` (the
 *   web host's own front header). A request without it came around the
 *   front, straight to the app: it's refused.
 * - `hops`: for a list the app's own proxies append to (`x-forwarded-for`:
 *   Cloud Run's appends the address it saw), the entry that many from the
 *   end. A list header needs it: its first entries are the caller's to say.
 *
 * Callers in `exempt` (CIDR ranges: a shared proxy such as OpenAI's, every
 * ChatGPT user's calls behind a few addresses) aren't limited by address;
 * the line's own limits still hold. An address that can't be read is
 * counted with every other such call, as one caller. Without `caller`, no
 * limit goes by address.
 *
 * **To verify on each deployment** (a wrong setting lets callers choose
 * their address):
 * - with a Cloudflare worker as the front (`front`): that it sets
 *   `cf-connecting-ip` to the address Cloudflare saw, overwriting any the
 *   caller sent, and that it sends its secret only to the app;
 * - with `x-forwarded-for` (`hops`): how many proxies the app runs behind
 *   that each append to it (Cloud Run's front end: 1; a load balancer
 *   before it: 2). Too few hops counts a caller's own entry; too many, a
 *   proxy's address, every caller's.
 */
export type McpCaller = { header: string; front?: string; hops?: number; exempt?: string[] };

export type McpSettings = {
  lines?: Record<string, McpLine>;
  caller?: McpCaller;
  /**
   * Calls running at once in this runtime (an org's, under the orgs host),
   * all its lines together (8): past them, it's busy.
   */
  atOnce?: number;
};

/**
 * What a line takes, unless it says: a request of 64 KiB (a tool's input
 * is small); 8 calls at once, 2 from one address and 2 in one conversation;
 * tools running 20 seconds at most; 30 calls a minute from one
 * conversation, 600 from all; 600 new conversations an hour, 30 from one
 * user; from one address, 60 calls a minute and 20 new conversations an
 * hour; answers of 100,000 characters.
 */
export const LIMITS: McpLimits = {
  body: 65_536,
  atOnce: 8,
  addressAtOnce: 2,
  chatAtOnce: 2,
  timeout: 20,
  perMinute: 30,
  linePerMinute: 600,
  chatsPerHour: 600,
  userChatsPerHour: 30,
  ipPerMinute: 60,
  ipChatsPerHour: 20,
  result: 100_000,
};

/** Calls at once in a runtime, unless the `mcp` resource says (`atOnce`). */
export const AT_ONCE = 8;

/** The longest ChatGPT shows a call's status line. */
const STATUS = 64;

/** A line as the plugin uses it: its settings, its name, and every default filled in. */
export type Line = Omit<McpLine, "tools" | "limits"> & {
  name: string;
  client: string;
  handles: boolean;
  version: string;
  /** The tools it offers, in order, each with how. */
  tools: Record<string, McpTool>;
  limits: McpLimits;
};

/** Where every line is: `/mcp/<name>`. */
export const PATH = "/mcp/";

const settingsOf = (ctx: { resources: Resources }) => (ctx.resources.mcp ?? {}) as McpSettings;

/** How the app knows who's calling, and how many calls a process takes at once. */
export const callerOf = (ctx: { resources: Resources }) => settingsOf(ctx).caller;
export const atOnceOf = (ctx: { resources: Resources }) => settingsOf(ctx).atOnce ?? AT_ONCE;

/**
 * The app's own lines, by name, here: with the orgs host (each org's runtime
 * knows its org, `resources.org`), only those that name this org; a line
 * naming none is the single-org app's.
 */
export const linesOf = (ctx: { resources: Resources }): Record<string, McpLine> => {
  const all = settingsOf(ctx).lines ?? {};
  const org = (ctx.resources.org as { id?: string } | undefined)?.id;
  return Object.fromEntries(
    Object.entries(all).filter(([, line]) => line && (org ? line.org === org : !line.org)),
  );
};

/** The names of the tools a line lists. */
const listedBy = (line: McpLine) =>
  Object.keys(line.tools ?? {}).filter((name) => line.tools[name] !== null);

/** The line `name`, ready to use; undefined when the app declares none by that name. */
export function lineOf(ctx: { resources: Resources }, name: string): Line | undefined {
  const lines = linesOf(ctx);
  const line = Object.hasOwn(lines, name) ? lines[name] : undefined;
  if (!line) return undefined;
  return {
    ...line,
    name,
    client: line.client ?? name,
    handles: line.handles ?? true,
    version: line.version ?? "1.0.0",
    tools: Object.fromEntries(listedBy(line).map((tool) => [tool, line.tools[tool] ?? {}])),
    limits: { ...LIMITS, ...line.limits },
  };
}

/** A tool's hints as a line offers it: the tool's own, then the line's over them. */
export const hintsOf = (line: Line, name: string, tool: Tool): ToolAnnotations => ({
  ...tool.annotations,
  ...line.tools[name]?.annotations,
});

/** Tool names an MCP client takes as they are. */
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** What's wrong with a line's settings, if anything (checked when the app starts). */
export function problemOf(name: string, line: McpLine, resources: Resources): string | undefined {
  if (!/^[\w-]{1,60}$/.test(name)) return "its name is letters, digits, - and _";
  if (typeof line?.in !== "string" || !line.in) return "needs its in (the space its chats live in)";
  if ("agent" in line) {
    return "lists its tools (tools), never an agent's: say which ones a model outside calls";
  }
  if (!line.tools || typeof line.tools !== "object") {
    return "needs its tools: which ones a model outside calls";
  }
  const tools = (resources.tools ?? {}) as Record<string, Tool | null>;
  const offered = listedBy(line);
  if (!offered.length) return "offers no tool";
  const client = line.client ?? name;
  if (Object.hasOwn(agentsOf({ resources }), client)) {
    return `its client "${client}" is an agent's name`;
  }
  for (const tool of offered) {
    const own = Object.hasOwn(tools, tool) ? tools[tool] : undefined;
    if (tool === SEND) return `${SEND} is agents' own, not a tool to offer`;
    if (!own) return `offers "${tool}", which isn't one of the app's tools`;
    if (!NAME.test(tool)) return `"${tool}" isn't a name MCP takes (A-Z, a-z, 0-9, _ . -)`;
    const input = own.input as { type?: unknown; properties?: Record<string, unknown> } | undefined;
    if (input && input.type !== "object") return `"${tool}" takes an object (its input's type)`;
    if ((line.handles ?? true) && input?.properties && Object.hasOwn(input.properties, "chat")) {
      return `"${tool}" has an input called chat, which handles take: set handles: false`;
    }
    const how = line.tools[tool] ?? {};
    for (const field of ["invoking", "invoked"] as const) {
      const text = how[field];
      if (text !== undefined && (typeof text !== "string" || !text || text.length > STATUS)) {
        return `tools.${tool}.${field} is text of ${STATUS} characters at most`;
      }
    }
    for (const [hint, value] of Object.entries({ ...own.annotations, ...how.annotations })) {
      if (!["readOnly", "destructive", "idempotent", "openWorld"].includes(hint)) {
        return `"${tool}": ${hint} isn't an annotation (readOnly, destructive, idempotent, openWorld)`;
      }
      if (typeof value !== "boolean") return `"${tool}": its ${hint} is true or false`;
    }
  }
  for (const [key, value] of Object.entries(line.limits ?? {})) {
    if (!(key in LIMITS)) return `limits.${key} isn't a limit`;
    if (typeof value !== "number" || !(value > 0)) return `limits.${key} is a number over 0`;
  }
  for (const origin of line.origins ?? []) {
    if (!originOk(origin)) return `"${origin}" isn't an origin (https://example.com)`;
  }
  return undefined;
}

/** What's wrong with how the app knows who's calling, and how many calls it takes at once. */
export function settingsProblem(resources: Resources): string | undefined {
  const { caller, atOnce } = settingsOf({ resources });
  if (atOnce !== undefined && !(Number.isInteger(atOnce) && atOnce > 0)) {
    return "atOnce is a whole number over 0";
  }
  if (!caller) return undefined;
  if (typeof caller.header !== "string" || !/^[a-z0-9-]{1,64}$/i.test(caller.header)) {
    return "caller.header is a header's name (cf-connecting-ip, x-forwarded-for)";
  }
  if (caller.front === undefined && caller.hops === undefined) {
    return "caller says why its header is believed: the front's secret (front), or hops";
  }
  if (
    caller.front !== undefined && (typeof caller.front !== "string" || caller.front.length < 16)
  ) {
    return "caller.front is the front's secret (16 characters at least)";
  }
  if (caller.hops !== undefined && !(Number.isInteger(caller.hops) && caller.hops > 0)) {
    return "caller.hops is a whole number over 0";
  }
  const header = caller.header.toLowerCase();
  if (header === "forwarded") return "caller.header: Forwarded isn't read (use x-forwarded-for)";
  if (LISTS.includes(header) && caller.hops === undefined) {
    return `caller.header ${header} is a list whose first entries the caller writes: say its hops`;
  }
  const bad = (caller.exempt ?? []).find((range) => !rangeOk(range));
  if (bad !== undefined) return `caller.exempt: "${bad}" isn't a CIDR range (192.0.2.0/24)`;
  return undefined;
}

/** Whether `text` is an origin as browsers send it: a scheme and a host, nothing more. */
export function originOk(text: string): boolean {
  try {
    const url = new URL(text);
    return /^https?:$/.test(url.protocol) && url.origin === text;
  } catch {
    return false;
  }
}
