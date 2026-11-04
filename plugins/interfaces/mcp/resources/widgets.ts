/**
 * A line's widgets, as the MCP route answers about them (MCP Apps, SEP-1865, and ChatGPT's
 * Apps SDK aliases): the app's web Views drawn inside the assistant's conversation, through
 * the web host's widgets (`Served.widgets`: `widgetsOf`, which owns front-end code).
 *
 * - **The template** (`resources/list`, `resources/read`): one page for all of a line's
 *   widgets, `ui://<line>/widget-<version>.html`, `text/html;profile=mcp-app`; any older
 *   version's URI is answered with the current page (assistants keep a tool's template URI).
 *   Its `_meta` says the app's own origin may serve its fonts and images (`ui.csp`
 *   `resourceDomains`; ChatGPT's `openai/widgetCSP`), and nothing may be connected to; the
 *   line's `widgets` settings say its domain, border and description.
 * - **A tool shown through a widget** (`widget`: a View kind): its result carries, in `_meta`
 *   (the host's, for the widget; never the model's), what the widget draws: the View, its item
 *   (the call: `{ _id, name, input, output }`) and hints (`{ thread }`), who looks (the
 *   conversation's contact), what the View reads, answered (a snapshot, as that contact), the
 *   widget's grant, and which of the line's tools stand for which Actions.
 * - **A widget's own call** (an entry only the widgets call: `appOnly`): refused without the
 *   grant (never the model's: it only ever reads `content`), and with one from another
 *   conversation. An Action is called as the conversation's contact (its `allow`, the rules),
 *   and its result goes in `_meta` alone (`content` says only that it's done); the reads it
 *   asks with (`_reads`) are answered after it, in the same reply. The read tool (`READ`)
 *   answers queries as the contact, and nothing else.
 */
import { type Actor, isPublic, type Runtime } from "../../../../runtime/mod.ts";
import type { Widgets } from "../../../../hosts/web/mod.ts";
import { answeredAs, type Remote } from "../../../../runtime/browsers.ts";
import type { Called } from "../actions/call.ts";
import { grantedTo, grantOf, type Scope } from "../shared/keys.ts";
import { hasWidgets, type Line, READ } from "../shared/settings.ts";
import { GRANT, READS } from "./tools.ts";

/** What a widget's template is: MCP Apps' type for HTML that talks to its host. */
export const MIME = "text/html;profile=mcp-app";

/** The template's URI, for a version of it. */
const uriOf = (line: Line, version: string) => `ui://${line.name}/widget-${version}.html`;

/** Any version's URI of this line's template. */
const TEMPLATE = /^ui:\/\/([\w-]{1,60})\/widget-[\w-]{1,64}\.html$/;

/** The most reads a widget asks at once. */
const MOST_READS = 32;

/** Lines already told about in the log, whose template couldn't be made: once each. */
const broken = new Set<string>();

/**
 * The line's template now, when it has widgets and the host serves them. One that can't be
 * made (its code didn't bundle) is said once in the log, and the line goes on without widgets:
 * its tools still answer, drawn by nothing.
 */
export async function templateOf(
  line: Line,
  widgets: Widgets | undefined,
  origin: string | undefined,
): Promise<{ uri: string; html: string } | undefined> {
  if (!widgets || !origin || !hasWidgets(line)) return undefined;
  try {
    const { html, version } = await widgets.page(origin);
    broken.delete(line.name);
    return { uri: uriOf(line, version), html };
  } catch (error) {
    if (!broken.has(line.name)) {
      broken.add(line.name);
      console.error(`mcp.${line.name}: no widgets, the template failed:`, (error as Error).message);
    }
    return undefined;
  }
}

/** The template's `_meta`: MCP Apps' `ui`, with ChatGPT's aliases. */
function templateMeta(line: Line, origin: string) {
  const at = new URL(origin).origin;
  const { domain, prefersBorder, description } = line.widgets ?? {};
  return {
    ui: {
      csp: { connectDomains: [], resourceDomains: [at] },
      ...(domain ? { domain } : {}),
      ...(prefersBorder !== undefined ? { prefersBorder } : {}),
    },
    "openai/widgetCSP": { connect_domains: [], resource_domains: [at] },
    ...(domain ? { "openai/widgetDomain": domain } : {}),
    ...(prefersBorder !== undefined ? { "openai/widgetPrefersBorder": prefersBorder } : {}),
    ...(description ? { "openai/widgetDescription": description } : {}),
  };
}

/** `resources/list`: the template, when there is one. */
export async function resourcesListed(
  line: Line,
  widgets: Widgets | undefined,
  origin: string | undefined,
) {
  const template = await templateOf(line, widgets, origin);
  return {
    resources: template
      ? [{
        uri: template.uri,
        name: `${line.name}-widget`,
        title: line.title ?? line.name,
        mimeType: MIME,
        _meta: templateMeta(line, origin!),
      }]
      : [],
  };
}

/** `resources/read`: the template, at any version's URI of it; undefined for anything else. */
export async function resourceRead(
  line: Line,
  widgets: Widgets | undefined,
  origin: string | undefined,
  uri: unknown,
) {
  if (typeof uri !== "string" || TEMPLATE.exec(uri)?.[1] !== line.name) return undefined;
  const template = await templateOf(line, widgets, origin);
  if (!template) return undefined;
  return {
    contents: [{ uri, mimeType: MIME, text: template.html, _meta: templateMeta(line, origin!) }],
  };
}

