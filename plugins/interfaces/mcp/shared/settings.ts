/**
 * The MCP plugin's settings (the `mcp` resource): the lines the app
 * declares, by name. Each is an MCP server at `/mcp/<name>` that a model
 * outside (ChatGPT, Claude, any MCP client) calls the app's tools through:
 * which tools, how they're shown, the space its conversations' chats live
 * in, and its limits. `lineOf` gives a line with every default filled in,
 * as the plugin uses it; `problemOf` says what's wrong with one, at start.
 */
import type { Resources } from "../../../../runtime/mod.ts";
import { agentsOf, SEND, type Tool, type ToolAnnotations } from "../../../agents/chat/contract.ts";

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
  /** Calls one conversation may make a minute, and all of the line's conversations together. */
  perMinute: number;
  linePerMinute: number;
  /** New conversations the line takes an hour, and one user starts there (ChatGPT's `openai/subject`). */
  chatsPerHour: number;
  userChatsPerHour: number;
  /** Characters a call's answer may say: past them, it's cut. */
  result: number;
};

/** A line the app declares: an MCP server open to anyone, at `/mcp/<name>`. */
export type McpLine = {
  /** The space its conversations' chats live in (declared with the spaces plugin's `spaces`, or not). */
  in: string;
  /**
   * The tools it offers, by name (the `tools` resource's), each with how
   * it's offered (`{}` as it is); unless said, those of `agent`.
   */
  tools?: Record<string, McpTool | null>;
  /** An agent of the app whose tools it offers (all of them but `send_message`) when `tools` doesn't say. */
  agent?: string;
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
   * calls go on in one chat; off, each of its calls is a chat of its own.
   * On unless said; a line only ChatGPT uses can turn it off, so its model
   * isn't shown the field.
   */
  handles?: boolean;
  /** The browser origins it answers (`Origin`), when said; else any (it takes no cookie). */
  origins?: string[];
  limits?: Partial<McpLimits>;
  /** With the orgs host, the org it's for (its id): no other org has it. */
  org?: string;
};

export type McpSettings = { lines?: Record<string, McpLine> };

/**
 * What a line takes, unless it says: a request of 64 KiB (a tool's input
 * is small); 30 calls a minute from one conversation, 600 from all; 600 new
 * conversations an hour, 30 from one user; answers of 100,000 characters.
 */
export const LIMITS: McpLimits = {
  body: 65_536,
  perMinute: 30,
  linePerMinute: 600,
  chatsPerHour: 600,
  userChatsPerHour: 30,
  result: 100_000,
};

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

/**
 * The app's own lines, by name, here: with the orgs host (each org's runtime
 * knows its org, `resources.org`), only those that name this org; a line
 * naming none is the single-org app's.
 */
export const linesOf = (ctx: { resources: Resources }): Record<string, McpLine> => {
  const all = ((ctx.resources.mcp ?? {}) as McpSettings).lines ?? {};
  const org = (ctx.resources.org as { id?: string } | undefined)?.id;
  return Object.fromEntries(
    Object.entries(all).filter(([, line]) => line && (org ? line.org === org : !line.org)),
  );
};

/** The names of the tools a line offers: its own list, else its agent's. */
function offeredBy(line: McpLine, resources: Resources): string[] {
  if (line.tools) return Object.keys(line.tools).filter((name) => line.tools![name] !== null);
  const agent = line.agent ? agentsOf({ resources })[line.agent] : undefined;
  return (agent?.tools ?? []).filter((name) => name !== SEND);
}

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
    tools: Object.fromEntries(
      offeredBy(line, ctx.resources).map((tool) => [tool, line.tools?.[tool] ?? {}]),
    ),
    limits: { ...LIMITS, ...line.limits },
  };
}

/** Tool names an MCP client takes as they are. */
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** What's wrong with a line's settings, if anything (checked when the app starts). */
export function problemOf(name: string, line: McpLine, resources: Resources): string | undefined {
  if (!/^[\w-]{1,60}$/.test(name)) return "its name is letters, digits, - and _";
  if (typeof line?.in !== "string" || !line.in) return "needs its in (the space its chats live in)";
  const agents = agentsOf({ resources });
  if (line.agent !== undefined && !Object.hasOwn(agents, line.agent)) {
    return `its agent "${line.agent}" isn't one the app declares`;
  }
  if (!line.tools && !line.agent) return "needs its tools, or an agent whose tools it offers";
  const tools = (resources.tools ?? {}) as Record<string, Tool | null>;
  const offered = offeredBy(line, resources);
  if (!offered.length) return "offers no tool";
  const client = line.client ?? name;
  if (Object.hasOwn(agents, client)) return `its client "${client}" is an agent's name`;
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
    const how = line.tools?.[tool] ?? {};
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

/** Whether `text` is an origin as browsers send it: a scheme and a host, nothing more. */
export function originOk(text: string): boolean {
  try {
    const url = new URL(text);
    return /^https?:$/.test(url.protocol) && url.origin === text;
  } catch {
    return false;
  }
}
