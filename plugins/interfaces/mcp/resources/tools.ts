/**
 * The line's tools, as the MCP route answers about them:
 *
 * - **Which:** those the line lists that have a `tool:<name>` View (`llm`):
 *   what a model outside reads of a tool is the app's choice, never its
 *   output as it is, so a tool without one isn't offered (and the route
 *   says so once, in the log). One whose `offer` says no to a contact isn't
 *   listed (see views/offered.ts), and isn't run. Listing asks offers for a
 *   stand-in contact in no chat yet, the same for everyone (kept a minute):
 *   an offer that depends on the chat is listed unless it says no to the
 *   stand-in, and asked again, for the real chat, when it's called.
 * - **`tools/list`** (`listed`): each, in order: its name, title and
 *   description, its input's schema (with an optional `chat`, the handle,
 *   when the line gives handles), its hints as MCP names them
 *   (`readOnlyHint`…, each said, MCP's defaults where the app says nothing),
 *   what ChatGPT shows while and after it runs, and that it needs no
 *   sign-in (`securitySchemes`, also in `_meta` for clients that read only
 *   that).
 * - **`tools/call`** (`called`): which conversation the call is (see
 *   shared/keys.ts). The same call (tool and input) already running in it,
 *   sent again from anywhere under any request id, waits for that run.
 *   Else it takes its places (the runtime's, the line's, the address's, the
 *   conversation's), held until it's done, and runs `mcp.call` as the
 *   conversation's contact (with who the user and the address are, as
 *   HMACs, for their limits: in its input, which no log keeps). The route
 *   waits the line's `timeout` (20 s) for its answer; past it, the model is
 *   told it's still working, and to ask again: the call goes on (while few
 *   do: `lateAtOnce`, 2 on the line, 1 from an address; else it's stopped),
 *   and asked again, under any request id, it answers what it did, from its
 *   receipt (a tool that changes things does it once). One still running
 *   past `stop` (60 s) is stopped: tools should honour `ctx.signal`. A call that names no conversation gets a handle, said once, at the
 *   end of its answer (`chat: <handle>`): a model reads only an answer's
 *   content (a result's `_meta` is the host's, never the model's), so
 *   that's where it must be. On a line without handles, it's refused.
 */
import type { Actor, Caller, Runtime } from "../../../../runtime/mod.ts";
import type { Tool } from "../../../agents/chat/contract.ts";
import type { Called } from "../actions/call.ts";
import {
  addressKey,
  callIdOf,
  conversationsOf,
  HANDLE,
  type Key,
  newHandle,
  sameCallOf,
  type Scope,
  threadOf,
  userOf,
} from "../shared/keys.ts";
import {
  appOnly,
  hasWidgets,
  hintsOf,
  READ,
  type Server,
  visibilityOf,
} from "../shared/settings.ts";
import type { Offering } from "../views/offered.ts";
import { busy, hold } from "./running.ts";

type Resources = Record<string, Record<string, unknown>>;

/** Who needs no sign-in: every tool, until a line signs people in. */
const NOAUTH = [{ type: "noauth" }];

/** What a tool's input says, as far as the route looks into it. */
type Schema = { type?: unknown; properties?: Record<string, unknown>; [key: string]: unknown };

const toolsOf = (resources: Resources) => (resources.tools ?? {}) as Record<string, Tool>;

/** Lines already told about in the log, by runtime: once each. */
const told = new WeakMap<object, Set<string>>();

/**
 * The tools the line lists that have their `tool:<name>` View (an Action offered to the widgets
 * needs none: its result goes to the widget alone); the others, said once in the log.
 */
export function usable(
  runtime: Pick<Runtime, "describe">,
  line: Server,
): string[] {
  const { views } = runtime.describe();
  const names = Object.keys(line.tools);
  const shown = names.filter((name) =>
    line.tools[name].action !== undefined || views.includes(`tool:${name}`)
  );
  const left = names.filter((name) => !shown.includes(name));
  const seen = told.get(runtime) ?? new Set<string>();
  told.set(runtime, seen);
  if (left.length && !seen.has(line.name)) {
    seen.add(line.name);
    console.error(
      `mcp.${line.name}: not offered, without a tool:<name> View: ${left.join(", ")}`,
    );
  }
  return shown;
}