/** Which of the line's tools stand for which Actions: how a widget's View calls them. */
const actionsOf = (line: Line): Record<string, string> =>
  Object.fromEntries(
    Object.entries(line.tools).flatMap(([name, entry]) =>
      entry.action ? [[entry.action, name]] : []
    ),
  );

/** The conversation's contact, as its widgets' Views see it. */
const contactActor = (line: Line, contact: string): Actor => ({
  kind: "contact",
  id: contact,
  mcp: line.name,
  client: line.client,
});

/**
 * What a result drawn by a widget carries for it, in `_meta` (see the header): its View and
 * item, what the View reads (answered as the contact), the grant, the Actions' tools.
 */
export async function widgetMeta(
  runtime: Pick<Runtime, "query">,
  widgets: Widgets,
  line: Line,
  scope: Scope & { secret: string },
  call: { tool: string; input: Record<string, unknown> },
  conversation: { contact: string; thread: string; output?: string; call?: string },
) {
  const view = line.tools[call.tool].widget!;
  const viewer = { kind: "contact", name: `contact:${conversation.contact}` };
  const item = {
    _id: conversation.call ?? `${conversation.thread}:${call.tool}`,
    name: call.tool,
    input: call.input,
    ...(conversation.output !== undefined ? { output: conversation.output } : {}),
  };
  const hints = { thread: conversation.thread };
  const actor = contactActor(line, conversation.contact);
  const reads = await widgets.snapshot(runtime, {
    actor,
    viewer,
    view,
    item,
    // What the widget observes first: inline, until its host says otherwise.
    hints: { ...hints, mode: "inline", surface: "widget" },
  }).catch((error) => {
    console.error(`mcp.${line.name}: ${view}'s snapshot failed:`, (error as Error).message);
    return [];
  });
  return {
    "copilotz/widget": {
      view,
      item,
      hints,
      viewer,
      reads,
      grant: await grantOf(scope.secret, scope, conversation.contact),
      tools: actionsOf(line),
      read: READ,
    },
  };
}

/** A widget's own call's reply: `content` says only whether it went; the rest is for the widget. */
const reply = (text: string, meta: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
  _meta: meta,
});

/** What the model is told of a widget's tool it called itself: refused, and why. */
export const NOT_YOURS = "This tool is the app's widget's own: only the widget calls it, when " +
  "the user acts in it. Ask the user to use the widget.";

/**
 * The contact a widget's call is for: its grant's, when the grant is good and, when the call
 * names a conversation too (`openai/session`), that conversation's; else undefined (refused).
 */
export async function grantedContact(
  scope: Scope & { secret: string },
  input: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  named: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const grant = input[GRANT] ?? meta?.["copilotz/grant"];
  const contact = await grantedTo(scope.secret, scope, grant);
  if (!contact) return undefined;
  const session = await named();
  return session === undefined || session === contact ? contact : undefined;
}

/** Reads a widget asked for, as the contact: queries only, at most `MOST_READS`. */
async function readsOf(
  runtime: Pick<Runtime, "query">,
  actor: Actor,
  asked: unknown,
): Promise<[string, unknown][]> {
  const reads = Array.isArray(asked) ? asked.slice(0, MOST_READS) : [];
  const answers = await Promise.all(reads.map((r) => {
    const { key, read } = (r ?? {}) as { key?: unknown; read?: unknown };
    if (typeof key !== "string" || key.length > 2_000 || !read || typeof read !== "object") {
      return undefined;
    }
    return answeredAs(runtime, actor, key, read as Remote);
  }));
  return answers.flatMap((a) =>
    a ? [[a.key, "error" in a ? { error: a.error } : { value: a.value }]] : []
  );
}

/**
 * A widget's own call, its grant checked (`contact`): admitted by `mcp.call` (the
 * conversation's there, not over, within its limits), then made as the contact: the read
 * tool's reads, or the Action the entry stands for, with the reads asked after it.
 */
export async function appCalled(
  runtime: Pick<Runtime, "call" | "query">,
  line: Line,
  call: {
    tool: string;
    input: Record<string, unknown>;
    contact: string;
    /** The call's id, for the Action: the same request sent again runs once. */
    id: string;
    user?: string;
    address?: string;
  },
) {
  const admitted = await runtime.call<Called>("mcp.call", {
    line: line.name,
    tool: call.tool,
    input: {},
    call: call.id.slice(0, 120),
    by: "handle",
    app: true,
    ...(call.user ? { user: call.user } : {}),
    ...(call.address ? { address: call.address } : {}),
  }, { actor: contactActor(line, call.contact) });
  if (!admitted.admitted) return reply(admitted.text, {}, true);
  const actor = contactActor(line, call.contact);
  const { [GRANT]: _, [READS]: after, ...input } = call.input;
  if (call.tool === READ) {
    return reply("Read.", { "copilotz/reads": await readsOf(runtime, actor, input.reads) });
  }
  const action = line.tools[call.tool].action!;
  try {
    const result = await runtime.call(action, input, { actor, id: call.id });
    return reply("Done in the widget.", {
      "copilotz/result": result ?? null,
      ...(after ? { "copilotz/reads": await readsOf(runtime, actor, after) } : {}),
    });
  } catch (error) {
    const e = error as { message?: string; code?: string };
    const said = isPublic(error) && e.message ? e.message.slice(0, 1_000) : "Something went wrong.";
    return reply(said, {
      "copilotz/error": { message: said, ...(e.code ? { code: e.code } : {}) },
      ...(after ? { "copilotz/reads": await readsOf(runtime, actor, after) } : {}),
    }, true);
  }
}
