/**
 * The line's tools, as the MCP route answers about them:
 *
 * - **Which:** those the line lists that have a `tool:<name>` View (`llm`):
 *   what a model outside reads of a tool is the app's choice, never its
 *   output as it is, so a tool without one isn't offered (and the route
 *   says so once, in the log). One whose `offer` says no to a contact isn't
 *   listed (see views/offered.ts), and isn't run.
 * - **`tools/list`** (`listed`): each, in order: its name, title and
 *   description, its input's schema (with an optional `chat`, the handle,
 *   when the line gives handles), its hints as MCP names them
 *   (`readOnlyHint`…, each said, MCP's defaults where the app says nothing),
 *   what ChatGPT shows while and after it runs, and that it needs no
 *   sign-in (`securitySchemes`, also in `_meta` for clients that read only
 *   that).
 * - **`tools/call`** (`called`): which conversation the call is (see
 *   shared/keys.ts), then `mcp.call` as that conversation's contact, with
 *   the call's id: the owner joins a request sent again while the first
 *   runs. A call that names no conversation gets a handle, said once, at the
 *   end of its answer (`chat: <handle>`): a model reads only an answer's
 *   content (a result's `_meta` is the host's, never the model's), so
 *   that's where it must be. On a line without handles, it's refused.
 */
import type { Actor, Runtime } from "../../../../runtime/mod.ts";
import type { Tool } from "../../../agents/chat/contract.ts";
import type { Called } from "../actions/call.ts";
import { addressOf, inRanges } from "../shared/caller.ts";
import {
  addressKey,
  callIdOf,
  conversationOf,
  HANDLE,
  type Key,
  newHandle,
  type Scope,
  userOf,
} from "../shared/keys.ts";
import { callerOf, hintsOf, type Line } from "../shared/settings.ts";
import type { Offering } from "../views/offered.ts";

type Resources = Record<string, Record<string, unknown>>;

/** Who needs no sign-in: every tool, until a line signs people in. */
const NOAUTH = [{ type: "noauth" }];

/** What a tool's input says, as far as the route looks into it. */
type Schema = { type?: unknown; properties?: Record<string, unknown>; [key: string]: unknown };

const toolsOf = (resources: Resources) => (resources.tools ?? {}) as Record<string, Tool>;

/** Lines already told about in the log, by runtime: once each. */
const told = new WeakMap<object, Set<string>>();

/** The tools the line lists that have their `tool:<name>` View; the others, said once in the log. */
export function usable(
  runtime: Pick<Runtime, "describe">,
  line: Line,
): string[] {
  const { views } = runtime.describe();
  const names = Object.keys(line.tools);
  const shown = names.filter((name) => views[`tool:${name}`]?.includes("llm"));
  const left = names.filter((name) => !shown.includes(name));
  const seen = told.get(runtime) ?? new Set<string>();
  told.set(runtime, seen);
  if (left.length && !seen.has(line.name)) {
    seen.add(line.name);
    console.error(
      `mcp.${line.name}: not offered, without a tool:<name> View (llm): ${left.join(", ")}`,
    );
  }
  return shown;
}

/**
 * Of `names`, those a contact is offered, before any conversation (a
 * stand-in contact, in no chat yet): only tools whose `offer` is a function
 * are asked; nothing is read when none is.
 */
export async function offeredOf(
  runtime: Pick<Runtime, "describe" | "observe">,
  line: Line,
  names: string[],
): Promise<string[]> {
  const tools = toolsOf(runtime.describe().resources);
  if (!names.some((name) => typeof tools[name]?.offer === "function")) return names;
  const actor: Actor = {
    kind: "contact",
    id: "c-mcp-listing",
    mcp: line.name,
    client: line.client,
  };
  const item: Offering = {
    tools: names,
    thread: { _id: "", in: line.in, at: "" },
    agent: line.client,
  };
  const seen = runtime.observe<string[]>("mcp", "mcp:offered", item, {
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
function inputOf(line: Line, tool: Tool): Schema {
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
function mcpHintsOf(line: Line, name: string, tool: Tool) {
  const said = hintsOf(line, name, tool);
  const readOnly = said.readOnly ?? false;
  return {
    readOnlyHint: readOnly,
    // Meaningful only for a tool that changes something.
    destructiveHint: said.destructive ?? !readOnly,
    idempotentHint: said.idempotent ?? readOnly,
    openWorldHint: said.openWorld ?? true,
  };
}

/** The tools `names` (the line's), as `tools/list` answers them. */
export function listed(line: Line, resources: Resources, names: string[]) {
  const tools = toolsOf(resources);
  return names.map((name) => {
    const tool = tools[name];
    const how = line.tools[name];
    const title = how.title ?? tool.title;
    return {
      name,
      ...(title ? { title } : {}),
      description: tool.description,
      inputSchema: inputOf(line, tool),
      annotations: mcpHintsOf(line, name, tool),
      securitySchemes: NOAUTH,
      _meta: {
        ...(how.invoking ? { "openai/toolInvocation/invoking": how.invoking } : {}),
        ...(how.invoked ? { "openai/toolInvocation/invoked": how.invoked } : {}),
        securitySchemes: NOAUTH,
      },
    };
  });
}

/**
 * The input properties a tool mirrors into headers (`x-mcp-header`, MCP
 * 2026-07-28): each header's name and where its value is in the input.
 */
export function mirrored(line: Line, name: string, resources: Resources) {
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
 * Runs a call (`tools/call`) on the line, for its conversation, and answers
 * as MCP does: the text, and `isError` when it didn't work. `request` is the
 * JSON-RPC request's id.
 */
export async function called(
  runtime: Pick<Runtime, "call" | "describe">,
  line: Line,
  scope: Scope & { secret: string },
  call: {
    tool: string;
    input: Record<string, unknown>;
    request: string | number;
    said: Said;
    http: Request;
  },
) {
  const { secret } = scope;
  const input = { ...call.input };
  const given = input.chat;
  if (line.handles) delete input.chat;
  let key: Key;
  let made: string | undefined;
  let by: "session" | "handle" | "new";
  if (call.said.session !== undefined) {
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
  const { contact, thread } = await conversationOf(secret, scope, key);
  const id = await callIdOf(thread, call.request, call.tool, input);
  const user = call.said.subject ? await userOf(secret, scope, call.said.subject) : undefined;
  const caller = callerOf({ resources: runtime.describe().resources });
  const at = addressOf(call.http, caller);
  const address = at && !inRanges(at, caller?.exempt) ? await addressKey(secret, at) : undefined;
  const done = await runtime.call<Called>(
    "mcp.call",
    {
      line: line.name,
      tool: call.tool,
      input,
      call: id,
      by,
      ...(user ? { user } : {}),
      ...(address ? { address } : {}),
    },
    { actor: { kind: "contact", id: contact, mcp: line.name, client: line.client }, id },
  );
  const text = done.text.length > line.limits.result
    ? `${done.text.slice(0, line.limits.result)}\n[…cut]`
    : done.text;
  // The handle, once: in the answer that made the conversation.
  return answer(made && done.ran ? `${text}\n\nchat: ${made}` : text, !!done.isError);
}

const answer = (text: string, isError: boolean) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});