/**
 * Of `names`, those a contact is offered, before any conversation (a
 * stand-in contact, in no chat yet): only tools whose `offer` is a function
 * are asked; nothing is read when none is.
 */
export function offeredOf(
  runtime: Pick<Runtime, "describe" | "observe">,
  line: Server,
  names: string[],
): Promise<string[]> {
  const tools = toolsOf(runtime.describe().resources);
  const offers = (name: string) =>
    line.tools[name]?.action === undefined && typeof tools[name]?.offer === "function";
  if (!names.some(offers)) return Promise.resolve(names);
  // The same for every listing: asked once a minute, however many list at once.
  const lines = listings.get(runtime) ??
    new Map<string, { at: number; names: Promise<string[]> }>();
  listings.set(runtime, lines);
  const key = `${line.name}|${names.join(",")}`;
  const kept = lines.get(key);
  if (kept && Date.now() - kept.at < LISTED_MS) return kept.names;
  const asked = standIn(runtime, line, names);
  lines.set(key, { at: Date.now(), names: asked });
  asked.catch(() => lines.delete(key));
  return asked;
}

/** How long what's offered to a stand-in contact is kept. */
const LISTED_MS = 60_000;
const listings = new WeakMap<object, Map<string, { at: number; names: Promise<string[]> }>>();

/** What a stand-in contact, in no chat yet, is offered of `names`. */
async function standIn(
  runtime: Pick<Runtime, "observe">,
  line: Server,
  names: string[],
): Promise<string[]> {
  const actor: Actor = {
    kind: "contact",
    id: "c-mcp-listing",
    mcp: line.name,
    client: line.client,
  };
  const item: Offering = {
    tools: names,
    thread: { _id: "", in: line.in, agents: [], at: "" },
    agent: line.client,
  };
  const seen = runtime.observe<string[]>("mcp:offered", item, {
    actor,
    viewer: { kind: "agent", name: line.client },
  });
  try {
    const output = await seen.ready;
    return output.status === "ready" && Array.isArray(output.value) ? output.value : [];
  } finally {
    seen.close();
  }
}

/** A tool's input, as the line offers it: with the handle, when it gives them. */
function inputOf(line: Server, tool: Tool): Schema {
  const input = (tool.input ?? { type: "object" }) as Schema;
  if (!line.handles) return input;
  return {
    ...input,
    properties: {
      ...input.properties,
      chat: {
        type: "string",
        description: "This conversation's handle, from the end of its first answer " +
          "(chat: …). Leave it out the first time.",
      },
    },
  };
}

/** MCP's hints for a tool, each said: the app's where it says, else what MCP assumes. */
function mcpHintsOf(line: Server, name: string, tool: Pick<Tool, "annotations">) {
  const said = hintsOf(line, name, tool as Tool);
  const readOnly = said.readOnly ?? false;
  return {
    readOnlyHint: readOnly,
    // Meaningful only for a tool that changes something.
    destructiveHint: said.destructive ?? !readOnly,
    idempotentHint: said.idempotent ?? readOnly,
    openWorldHint: said.openWorld ?? true,
  };
}

/** What a widget's call carries beside its input: its grant, and the reads to answer after. */
export const GRANT = "_grant";
export const READS = "_reads";

/** An input as a widget's call takes it: with its grant (and, for an Action, reads to answer). */
const forWidgets = (input: Schema, reads: boolean): Schema => ({
  ...input,
  properties: {
    ...input.properties,
    [GRANT]: {
      type: "string",
      description: "The widget's grant: its host passes it, from the tool result that drew it.",
    },
    _call: { type: "string", description: "This call's own id: a retry of it sends the same." },
    ...(reads
      ? { [READS]: { type: "array", maxItems: 32, description: "Reads to answer after it." } }
      : {}),
  },
});

/** The widgets' read tool, as listed: only they call it. */
const readTool = () => ({
  name: READ,
  title: "Read",
  description: "What a widget of this app reads, as its conversation: named queries only.",
  inputSchema: forWidgets({
    type: "object",
    properties: { reads: { type: "array", maxItems: 32 } },
    required: ["reads"],
  }, false),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  securitySchemes: NOAUTH,
  _meta: {
    ui: { visibility: ["app"] },
    "openai/widgetAccessible": true,
    "openai/visibility": "private",
    securitySchemes: NOAUTH,
  },
});

