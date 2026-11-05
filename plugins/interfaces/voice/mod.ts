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
 * - **A caller** is a contact (someone outside the org), in a chat of their
 *   own in the line's space, answered by its agent. A number isn't proof of
 *   who's calling, so a caller is the same contact, in the same chat (until
 *   the line's `gap`, 12 hours, and never one with another call on), only
 *   when Twilio verified their number (STIR/SHAKEN), or the line trusts
 *   numbers (`trustCallerId`); else, and for a hidden number, each call is a
 *   new contact. Its managers block a caller (`voice.block`, for good or so
 *   many days), by a hash of their number, and lift it (`voice.unblock`).
 *   Erasing a contact (`contact.forget`) erases its number here too, and
 *   erasing a chat what was kept of it; calls' records go after the
 *   plugin's `keep` days (30), once they're over.
 * - **A call** (see actions/hook.ts and resources/relay.ts): Twilio's
 *   webhook is checked against Twilio's signature, taken within its
 *   caller's limits and the line's (else rejected as busy: nothing is
 *   spent), and told to open the line's socket with a ticket good once, for
 *   a minute. On the socket, what the caller says goes to the agent as
 *   theirs, one turn at a time (a new prompt stops the turn still answering
 *   the one before), and what the agent writes for them is said as it writes
 *   it; a caller speaking over it stops it there. A failed or too slow answer
 *   says a short line in the line's language, never the error; a too long
 *   one is cut. Silence, a call too long or too many prompts end it with a
 *   goodbye; the agent ends it too, once it said goodbye (the `end_call`
 *   tool, offered to the agent answering a call while it goes on). A call
 *   that ends stops its agent's turn. Each call is a small record
 *   (`voice_call`): when, how long, why it ended.
 * - **The phone is a medium:** what an agent writes is said through its
 *   `message` View (medium `voice`: the words, without Markdown), which an
 *   app may replace; the caller's chat is read as theirs, so only what they
 *   may read is said, and only of the turns their own words started.
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
 * The socket needs a host that takes a route's socket: the web host's
 * listener (`serve`, from `copilotz/web/node`), with or without a page.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { hookAction } from "./actions/hook.ts";
import { admitAction, heardAction, overAction, startAction } from "./actions/call.ts";
import { blockAction, unblockAction } from "./actions/block.ts";
import { pruneAction } from "./actions/prune.ts";
import { blocked } from "./collections/blocked.ts";
import { call } from "./collections/call.ts";
import { phone } from "./collections/phone.ts";
import { erasedProcessor, forgetProcessor } from "./processors/forget.ts";
import { serveRelay } from "./resources/relay.ts";
import { endCall } from "./resources/tools.ts";
import { callView } from "./views/call.ts";
import { contextView } from "./views/context.ts";
import { messageView } from "./views/message.ts";
import { HOOKS, keepOf, linesOf, problemOf } from "./shared/settings.ts";

export * from "./contract.ts";

export const voice: Plugin = definePlugin({
  name: "voice",
  requires: ["chat", "spaces", "contacts"],
  collections: { voice_call: call, voice_phone: phone, voice_blocked: blocked },
  actions: {
    "voice.hook": hookAction,
    "voice.admit": admitAction,
    "voice.start": startAction,
    "voice.heard": heardAction,
    "voice.over": overAction,
    "voice.block": blockAction,
    "voice.unblock": unblockAction,
    "voice.prune": pruneAction,
  },
  processors: { "voice.forget": forgetProcessor, "voice.erased": erasedProcessor },
  // What's kept of calls goes after `keep` days.
  schedules: { "voice.prune": { cron: "40 3 * * *", call: "voice.prune", input: {} } },
  views: {
    // The phone as a medium: what a message is, said aloud; what's being said in a call.
    message: { voice: messageView },
    voice_call: { voice: callView },
    "context:voice": { llm: contextView },
  },
  // At start: every line the app declares has what it needs.
  check: (merged) => {
    const keep = keepOf(merged);
    if (!(typeof keep === "number" && keep >= 1)) throw new Error("voice.keep is days, 1 or more");
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
    // A line's blocks live in its space: its members see them (never the number's hash), its
    // managers change them.
    shared: { voice_blocked: { write: "manage" } },
    context: { voice: { place: "turn" } },
  },
});

export default voice;
