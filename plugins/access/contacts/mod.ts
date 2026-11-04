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
 * - **Web lines** (`resources.web.lines.<name>`, declared in the app's
 *   settings, with the app's secret, `links`): a front door for browsers
 *   that aren't anyone. A page that comes in by one (`web({ arrive: { line }
 *   })`, `POST /connect` `{ line }`) is a visitor, its browser keeping a
 *   secret in an httpOnly cookie (the web host's `visitor` entrance) that is
 *   the same visitor while it lasts (`days`, 30). Coming in makes and keeps
 *   nothing: the secret is signed. Its first message makes it a contact in
 *   the line's space, with a chat of its own answered by the line's agent
 *   (`contact.sending`, chat's `contactSend` hook). New visitors an hour are
 *   limited by the caller's address (as the app's front says it:
 *   `web.caller`, as MCP's; else as the socket's) and its wider networks
 *   (an IPv4 /24, an IPv6 /56 and /48), and a visitor's messages a minute
 *   and a day, its networks', and the line's (some of it kept for those who
 *   spoke before); past any, it's refused plainly (429), only that caller. A
 *   line may have a budget (what its visitors' turns cost a day, as the
 *   usage ledger prices them: `contact.spent`, through `modelUse`) and a
 *   challenge (an Action of the app's a newcomer passes first). Files only
 *   when the line takes them, transcribed only when it says. A visitor
 *   reaches what any contact does: their chat, never its agents' private
 *   steps, and what's shared with them. Erasing the contact ends its cookie
 *   and its connections with it; what's past is collected every ten minutes
 *   (`contact.prune`), a contact never heard from too.
 *
 * ```ts
 * plugins: [models, chat, ...access]   // access brings contacts
 * resources: {
 *   spaces: { visitors: { name: "Website", agents: ["guide"] } },
 *   web: {
 *     caller: { header: "cf-connecting-ip", front: env.FRONT_SECRET },
 *     lines: { site: { in: "visitors", agent: "guide" } },
 *   },
 *   links: { origin: "https://example.com", secret: env.LINKS_SECRET },
 * }
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { arriveAction } from "./actions/arrive.ts";
import { chatAction } from "./actions/chat.ts";
import { forgetAction } from "./actions/forget.ts";
import { pruneAction } from "./actions/prune.ts";
import { sendingAction } from "./actions/sending.ts";
import { spentAction } from "./actions/spent.ts";
import { startAction } from "./actions/start.ts";
import { CONTACT, contact } from "./collections/contact.ts";
import { rate } from "./collections/rate.ts";
import { visitor } from "./collections/visitor.ts";
import { visitorEntrance } from "./resources/entrance.ts";
import { visitorsSpend } from "./resources/spend.ts";
import { settingsProblem } from "./shared/web.ts";
import { contactView } from "./views/contact.ts";

/** What only the system reads or writes: visitors' records, and the web lines' counters. */
const SYSTEM_ONLY = ["contact_visitor", "contact_rate"];

export * from "./contract.ts";

export const contacts: Plugin = definePlugin({
  name: "contacts",
  requires: ["spaces"],
  collections: { contact, contact_visitor: visitor, contact_rate: rate },
  actions: {
    "contact.start": startAction,
    "contact.chat": chatAction,
    "contact.forget": forgetAction,
    "contact.arrive": arriveAction,
    "contact.sending": sendingAction,
    "contact.prune": pruneAction,
    "contact.spent": spentAction,
  },
  schedules: { "contact.prune": { every: "10m", call: "contact.prune", input: {} } },
  views: { "context:contact": { llm: contactView } },
  // Visitors' secrets and counters are nobody's to read but the system's, a contact's least.
  guard: (_actor, { collection }) =>
    SYSTEM_ONLY.includes(collection) ? { _id: { $in: [] } } : undefined,
  // At start: the web lines the app declares, and how it knows who's calling.
  check: (merged) => {
    const problem = settingsProblem(merged.resources, merged.actions);
    if (problem) throw new Error(problem);
  },
  resources: {
    web: {},
    // A contact's record lives in its line's space; only trusted code changes it. A contact is a
    // member (of its chats, and of its own record): reading it labels nothing, as for an agent.
    shared: { contact: { write: "manage", member: "contact" } },
    names: { contact: { collection: "contact", prefix: CONTACT } },
    context: { contact: { place: "system" } },
    // A browser that's a visitor of a web line, asked after people's sessions.
    entrances: { visitor: visitorEntrance },
    // What a contact sends goes in through here first: a web visitor's limits, and its own chat.
    contactSend: { contacts: { action: "contact.sending" } },
    // What a web line's visitors' turns cost, for its budget.
    modelUse: { webLines: visitorsSpend },
  },
});

export default contacts;