/**
 * The tools `names` (the line's), as `tools/list` answers them. With widgets (`template`: the
 * URI of the page their Views are drawn in), each says who may call it (`ui.visibility`; ChatGPT's
 * `openai/visibility` and `openai/widgetAccessible`), a tool shown through a widget says its
 * template (`ui.resourceUri`, `openai/outputTemplate`), and the widgets' read tool is listed too.
 */
export function listed(
  line: Server,
  resources: Resources,
  names: string[],
  actions: Record<string, { description?: string; input?: unknown }> = {},
  template?: string,
) {
  const tools = toolsOf(resources);
  const widgets = !!template && hasWidgets(line);
  // Without widgets, what only they call isn't listed: nothing could call it.
  const entries = names.filter((name) => widgets || !appOnly(line.tools[name])).map((name) => {
    const how = line.tools[name];
    const action = how.action ? actions[how.action] : undefined;
    const tool = how.action ? undefined : tools[name];
    const title = how.title ?? tool?.title;
    const app = appOnly(how);
    const shown = !!(widgets && how.widget);
    const input = action ? (action.input ?? { type: "object" }) as Schema : inputOf(line, tool!);
    return {
      name,
      ...(title ? { title } : {}),
      description: action ? how.description ?? action.description ?? name : tool!.description,
      inputSchema: app ? forWidgets(input, !!action) : input,
      annotations: mcpHintsOf(line, name, tool ?? {}),
      securitySchemes: NOAUTH,
      _meta: {
        ...(how.invoking ? { "openai/toolInvocation/invoking": how.invoking } : {}),
        ...(how.invoked ? { "openai/toolInvocation/invoked": how.invoked } : {}),
        ...(widgets
          ? {
            ui: { visibility: visibilityOf(how), ...(shown ? { resourceUri: template } : {}) },
            ...(shown ? { "openai/outputTemplate": template } : {}),
            "openai/widgetAccessible": visibilityOf(how).includes("app"),
            ...(app ? { "openai/visibility": "private" } : {}),
          }
          : {}),
        securitySchemes: NOAUTH,
      },
    };
  });
  return widgets ? [...entries, readTool()] : entries;
}

/**
 * The input properties a tool mirrors into headers (`x-mcp-header`, MCP
 * 2026-07-28): each header's name and where its value is in the input.
 */
export function mirrored(line: Server, name: string, resources: Resources) {
  const found: { header: string; path: string[] }[] = [];
  if (!Object.hasOwn(line.tools, name)) return found;
  // Only along `properties`, as MCP says: never into lists or alternatives.
  const walk = (schema: Schema | undefined, path: string[]) => {
    for (const [key, value] of Object.entries(schema?.properties ?? {})) {
      const property = value as Schema;
      if (typeof property?.["x-mcp-header"] === "string") {
        found.push({ header: property["x-mcp-header"] as string, path: [...path, key] });
      }
      if (property?.properties) walk(property, [...path, key]);
    }
  };
  walk(toolsOf(resources)[name]?.input as Schema | undefined, []);
  return found;
}

/** What a call says about its conversation: ChatGPT's fields, in the request's `_meta`. */
export type Said = { session?: string; subject?: string };

/**
 * The conversation a key names: its contact and chat under the app's own
 * secret, or under the one before it (`links.previous`) when that's the one
 * there (made before the secret changed): the owner says which.
 */
export async function conversationHere(
  runtime: Pick<Runtime, "call">,
  scope: Scope & { secrets: string[] },
  key: Key,
): Promise<{ contact: string; thread: string }> {
  const each = await conversationsOf(scope.secrets, scope, key);
  if (each.length === 1) return each[0];
  const at = await runtime.call<number>("mcp.conversation", { conversations: each });
  return each[at] ?? each[0];
}

/**
 * Runs a call (`tools/call`) on the line, for its conversation, and answers
 * as MCP does: the text, and `isError` when it didn't work. `request` is the
 * JSON-RPC request's id.
 */
