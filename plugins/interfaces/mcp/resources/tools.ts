/**
 * The line's tools, as the MCP route answers about them:
 *
 * - **`tools/list`** (`listed`): each tool the line offers, in order: its
 *   name, title and description, its input's schema (with an optional
 *   `chat`, the handle, when the line gives handles), its hints as MCP
 *   names them (`readOnlyHint`…, each said, MCP's defaults where the app
 *   says nothing), what ChatGPT shows while and after it runs, and that it
 *   needs no sign-in (`securitySchemes`, also in `_meta` for clients that
 *   read only that).
 * - **`tools/call`** (`called`): which conversation the call is (see
 *   shared/keys.ts), then `mcp.call` as that conversation's contact, with
 *   the call's id: the owner joins a request sent again while the first
 *   runs. A handle the conversation goes by is the answer's last line
 *   (`chat: <handle>`).
 */
import type { Runtime } from "../../../../runtime/mod.ts";
import type { Tool } from "../../../agents/chat/contract.ts";
import type { Called } from "../actions/call.ts";
import {
  callIdOf,
  conversationOf,
  HANDLE,
  type Key,
  newHandle,
  type Scope,
  userOf,
} from "../shared/keys.ts";
import type { Line } from "../shared/settings.ts";

/** Who needs no sign-in: every tool, until a line signs people in. */
const NOAUTH = [{ type: "noauth" }];

/** What a tool's input says, as far as the route looks into it. */
type Schema = { type?: unknown; properties?: Record<string, unknown>; [key: string]: unknown };

const toolsOf = (resources: Record<string, Record<string, unknown>>) =>
  (resources.tools ?? {}) as Record<string, Tool>;

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
        description: "This conversation's handle, from the last line of an earlier answer " +
          "(chat: …). Leave it out the first time.",
      },
    },
  };
}

/** MCP's hints for a tool, each said: the app's where it says, else what MCP assumes. */
function hintsOf(line: Line, name: string, tool: Tool) {
  const said = { ...tool.annotations, ...line.tools[name].annotations };
  const readOnly = said.readOnly ?? false;
  return {
    readOnlyHint: readOnly,
    // Meaningful only for a tool that changes something.
    destructiveHint: said.destructive ?? !readOnly,
    idempotentHint: said.idempotent ?? readOnly,
    openWorldHint: said.openWorld ?? true,
  };
}

/** The line's tools, as `tools/list` answers them. */
export function listed(line: Line, resources: Record<string, Record<string, unknown>>) {
  const tools = toolsOf(resources);
  return Object.entries(line.tools).map(([name, how]) => {
    const tool = tools[name];
    const title = how.title ?? tool.title;
    return {
      name,
      ...(title ? { title } : {}),
      description: tool.description,
      inputSchema: inputOf(line, tool),
      annotations: hintsOf(line, name, tool),
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
export function mirrored(
  line: Line,
  name: string,
  resources: Record<string, Record<string, unknown>>,
): { header: string; path: string[] }[] {
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
  runtime: Pick<Runtime, "call">,
  line: Line,
  scope: Scope & { secret: string },
  call: { tool: string; input: Record<string, unknown>; request: string | number; said: Said },
) {
  const { secret } = scope;
  const input = { ...call.input };
  const given = input.chat;
  if (line.handles) delete input.chat;
  let key: Key;
  let handle: string | undefined;
  let by: "session" | "handle" | "new";
  if (call.said.session !== undefined) {
    key = {
      session: call.said.session,
      ...(call.said.subject ? { subject: call.said.subject } : {}),
    };
    by = "session";
  } else if (line.handles && given !== undefined) {
    if (typeof given !== "string" || !HANDLE.test(given)) {
      return answer(
        "That chat handle isn't one this app gave: leave `chat` out to start a new " +
          "conversation.",
        true,
      );
    }
    key = { handle: given };
    handle = given;
    by = "handle";
  } else if (line.handles) {
    handle = newHandle();
    key = { handle };
    by = "new";
  } else {
    key = { fresh: crypto.randomUUID() };
    by = "new";
  }
  const { contact, thread } = await conversationOf(secret, scope, key);
  const id = await callIdOf(thread, call.request, call.tool, input);
  const user = call.said.subject ? await userOf(secret, scope, call.said.subject) : undefined;
  const done = await runtime.call<Called>(
    "mcp.call",
    { line: line.name, tool: call.tool, input, call: id, by, ...(user ? { user } : {}) },
    { actor: { kind: "contact", id: contact, mcp: line.name, client: line.client }, id },
  );
  const text = done.text.length > line.limits.result
    ? `${done.text.slice(0, line.limits.result)}\n[…cut]`
    : done.text;
  return answer(handle && done.kept ? `${text}\n\nchat: ${handle}` : text, !!done.isError);
}

const answer = (text: string, isError: boolean) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});
