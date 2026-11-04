/**
 * Voice: people call the app's phone number and talk to its agents, through
 * Twilio's ConversationRelay (Twilio hears them and speaks for the agent;
 * the app gets and sends text).
 *
 * - **A line** is a Twilio number the app declares in its settings
 *   (`resources.voice.lines.<name>`: the space its chats live in, Twilio's
 *   account SID and auth token, the app's public address, its agent,
 *   language, voice, greeting and limits), open to anyone who calls. In
 *   Twilio's console, the number's "a call comes in" webhook is
 *   `POST <origin>/hooks/voice/<name>`.
 * - **A caller** is a contact (someone outside the org), by line and number,
 *   in a chat of their own in the line's space, answered by its agent: the
 *   same chat when they call back before the line's `gap` (12 hours), a new
 *   one after. A hidden number is a new contact each call. Erasing a contact
 *   (`contact.forget`) erases its number here too.
 * - **A call** (see actions/hook.ts and resources/relay.ts): Twilio's
 *   webhook is checked against Twilio's signature, taken within the line's
 *   limits (else rejected as busy: nothing is spent), and told to open the
 *   line's socket with a ticket good once, for a minute. On the socket, what
 *   the caller says goes to the agent as theirs, and what the agent writes is
 *   said as it writes it; a caller speaking over it stops it there. A failed
 *   or too slow answer says a short line in the line's language, never the
 *   error. Silence, or a call too long, ends it with a goodbye; the agent
 *   ends it too, once it said goodbye (the `end_call` tool, offered to the
 *   agent answering a call while it goes on). Each call is a small record
 *   (`voice_call`): when, how long, why it ended.
 * - **The phone is a medium:** what an agent writes is said through its
 *   `message` View (renderer `voice`: the words, without Markdown), which an
 *   app may replace; the caller's chat is read as theirs, so only what they
 *   may read is said.
 *
 * ```ts
 * plugins: [models, chat, ...access, voice]
 * resources: {
 *   spaces: { line: { name: "Support", agents: ["phone"] } },
 *   voice: { lines: { support: { in: "line", account, token, origin, agent: "phone",
 *     language: "pt-BR" } } },
 * }
 * ```
 *
 * The socket needs a host that takes a route's socket (`serveRoutes`, or the
 * web host, from `copilotz/web/node`).
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { hookAction } from "./actions/hook.ts";
import { admitAction, heardAction, overAction, startAction } from "./actions/call.ts";
import { call } from "./collections/call.ts";
import { phone } from "./collections/phone.ts";
import { forgetProcessor } from "./processors/forget.ts";
import { serveRelay } from "./resources/relay.ts";
import { endCall } from "./resources/tools.ts";
import { callView } from "./views/call.ts";
import { contextView } from "./views/context.ts";
import { messageView } from "./views/message.ts";
import { HOOKS, linesOf, problemOf } from "./shared/settings.ts";

export * from "./contract.ts";

export const voice: Plugin = definePlugin({
  name: "voice",
  requires: ["chat", "spaces", "contacts"],
  collections: { voice_call: call, voice_phone: phone },
  actions: {
    "voice.hook": hookAction,
    "voice.admit": admitAction,
    "voice.start": startAction,
    "voice.heard": heardAction,
    "voice.over": overAction,
  },
  processors: { "voice.forget": forgetProcessor },
  views: {
    // The phone as a medium: what a message is, said aloud; what's being said in a call.
    message: { voice: messageView },
    voice_call: { voice: callView },
    "context:voice": { llm: contextView },
  },
  // At start: every line the app declares has what it needs.
  check: (merged) => {
    for (const [name, line] of Object.entries(linesOf(merged))) {
      const problem = problemOf(name, line);
      if (problem) throw new Error(`voice.lines.${name} ${problem}`);
    }
  },
  resources: {
    voice: {},
    // Twilio's webhook (and the end of a call's relay), then each call's socket.
    routes: {
      voice: { path: HOOKS, action: "voice.hook", methods: ["POST"] },
      "voice.relay": { path: HOOKS, serve: serveRelay, methods: ["GET"] },
    },
    tools: { end_call: endCall },
    context: { voice: { place: "turn" } },
  },
});

export default voice;