export async function called(
  runtime: Pick<Runtime, "call" | "cancel" | "describe">,
  line: Server,
  /** The line's scope, and the app's secrets (`secretsOf`: its own first). */
  scope: Scope & { secrets: string[] },
  call: {
    tool: string;
    input: Record<string, unknown>;
    request: string | number;
    said: Said;
    /** Who calls, as the app's front says (undefined without its `caller` settings). */
    caller?: Exclude<Caller, "refused">;
    /**
     * The conversation's contact, when a widget's grant named it (an app-only tool, called by
     * the line's widgets): its conversation must be one already; and its chat, as the route
     * found it.
     */
    contact?: string;
    thread?: string;
  },
): Promise<Answered> {
  const [secret] = scope.secrets;
  const input = { ...call.input };
  const given = input.chat;
  if (line.handles) delete input.chat;
  let key: Key | undefined;
  let made: string | undefined;
  let by: "session" | "handle" | "new";
  if (call.contact !== undefined) {
    by = "handle";
  } else if (call.said.session !== undefined) {
    key = {
      session: call.said.session,
      ...(call.said.subject ? { subject: call.said.subject } : {}),
    };
    by = "session";
  } else if (!line.handles) {
    return answer("This app answers ChatGPT conversations: this one didn't say which it is.", true);
  } else if (given !== undefined) {
    if (typeof given !== "string" || !HANDLE.test(given)) {
      return answer(
        "That chat handle isn't one this app gave: leave `chat` out to start a new " +
          "conversation.",
        true,
      );
    }
    key = { handle: given };
    by = "handle";
  } else {
    made = newHandle();
    key = { handle: made };
    by = "new";
  }
  // A widget's call names its conversation by its grant (the route found its chat).
  const { contact, thread } = call.contact !== undefined
    ? { contact: call.contact, thread: call.thread ?? await threadOf(secret, call.contact) }
    : await conversationHere(runtime, scope, key!);
  const [id, same] = await Promise.all([
    callIdOf(thread, call.request, call.tool, input),
    sameCallOf(thread, call.tool, input),
  ]);
  const user = call.said.subject ? await userOf(secret, scope, call.said.subject) : undefined;
  const counted = call.caller && !call.caller.exempt
    ? await addressKey(secret, call.caller.counted)
    : undefined;
  // The same call already running in this conversation (sent again, from anywhere, under any
  // request id): it waits for that run. Once it's ended, its receipt answers (see mcp.call).
  const pending = runningOf(runtime);
  sweep(runtime, pending, line);
  const address = call.caller && !call.caller.exempt ? call.caller.counted : undefined;
  let run = pending.get(same);
  // Whether this request's answer is its own run's, or another identical request's (it joined).
  const joined = !!run;
  if (!run) {
    const release = hold(runtime, [
      { key: `server:${line.name}`, most: line.limits.atOnce },
      ...(address
        ? [{ key: `address:${line.name}|${address}`, most: line.limits.addressAtOnce }]
        : []),
      { key: `chat:${line.name}|${thread}`, most: line.limits.chatAtOnce },
    ]);
    if (!release) throw busy();
    // Who the user and the address are go in the input: an unrecorded Action's input is never
    // in the log, and a request sent again from elsewhere joins the run here, not the owner's.
    const started = runtime.call<Called>(
      "mcp.call",
      {
        line: line.name,
        tool: call.tool,
        input,
        call: id,
        thread,
        by,
        ...(user ? { user } : {}),
        ...(counted ? { address: counted } : {}),
      },
      { actor: { kind: "contact", id: contact, mcp: line.name, client: line.client }, id },
    );
    // A call still running past `stop` is stopped: one that changes things runs again as itself
    // when it's asked again (its receipt isn't done).
    const stop = setTimeout(
      () => void runtime.cancel({ call: id }).catch(() => {}),
      line.limits.stop * 1000,
    );
    const mine: Run = {
      id,
      at: Date.now(),
      ...(address ? { address } : {}),
      settled: started.then((done) => ({ done }), (error) => ({ error })),
    };
    run = mine;
    pending.set(same, mine);
    void mine.settled.then(() => {
      mine.ended = true;
      clearTimeout(stop);
      release();
      mine.late?.();
      if (pending.get(same) === mine) pending.delete(same);
    });
  }
  // Waited for `timeout`; then it goes on, and the model is told to ask again.
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    waiting = setTimeout(() => resolve("late"), line.limits.timeout * 1000);
  });
  const outcome = await Promise.race([run.settled, late]).finally(() => clearTimeout(waiting));
  if (outcome === "late") {
    // Past the timeout, a call goes on only while few do: from one address, on the line. Past
    // those, it's stopped, so cheap requests can't keep the line's places for slow tools.
    if (!run.late && !run.ended) {
      const going = hold(runtime, [
        { key: `late:${line.name}`, most: line.limits.lateAtOnce },
        ...(run.address
          ? [{ key: `late:${line.name}|${run.address}`, most: line.limits.addressLateAtOnce }]
          : []),
      ]);
      if (!going) {
        void runtime.cancel({ call: run.id }).catch(() => {});
        return answer(CROWDED, true);
      }
      run.late = going;
    }
    if (!run.ended) return answer(STILL, true);
  }
  const ended = await run.settled;
  if ("error" in ended) {
    // Stopped: asked again, it runs again as itself.
    if ((ended.error as { code?: string }).code === "cancelled") return answer(STOPPED, true);
    throw ended.error;
  }
  const done = ended.done;
  const said = done.again || joined ? `${AGAIN}\n\n${done.text}` : done.text;
  const text = said.length > line.limits.result
    ? `${said.slice(0, line.limits.result)}\n[…cut]`
    : said;
  // The handle, once: in the answer that made the conversation.
  return {
    ...answer(made && done.ran ? `${text}\n\nchat: ${made}` : text, !!done.isError),
    // For a tool shown through a widget: whose conversation it is, and what the tool returned.
    conversation: {
      contact,
      thread,
      ...(done.output !== undefined ? { output: done.output, call: id } : {}),
    },
  };
}

