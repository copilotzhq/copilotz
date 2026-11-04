/**
 * WhatsApp: people talk to their agents from WhatsApp, through Meta's
 * Cloud API.
 *
 * - **A number** (a WhatsApp Business number) is connected to a space, an
 *   org's or a team's, by those who manage it (`whatsapp.connect`: its phone
 *   number id, an access token and the Meta app's secret), and gets a
 *   webhook of its own to set up in Meta's dashboard (`whatsapp.webhook`).
 * - **A phone** is linked to a person in that space: they ask the app for
 *   a code (`whatsapp.link`) and send it to the number from WhatsApp.
 *   Anyone else who writes is told how, once a day, and nothing more,
 *   unless the number is open to anyone.
 * - **A customer line:** those who manage the space open the number to
 *   anyone (`whatsapp.set`), or the app declares one in its settings
 *   (`resources.whatsapp.lines`: the space, Meta's ids, token and secret,
 *   its verify token, its webhook's path, its agent and gap), kept as they
 *   say with no person, and changed only there. A stranger who writes is then a contact
 *   (someone outside the org), in a chat of their own in the number's
 *   space, answered by its agent: they reach that chat and nothing else; the
 *   space's members read it. A chat quiet for the number's `gap` (12 hours)
 *   is over, and their next message starts a new one. Its managers block a
 *   customer's phone (`whatsapp.block`); a customer sending more than the
 *   number's `rate` a minute (20) goes unanswered. Erasing a contact
 *   (`contact.forget`) erases its phone here too.
 * - **What they send** becomes `chat.send`, as them, in their WhatsApp
 *   conversation, in the space they choose (their Personal space unless
 *   they say: `whatsapp.move`, or `/space <name>` from the phone); photos,
 *   documents and voice notes too (chat transcribes audio). `/new` starts a
 *   new conversation. Meta delivering a message again changes nothing.
 * - **What agents say there** to them goes back to the phone, as WhatsApp
 *   formats it, a long answer in several messages; "typing…" shows while
 *   they work, and nothing says "please wait".
 * - **WhatsApp is a medium:** a View for it (renderer `whatsapp`) returns
 *   parts, each one WhatsApp message, built with the toolkit in the contract
 *   (`text`, `buttons`, `list`, `carousel`, `image`, `document`), which
 *   checks Meta's limits. A message shows through its `message` View (this
 *   plugin's: its text). After an answer come the features' additions
 *   (chat's `additions` resource, an `addition:<name>` View here): each goes
 *   once per chat per key, the answer's text in the first one's body when
 *   there's room (one message, not two: Meta charges each), and its fallback
 *   when Meta refuses it, or later says it couldn't deliver it (a picture
 *   it failed to fetch). A tap comes back as its title, with its id.
 *   Pictures and files go as links (public ones; signed ones to the app's
 *   routes and files, with its `links` resource), or uploaded to Meta.
 * - **The webhook** (`/hooks/whatsapp/<number>`, the web host's `routes`
 *   resource) checks Meta's signature before anything else. Credentials are
 *   kept where no event and no reader outside reaches them.
 *
 * ```ts
 * plugins: [models, chat, ...access, whatsapp]
 * resources: { whatsapp: { graph: "https://graph.facebook.com/v23.0" } }   // the default
 * ```
 */
import { definePlugin, linksOf, type Plugin } from "../../../runtime/mod.ts";
import { connectAction, credentialsAction } from "./actions/connect.ts";
import { disconnectAction, webhookAction } from "./actions/disconnect.ts";
import { hookAction, HOOKS } from "./actions/hook.ts";
import { linkAction, moveAction, unlinkAction } from "./actions/link.ts";
import { blockAction, setAction } from "./actions/set.ts";
import { code } from "./collections/code.ts";
import { number } from "./collections/number.ts";
import { phone } from "./collections/phone.ts";
import { rate } from "./collections/rate.ts";
import { secret } from "./collections/secret.ts";
import { sent } from "./collections/sent.ts";
import { chat } from "./collections/thread.ts";
import { typing } from "./collections/typing.ts";
import { received } from "./events/received.ts";
import { undelivered } from "./events/undelivered.ts";
import { forgetProcessor } from "./processors/forget.ts";
import { receiveProcessor } from "./processors/receive.ts";
import { replyProcessor, undeliveredProcessor } from "./processors/reply.ts";
import { typingProcessor } from "./processors/typing.ts";
import { messageView } from "./views/message.ts";
import { rules } from "./shared/rules.ts";
import { linesOf } from "./shared/settings.ts";

export * from "./contract.ts";

export const whatsapp: Plugin = definePlugin({
  name: "whatsapp",
  requires: ["chat", "spaces", "contacts"],
  collections: {
    whatsapp_number: number,
    whatsapp_secret: secret,
    whatsapp_phone: phone,
    whatsapp_code: code,
    whatsapp_thread: chat,
    whatsapp_sent: sent,
    whatsapp_typing: typing,
    whatsapp_rate: rate,
  },
  events: { "whatsapp.received": received, "whatsapp.undelivered": undelivered },
  actions: {
    "whatsapp.connect": connectAction,
    "whatsapp.credentials": credentialsAction,
    "whatsapp.disconnect": disconnectAction,
    "whatsapp.webhook": webhookAction,
    "whatsapp.hook": hookAction,
    "whatsapp.link": linkAction,
    "whatsapp.unlink": unlinkAction,
    "whatsapp.move": moveAction,
    "whatsapp.set": setAction,
    "whatsapp.block": blockAction,
  },
  processors: {
    "whatsapp.receive": receiveProcessor,
    "whatsapp.reply": replyProcessor,
    "whatsapp.undelivered": undeliveredProcessor,
    "whatsapp.typing": typingProcessor,
    "whatsapp.forget": forgetProcessor,
  },
  // WhatsApp as a medium: what a message is there (a feature's additions bring their own).
  views: { message: { whatsapp: messageView } },
  guard: rules,
  // At start: links to what it sends (a secret too short is refused), and the app's own lines.
  check: (merged) => {
    linksOf(merged.resources);
    for (const [name, line] of Object.entries(linesOf(merged))) {
      for (const field of ["in", "phoneId", "token", "secret", "verify"] as const) {
        if (typeof line?.[field] !== "string" || !line[field]) {
          throw new Error(`whatsapp.lines.${name} needs its ${field}`);
        }
      }
      if (line.path !== undefined && !line.path.startsWith("/")) {
        throw new Error(`whatsapp.lines.${name}: its path starts with "/"`);
      }
    }
  },
  resources: {
    whatsapp: {},
    routes: { whatsapp: { path: HOOKS, action: "whatsapp.hook", methods: ["GET", "POST"] } },
    // A number lives in a space: its members see it, its managers change it.
    shared: { whatsapp_number: { write: "manage" } },
  },
});

export default whatsapp;
