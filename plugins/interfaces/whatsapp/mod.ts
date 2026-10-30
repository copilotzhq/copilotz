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
 *   Anyone else who writes is told how, once a day, and nothing more.
 * - **What they send** becomes `chat.send`, as them, in their WhatsApp
 *   conversation, in the space they choose (their Personal space unless
 *   they say: `whatsapp.move`, or `/space <name>` from the phone); photos,
 *   documents and voice notes too (chat transcribes audio). `/new` starts a
 *   new conversation. Meta delivering a message again changes nothing.
 * - **What agents say there** to them goes back to the phone, as WhatsApp
 *   formats it, a long answer in several messages.
 * - **The webhook** (`/hooks/whatsapp/<number>`, the web host's `routes`
 *   resource) checks Meta's signature before anything else. Credentials are
 *   kept where no event and no reader outside reaches them.
 *
 * ```ts
 * plugins: [models, chat, ...access, whatsapp]
 * resources: { whatsapp: { graph: "https://graph.facebook.com/v23.0" } }   // the default
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { connectAction, credentialsAction } from "./actions/connect.ts";
import { disconnectAction, webhookAction } from "./actions/disconnect.ts";
import { hookAction, HOOKS } from "./actions/hook.ts";
import { linkAction, moveAction, unlinkAction } from "./actions/link.ts";
import { code } from "./collections/code.ts";
import { number } from "./collections/number.ts";
import { phone } from "./collections/phone.ts";
import { secret } from "./collections/secret.ts";
import { sent } from "./collections/sent.ts";
import { chat } from "./collections/thread.ts";
import { received } from "./events/received.ts";
import { receiveProcessor } from "./processors/receive.ts";
import { replyProcessor } from "./processors/reply.ts";
import { rules } from "./shared/rules.ts";

export * from "./contract.ts";

export const whatsapp: Plugin = definePlugin({
  name: "whatsapp",
  requires: ["chat", "spaces"],
  collections: {
    whatsapp_number: number,
    whatsapp_secret: secret,
    whatsapp_phone: phone,
    whatsapp_code: code,
    whatsapp_thread: chat,
    whatsapp_sent: sent,
  },
  events: { "whatsapp.received": received },
  actions: {
    "whatsapp.connect": connectAction,
    "whatsapp.credentials": credentialsAction,
    "whatsapp.disconnect": disconnectAction,
    "whatsapp.webhook": webhookAction,
    "whatsapp.hook": hookAction,
    "whatsapp.link": linkAction,
    "whatsapp.unlink": unlinkAction,
    "whatsapp.move": moveAction,
  },
  processors: {
    "whatsapp.receive": receiveProcessor,
    "whatsapp.reply": replyProcessor,
  },
  guard: rules,
  resources: {
    whatsapp: {},
    routes: { whatsapp: { path: HOOKS, action: "whatsapp.hook", methods: ["GET", "POST"] } },
    // A number lives in a space: its members see it, its managers change it.
    shared: { whatsapp_number: { write: "manage" } },
  },
});

export default whatsapp;
