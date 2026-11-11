/**
 * The MCP plugin's settings (the `mcp` resource): the servers the app
 * declares, by name, as a flat map (how it knows who's calling is the
 * runtime's `caller` resource). Each is an MCP server at `/mcp/<name>` that
 * a model outside (ChatGPT, Claude, any MCP client) calls the app's tools
 * through: which tools, how they're shown, the space its conversations'
 * chats live in, and its limits. `serverOf` gives a server with every
 * default filled in, as the plugin uses it; `problemOf` says what's wrong
 * with one, at start.
 */
import { callerOf, callerProblem, exemptProblem, type Resources } from "../../../../runtime/mod.ts";
import { agentsOf, SEND, type Tool, type ToolAnnotations } from "../../../agents/chat/contract.ts";

/** Who may call an entry: the model, the app's own widget (MCP Apps' `ui.visibility`). */
export type Visibility = "model" | "app";

/**
 * How one of the app's tools is offered on a server: what only MCP needs. Or, with `action`, one
 * of the app's Actions offered to the server's widgets alone: what a person does by hand in a
 * widget (a form sent, a tap), never the model's to call.
 */
export type McpTool = {
  /** What people see it called, instead of the tool's own `title` (or its name). */
  title?: string;
  /** Its hints (read-only, destructive…), over the tool's own `annotations`. */
  annotations?: ToolAnnotations;
  /**
   * Reuse a completed model tool call's answer for identical input (true by default).
   * Set false for checks that update state and must run fresh. Interrupted calls still retry
   * as themselves. Read-only tools and widget-only Actions do not reuse completed answers.
   */
  replay?: boolean;
  /** What ChatGPT shows while it runs, and once it's done (64 characters at most). */
  invoking?: string;
  invoked?: string;
  /**
   * The web View its calls are shown through in a widget (an MCP Apps host draws it: ChatGPT,
   * Claude): a View kind of the app's widget front ends (`widgetsOf`), given the call as its
   * item (`{ _id, name, input, output }`) and hints `{ thread, mode, surface: "widget" }`.
   * Its output goes to the widget as it is (its caller's own: never the model's), so a tool
   * drawn by a widget returns nothing its caller mustn't see.
   */
  widget?: string;
  /**
   * Who calls it: the model and the app's widgets (`["model", "app"]`, unless said), or the
   * widgets alone (`["app"]`): never listed for the model, and refused unless the call carries
   * the widget's grant (which only results' `_meta` hold: the host's, never the model's).
   */
  visibility?: Visibility[];
  /**
   * An Action of the app's (its name) instead of a tool: called as the conversation's contact
   * (its `allow` decides, the rules keep it to the contact's own), by the widgets alone
   * (`visibility` is `["app"]`); its result goes to the widget, never in the model's content.
   */
  action?: string;
  /** For an Action, what hosts are told it does (the Action's own description unless said). */
  description?: string;
};

/**
 * A server's widgets: how the template the app's widget Views are drawn in is offered (MCP Apps'
 * resource `_meta.ui`, and ChatGPT's aliases).
 */
export type McpWidgets = {
  /**
   * The widgets' own origin in the host (`ui.domain`, `openai/widgetDomain`): ChatGPT requires
   * one, unique to the app, when it's submitted (`https://widgets.example.com`). The host's
   * default sandbox unless said.
   */
  domain?: string;
  /** Whether the host should draw them in a bordered card (`ui.prefersBorder`). */
  prefersBorder?: boolean;
  /** What the model is told a widget shows, once drawn (`openai/widgetDescription`). */
  description?: string;
};

/** What a server takes before it says no: see `LIMITS`. */
export type McpLimits = {
  /** Bytes a request's body may be. */
  body: number;
  /**
   * Calls running at once on the server, and from one caller's address, and in
   * one conversation: past any, the server is busy.
   */
  atOnce: number;
  addressAtOnce: number;
  chatAtOnce: number;
  /**
   * Seconds the route waits for a call's answer: past them, the model is told it's still
   * working, and to ask again (the call goes on); and seconds a call may run in all: past them,
   * it's stopped. Tools should honour `ctx.signal`, which aborts when one is stopped: one that
   * doesn't goes on in the background, and what it does outside then is keyed by its `callId`.
   */
  timeout: number;
  stop: number;
  /**
   * Calls going on past the timeout, on the server and started from one address: past them, a
   * call that reaches the timeout is stopped, so cheap requests can't hold places for slow tools.
   */
  lateAtOnce: number;
  addressLateAtOnce: number;
  /** Calls one conversation may make a minute, and all of the server's conversations together. */
  perMinute: number;
  linePerMinute: number;
  /** New conversations the server takes an hour, and one user starts there (ChatGPT's `openai/subject`). */
  chatsPerHour: number;
  userChatsPerHour: number;
  /** Calls a minute, and new conversations an hour, from one caller's address (see `McpCaller`). */
  ipPerMinute: number;
  ipChatsPerHour: number;
  /** Characters a call's answer may say: past them, it's cut. */
  result: number;
};

