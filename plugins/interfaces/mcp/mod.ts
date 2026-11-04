/**
 * MCP: models outside the app (ChatGPT, Claude, any MCP client) call the
 * app's tools: the same tools its own agents use, run the same way, each
 * conversation a chat in the app, so what's built for its agents (a
 * booking, its debugging, its queries) works for them too.
 *
 * - **A line** is an MCP server the app declares in its settings
 *   (`resources.mcp.lines.<name>`), at `POST /mcp/<name>` (under many orgs,
 *   `/o/<org>/mcp/<name>`): the space its conversations' chats live in, the
 *   tools it offers (`tools`, or all of an `agent`'s), how each is shown
 *   (its title, hints such as `readOnly`, what ChatGPT says while and after
 *   it runs), who calls (`client`, `ChatGPT`), its limits. Anyone may call
 *   it: no sign-in yet. In ChatGPT, the app's connector points at that URL.
 * - **A conversation** is a contact (someone outside the org) in a chat of
 *   its own in the line's space: they reach that chat and nothing else; the
 *   space's members read it. ChatGPT names its conversation in every call
 *   (`_meta["openai/session"]`, with its user, `openai/subject`); a client
 *   that names none is given a handle (`chat`, which the line's tools then
 *   take, ending each answer: `chat: <handle>`), or, with `handles: false`,
 *   each of its calls is a conversation of its own. Their ids come from
 *   these through an HMAC with the app's secret (the `links` resource's):
 *   nothing maps them, and a stranger can't reach another's.
 * - **A call** (see actions/call.ts) runs the tool through chat's runner,
 *   as the conversation's contact, and is written in the chat as a step,
 *   as an agent's is; its answer is what the app's own agents read of it
 *   (the tool's `tool:<name>` View). A request sent again is answered from
 *   the first. Past the line's limits (calls a minute, by conversation and
 *   in all; new conversations an hour, in all and by user), a call is
 *   refused with a line saying so.
 * - **The protocol** (see resources/server.ts): MCP's Streamable HTTP,
 *   JSON-RPC 2.0, with no session; 2026-07-28 and the versions with a
 *   handshake (2025-11-25, 2025-06-18, 2025-03-26). Tools are all it serves.
 *
 * ```ts
 * plugins: [models, chat, ...access, mcp]
 * resources: {
 *   links: { origin, secret },   // the secret its ids are made with
 *   spaces: { line: { name: "ChatGPT", agents: ["booking"] } },
 *   mcp: { lines: { chatgpt: { in: "line", agent: "booking", client: "ChatGPT",
 *     tools: { search_trips: { annotations: { readOnly: true }, invoking: "Buscando…" } } } } },
 * }
 * ```
 */
import { definePlugin, linksOf, type Plugin } from "../../../runtime/mod.ts";
import { callAction } from "./actions/call.ts";
import { call } from "./collections/call.ts";
import { rate } from "./collections/rate.ts";
import { serveMcp } from "./resources/server.ts";
import { linesOf, PATH, problemOf } from "./shared/settings.ts";

export * from "./contract.ts";

export const mcp: Plugin = definePlugin({
  name: "mcp",
  requires: ["chat", "spaces", "contacts"],
  collections: { mcp_call: call, mcp_rate: rate },
  actions: { "mcp.call": callAction },
  // At start: every line the app declares has what it needs, and the secret its ids come from.
  check: (merged) => {
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
