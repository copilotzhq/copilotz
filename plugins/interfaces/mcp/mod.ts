/**
 * MCP: models outside the app (ChatGPT, Claude, any MCP client) call the
 * app's tools: the same tools its own agents use, run the same way, each
 * conversation a chat in the app, so what's built for its agents (a
 * booking, its debugging, its queries) works for them too.
 *
 * - **A line** is an MCP server the app declares in its settings
 *   (`resources.mcp.lines.<name>`), at `POST /mcp/<name>` (under many orgs,
 *   `/o/<org>/mcp/<name>`): the space its conversations' chats live in, the
 *   tools it offers (`tools`, by name: only these, each with its
 *   `tool:<name>` View, what a model reads of it), how each is shown (its
 *   title, hints such as `readOnly`, what ChatGPT says while and after it
 *   runs), who calls (`client`, `ChatGPT`), its limits. Anyone may call it:
 *   no sign-in yet. In ChatGPT, the app's connector points at that URL.
 * - **A conversation** is a contact (someone outside the org) in a chat of
 *   its own in the line's space: they reach that chat and nothing else; the
 *   space's members read it. ChatGPT names its conversation in every call
 *   (`_meta["openai/session"]`, with its user, `openai/subject`); a client
 *   that names none is given a handle (`chat`, which the line's tools then
 *   take), said once at the end of its first answer (`chat: <handle>`), or,
 *   with `handles: false`, is refused. Ids come from these through an HMAC
 *   with the app's secret (the `links` resource's): nothing maps them, and a
 *   stranger can't work out another's. Erased (`contact.forget`,
 *   `chat.erase`), a conversation is over for good (see processors/).
 * - **A call** (see actions/call.ts) runs the tool through chat's runner,
 *   as the conversation's contact, and is written in the chat as a step,
 *   as an agent's is; its answer is what the app's own agents read of it
 *   (the tool's View); an error says its message only when it's public
 *   (`failure(code, message, { public: true })`). A request sent again to a
 *   tool that changes things is answered from the first; a read-only tool
 *   always runs.
 * - **Limits** (a line's `limits`): calls at once (in the runtime, on the
 *   line, from one caller's address, in one conversation: the server is busy
 *   past them), how long the route waits for an answer (20 s: then the model
 *   is told it's still working, and asking again gets what it did, once) and
 *   a call may run (2 minutes: then it's stopped), calls a minute (by conversation, by caller's address, in all), new
 *   conversations an hour (by user, by address, in all), and sizes. Only
 *   calls taken count. The caller's address is believed only as the app's
 *   front says it (`caller`: its header, and its secret, without which a
 *   request is refused, or the proxies' hops); one that can't be read counts
 *   with every other such call, as one caller.
 * - **The protocol** (see resources/server.ts): MCP's Streamable HTTP,
 *   JSON-RPC 2.0, with no session; 2026-07-28 and the versions with a
 *   handshake (2025-11-25, 2025-06-18, 2025-03-26). Tools are all it serves.
 *
 * **Security notes** (to verify in ChatGPT's developer mode before a line
 * offers more):
 *
 * - **What names a conversation is a bearer value.** Whoever holds it
 *   reaches that chat as its contact. A handle is in the model's transcript
 *   (it has to be: a model reads only an answer's content, never its
 *   `_meta`), so it goes wherever the transcript goes (shared, exported).
 *   `openai/session` and `openai/subject` are ChatGPT's, sent only to us,
 *   but whether ChatGPT scopes `openai/session` to one connector (or the
 *   same id reaches every app in a conversation) isn't verified.
 * - **So, until it is,** a line shouldn't offer tools that read personal
 *   data back (a saved buyer's details, past orders): a leaked key would
 *   read them. A tool that only writes, or reads what the conversation
 *   itself said, risks only that conversation.
 * - **A tool's own Action calls** are plugin code, as an agent's tools'
 *   are on WhatsApp: their `allow` isn't asked (the rules still keep them to
 *   the contact's chat). A tool offered here may call trusted Actions for
 *   the contact: offer only tools whose every call is safe for anyone.
 *
 * ```ts
 * plugins: [models, chat, ...access, mcp]
 * resources: {
 *   links: { origin, secret },   // the secret its ids are made with
 *   spaces: { line: { name: "ChatGPT", agents: ["booking"] } },
 *   mcp: {
 *     caller: { header: "cf-connecting-ip", front: env.FRONT_SECRET },
 *     lines: { chatgpt: { in: "line", client: "ChatGPT", handles: false,
 *       tools: { search_trips: { annotations: { readOnly: true }, invoking: "Buscando…" } } } },
 *   },
 * }
 * views: { "tool:search_trips": { llm: tripsForModels } }   // each offered tool's, in a plugin
 * ```
 */
import { definePlugin, linksOf, type Plugin } from "../../../runtime/mod.ts";
import { callAction } from "./actions/call.ts";
import { pruneAction } from "./actions/prune.ts";
import { closed } from "./collections/closed.ts";
import { rate } from "./collections/rate.ts";
import { receipt } from "./collections/receipt.ts";
import { erasedProcessor, forgottenProcessor } from "./processors/closed.ts";
import { serveMcp } from "./resources/server.ts";
import { linesOf, PATH, problemOf, settingsProblem } from "./shared/settings.ts";
import { offeredView } from "./views/offered.ts";

export * from "./contract.ts";

export const mcp: Plugin = definePlugin({
  name: "mcp",
  requires: ["chat", "spaces", "contacts"],
  collections: { mcp_receipt: receipt, mcp_rate: rate, mcp_closed: closed },
  actions: { "mcp.call": callAction, "mcp.prune": pruneAction },
  processors: { "mcp.forgotten": forgottenProcessor, "mcp.erased": erasedProcessor },
  // What's past goes: counters, receipts.
  schedules: { "mcp.prune": { every: "10m", call: "mcp.prune", input: {} } },
  // Which tools a contact is offered, as each tool's `offer` says.
  views: { "mcp:offered": { mcp: offeredView } },
  // At start: every line the app declares has what it needs, and the secret its ids come from.
  check: (merged) => {
    const settings = settingsProblem(merged.resources);
    if (settings) throw new Error(`mcp.${settings}`);
    const lines = Object.entries(linesOf(merged));
    if (lines.length && !linksOf(merged.resources)) {
      throw new Error(
        "mcp needs the links resource (its origin and secret): its ids are made with it",
      );
    }
    for (const [name, line] of lines) {
      const problem = problemOf(name, line, merged.resources);
      if (problem) throw new Error(`mcp.lines.${name} ${problem}`);
    }
  },
  resources: {
    mcp: {},
    routes: { mcp: { path: PATH, serve: serveMcp } },
  },
});

export default mcp;