/** A server the app declares: an MCP server open to anyone, at `/mcp/<name>`. */
export type DeclaredServer = {
  /** The space its conversations' chats live in (declared with the spaces plugin's `spaces`, or not). */
  in: string;
  /**
   * The tools it offers, by name (the `tools` resource's), each with how
   * it's offered (`{}` as it is). Only these: an app lists what a model
   * outside may call. Each needs its `tool:<name>` View (`llm`), what a
   * model reads of it: without one, the app doesn't start.
   */
  tools: Record<string, McpTool | null>;
  /** What it's called, its version, and what the model is told about using it. */
  title?: string;
  version?: string;
  instructions?: string;
  /**
   * Who calls (`ChatGPT`), as its chats show it: the sender of their steps,
   * and their title. The server's name unless said.
   */
  client?: string;
  /**
   * A client that names no conversation (no `openai/session`, which ChatGPT
   * sends) gets a handle to name it with (`chat`, on every tool), so its
   * calls go on in one chat. Off, a call that names no conversation is
   * refused. On unless said; a server only ChatGPT uses turns it off, so its
   * model isn't shown the field, and nobody else gets a chat there.
   */
  handles?: boolean;
  /** The browser origins it answers (`Origin`, or `"*"` for any): none unless said (no browser calls MCP). */
  origins?: string[];
  /**
   * Its widgets (with the app's `widgets` resource, `widgetsOf`): the template's options. A server
   * whose tools name a `widget`, or that offers Actions, offers widgets, and the widgets' read
   * tool (`READ`: what a widget reads that its snapshot didn't have).
   */
  widgets?: McpWidgets;
  limits?: Partial<McpLimits>;
  /**
   * Callers whose address is in these CIDR ranges (a shared proxy's: OpenAI's egress, every
   * ChatGPT user's calls behind a few addresses) aren't limited by address; the server's other
   * limits still hold. Only an address read through the app's `caller` resource counts.
   */
  exempt?: string[];
};

/** The `mcp` resource: the declared servers, by name. */
export type McpSettings = Record<string, DeclaredServer>;

/**
 * What a server takes, unless it says: a request of 64 KiB (a tool's input
 * is small); 4 calls at once, 2 from one address and 2 in one conversation
 * (4: what an executor takes at once today, its connection's queue the
 * limit); 20 seconds' wait for an answer, and a minute for a call in all,
 * with 2 going on past the wait on the server, 1 from one address; 30 calls a minute from one
 * conversation, 600 from all; 600 new conversations an hour, 30 from one
 * user; from one address, 60 calls a minute and 20 new conversations an
 * hour; answers of 100,000 characters.
 */
export const LIMITS: McpLimits = {
  body: 65_536,
  atOnce: 4,
  addressAtOnce: 2,
  chatAtOnce: 2,
  timeout: 20,
  stop: 60,
  lateAtOnce: 2,
  addressLateAtOnce: 1,
  perMinute: 30,
  linePerMinute: 600,
  chatsPerHour: 600,
  userChatsPerHour: 30,
  ipPerMinute: 60,
  ipChatsPerHour: 20,
  result: 100_000,
};

/** The longest ChatGPT shows a call's status line. */
const STATUS = 64;

/** A server as the plugin uses it: its settings, its name, and every default filled in. */
export type Server = Omit<DeclaredServer, "tools" | "limits"> & {
  name: string;
  client: string;
  handles: boolean;
  version: string;
  /** The tools it offers, in order, each with how. */
  tools: Record<string, McpTool>;
  limits: McpLimits;
};

/** Where every server is: `/mcp/<name>`. */
export const PATH = "/mcp/";

/** The widgets' own tool: what a widget reads as the conversation's contact (queries only). */
export const READ = "copilotz_read";

/** Who may call an entry: as it says, else the model and the widgets; an Action, the widgets. */
export const visibilityOf = (entry: McpTool): Visibility[] =>
  entry.visibility ?? (entry.action ? ["app"] : ["model", "app"]);

/** Whether only the widgets call an entry (never the model). */
export const appOnly = (entry: McpTool): boolean => !visibilityOf(entry).includes("model");

/** Whether a server offers widgets: a tool shown through one, or an Action they call. */
export const hasWidgets = (line: Pick<Server, "tools">): boolean =>
  Object.values(line.tools).some((entry) => entry.widget || entry.action);

