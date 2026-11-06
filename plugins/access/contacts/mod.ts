/**
 * Contacts: people outside the org who talk to its agents, such as a
 * WhatsApp customer writing to a business's number. Each is its own kind of
 * actor, `{ kind: "contact", id }`, never a person: every Action and query
 * stays shut to them unless it says otherwise (`peopleOrContacts`, as
 * `chat.send` does), and nothing that checks for a person finds one.
 *
 * - **A contact** is made by trusted code that proved who they are
 *   (`contact.start`; Meta's signed webhook names the phone), with its
 *   record (`contact`) `in` the line's space: its members read it.
 * - **Their chat** (`contact.chat`) is opened in that space and shared with
 *   them on its own: they reach it, its messages and files, and nothing
 *   else; the space's members reach it as any chat there. An agent working
 *   for a contact reaches what both reach: that chat.
 * - **Agents are told** who they're talking with (the `contact` context),
 *   and see them by name ("People here: Ana": a `names` source, `contact:`).
 * - **Erasing one** (`contact.forget`, by its space's managers) ends its
 *   access at once and deletes its record, and with `chats` its chats.
 * - **Lines** bring contacts in: WhatsApp's, the phone's, MCP's and the web's (`webLines`, in
 *   the web interface: visitors of a page) are interfaces of their own; contacts keeps what
 *   every line shares.
 *
 * ```ts
 * plugins: [models, chat, ...access]   // access brings contacts
 * resources: { spaces: { support: { name: "Support", agents: ["guide"] } } }
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { chatAction } from "./actions/chat.ts";
import { forgetAction } from "./actions/forget.ts";
import { startAction } from "./actions/start.ts";
import { CONTACT, contact } from "./collections/contact.ts";
import { contactView } from "./views/contact.ts";

export * from "./contract.ts";

export const contacts: Plugin = definePlugin({
  name: "contacts",
  requires: ["spaces"],
  collections: { contact },
  actions: {
    "contact.start": startAction,
    "contact.chat": chatAction,
    "contact.forget": forgetAction,
  },
  views: { "context:contact": contactView },
  resources: {
    // A contact's record lives in its line's space; only trusted code changes it. A contact is a
    // member (of its chats, and of its own record): reading it labels nothing, as for an agent.
    shared: { contact: { write: "manage", member: "contact" } },
    names: { contact: { collection: "contact", prefix: CONTACT } },
    context: { contact: { place: "system" } },
  },
});

export default contacts;