/** How a call that's still running ends, for whoever waits on it. */
type Settled = { done: Called } | { error: unknown };

/**
 * A call running here: its id, when it began, the address it came from (counted, when it's
 * limited), how it ends, whether it has, and its place among calls past the timeout.
 */
type Run = {
  id: string;
  at: number;
  address?: string;
  settled: Promise<Settled>;
  ended?: true;
  late?: () => void;
};

/**
 * What an answer begins with when it's an identical, earlier request's (it ran once): so a model
 * asking twice on purpose (a second ticket) isn't told it was done twice.
 */
const AGAIN = "This same request was made moments ago, and it wasn't done again: this is what " +
  "it answered then.";

/** What the model is told of a call stopped past the line's `stop`. */
const STOPPED = "It was stopped before it finished: ask again with the same request to run it " +
  "again.";

/** What it's told of a call stopped at the timeout, when too many already run past it. */
const CROWDED = "It took too long, while too many calls here already do, so it was stopped: ask " +
  "again with the same request in a moment to run it again.";

/** What the model is told of a call still running past the line's `timeout`. */
const STILL = "Still working on it: the outcome isn't known yet. Ask again with the same request " +
  "(the same tool and input) to get it.";

/** Calls running now, by runtime, by conversation and what they ask (`sameCallOf`). */
const runs = new WeakMap<object, Map<string, Run>>();
const runningOf = (runtime: object) => {
  const found = runs.get(runtime) ?? new Map<string, Run>();
  runs.set(runtime, found);
  return found;
};

/**
 * Drops, at most once a minute, runs that should have ended long ago (past `stop` and a
 * margin): a run ends itself when its call does, so this only guards against one that never
 * settles. Swept as calls come, not by a timer, which would keep a host's process from ending.
 */
const swept = new WeakMap<object, number>();
function sweep(runtime: object, pending: Map<string, Run>, line: Server) {
  const now = Date.now();
  if (now - (swept.get(runtime) ?? 0) < 60_000) return;
  swept.set(runtime, now);
  const oldest = now - line.limits.stop * 1000 - 60_000;
  for (const [key, run] of pending) if (run.at < oldest) pending.delete(key);
}

const answer = (text: string, isError: boolean): Answered => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * What a call answers: MCP's content (and whether it's an error), and, when it ran, whose
 * conversation it was and (for a tool shown through a widget) what the tool returned: for the
 * route, which never sends it as it is.
 */
export type Answered = {
  content: { type: string; text: string }[];
  isError?: boolean;
  conversation?: { contact: string; thread: string; output?: string; call?: string };
};