/** The servers the app declares, by name. */
export const serversOf = (ctx: { resources: Resources }): McpSettings =>
  Object.fromEntries(
    Object.entries((ctx.resources.mcp ?? {}) as McpSettings).filter(([, server]) => server),
  );

/** The names of the tools a server lists. */
const listedBy = (line: DeclaredServer) =>
  Object.keys(line.tools ?? {}).filter((name) => line.tools[name] !== null);

/** The server `name`, ready to use; undefined when the app declares none by that name. */
export function serverOf(ctx: { resources: Resources }, name: string): Server | undefined {
  const servers = serversOf(ctx);
  const line = Object.hasOwn(servers, name) ? servers[name] : undefined;
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

/** A tool's hints as a server offers it: the tool's own, then the server's over them. */
export const hintsOf = (line: Server, name: string, tool: Tool): ToolAnnotations => ({
  ...tool.annotations,
  ...line.tools[name]?.annotations,
});

/** Tool names an MCP client takes as they are. */
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * What's wrong with a server's settings, if anything (checked when the app starts): `actions`
 * are the app's Actions' names, which an entry's `action` must be one of.
 */
export function problemOf(
  name: string,
  line: DeclaredServer,
  resources: Resources,
  actions: readonly string[] = [],
  views: readonly string[] = [],
): string | undefined {
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
    const how = line.tools[tool] ?? {};
    if (tool === READ) return `${READ} is the widgets' own tool, not a name to offer`;
    if (!NAME.test(tool)) return `"${tool}" isn't a name MCP takes (A-Z, a-z, 0-9, _ . -)`;
    const seen = how.visibility;
    if (
      seen !== undefined &&
      (!Array.isArray(seen) || !seen.length || seen.some((v) => v !== "model" && v !== "app"))
    ) {
      return `tools.${tool}.visibility is "model" and or "app"`;
    }
    if (how.widget !== undefined && (typeof how.widget !== "string" || !how.widget)) {
      return `tools.${tool}.widget is a View's kind`;
    }
    let own: Tool | undefined;
    if (how.action !== undefined) {
      if (typeof how.action !== "string" || !actions.includes(how.action)) {
        return `tools.${tool}.action "${how.action}" isn't one of the app's Actions`;
      }
      if (!appOnly(how)) {
        return `tools.${tool} is an Action: only the widgets call it (visibility ["app"])`;
      }
      if (how.widget) return `tools.${tool} is an Action: its widget is the one that called it`;
    } else {
      own = Object.hasOwn(tools, tool) ? tools[tool] ?? undefined : undefined;
      if (tool === SEND) return `${SEND} is agents' own, not a tool to offer`;
      if (!own) return `offers "${tool}", which isn't one of the app's tools`;
      // What a model outside reads of a call is the app's choice, never its output as it is.
      if (!views.includes(`tool:${tool}`)) {
        return `offers "${tool}" without its tool:${tool} View: what a model outside reads of it`;
      }
      const input = own.input as
        | { type?: unknown; properties?: Record<string, unknown> }
        | undefined;
      if (input && input.type !== "object") return `"${tool}" takes an object (its input's type)`;
      if ((line.handles ?? true) && input?.properties && Object.hasOwn(input.properties, "chat")) {
        return `"${tool}" has an input called chat, which handles take: set handles: false`;
      }
    }
    for (const field of ["invoking", "invoked"] as const) {
      const text = how[field];
      if (text !== undefined && (typeof text !== "string" || !text || text.length > STATUS)) {
        return `tools.${tool}.${field} is text of ${STATUS} characters at most`;
      }
    }
    if (how.replay !== undefined && typeof how.replay !== "boolean") {
      return `tools.${tool}.replay is true or false`;
    }
    for (const [hint, value] of Object.entries({ ...own?.annotations, ...how.annotations })) {
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
  const exempt = exemptProblem(line.exempt);
  if (exempt) return exempt;
  for (const origin of line.origins ?? []) {
    if (origin !== "*" && !originOk(origin)) {
      return `"${origin}" isn't an origin (https://example.com, or "*")`;
    }
  }
  const domain = line.widgets?.domain;
  if (
    domain !== undefined &&
    (typeof domain !== "string" || !/^https:\/\//.test(domain) || !originOk(domain))
  ) {
    return `widgets.domain "${domain}" isn't an https origin (https://widgets.example.com)`;
  }
  return undefined;
}

/** What's wrong with how the app knows who's calling, if anything. */
export const settingsProblem = (resources: Resources): string | undefined =>
  callerProblem(callerOf({ resources }));

/** Whether `text` is an origin as browsers send it: a scheme and a host, nothing more. */
export function originOk(text: string): boolean {
  try {
    const url = new URL(text);
    return /^https?:$/.test(url.protocol) && url.origin === text;
  } catch {
    return false;
  }
}
