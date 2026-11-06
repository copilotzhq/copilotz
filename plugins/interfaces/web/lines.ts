/**
 * Web lines (`resources.web.lines.<name>`, declared in the app's settings, with the app's secret,
 * `links`): a front door for browsers that aren't anyone, as WhatsApp's, the phone's and MCP's
 * lines are for theirs. A page that comes in by one (`web({ arrive: { name } })`, which posts to
 * `/web/<name>`, this plugin's route) is a visitor, its browser keeping a secret in an httpOnly
 * cookie (`visitor`, which this plugin's `who` reads) that is the same visitor while it lasts
 * (`days`, 30). Coming in makes and
 * keeps nothing: the secret is signed. Its first message makes it a contact (the contacts
 * plugin's) in the line's space, with a chat of its own answered by the line's agent
 * (`contact.sending`, chat's `contactSend` hook). New visitors an hour are limited by the caller's
 * address (as the app's front says it: `web.caller`, as MCP's; else as the socket's) and its wider
 * networks (an IPv4 /24, an IPv6 /56 and /48), and a visitor's messages a minute and a day, its
 * networks', and the line's (some of it kept for those who spoke before); past any, it's refused
 * plainly (429), only that caller. A line may have a budget (what its visitors' turns cost a day,
 * as the usage ledger prices them: `contact.spent`, through `modelUse`) and a challenge (an
 * Action of the app's a newcomer passes first). Files only when the line takes them, transcribed
 * only when it says. A visitor reaches what any contact does: their chat, never its agents'
 * private steps, and what's shared with them. Erasing the contact ends its cookie and its
 * connections with it (a processor of `contact.deleted`); what's past is collected every ten
 * minutes (`contact.prune`), a contact never heard from too.
 *
 * ```ts
 * plugins: [models, chat, ...access, webLines]
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
import { type Actor, definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { arriveAction } from "./actions/arrive.ts";
import { pruneAction } from "./actions/prune.ts";
import { sendingAction } from "./actions/sending.ts";
import { budgetAction, spentAction } from "./actions/spent.ts";
import { rate } from "./collections/rate.ts";
import { visitor } from "./collections/visitor.ts";
import { forgetProcessor } from "./processors/forget.ts";
import { arriveRoute, VISITOR_COOKIE } from "./routes/arrive.ts";
import { visitorsSpend } from "./resources/spend.ts";
import { settingsProblem } from "./shared/lines.ts";

export { WEB_LIMITS, type WebLimits, type WebLine, type WebSettings } from "./contract.ts";

/** What only the system reads or writes: visitors' records, and the lines' counters. */
const SYSTEM_ONLY = ["contact_visitor", "contact_rate"];

export const webLines: Plugin = definePlugin({
  name: "web-lines",
  requires: ["contacts"],
  collections: { contact_visitor: visitor, contact_rate: rate },
  actions: {
    "contact.arrive": arriveAction,
    "contact.sending": sendingAction,
    "contact.prune": pruneAction,
    "contact.spent": spentAction,
    "contact.budget": budgetAction,
  },
  processors: { "web.forget": forgetProcessor },
  schedules: { "contact.prune": { every: "10m", call: "contact.prune", input: {} } },
  // Visitors' secrets and counters are nobody's to read but the system's, a contact's least.
  guard: (_actor, { collection }) =>
    SYSTEM_ONLY.includes(collection) ? { _id: { $in: [] } } : undefined,
  // At start: the web lines the app declares, and how it knows who's calling.
  check: (merged) => {
    const problem = settingsProblem(merged.resources, merged.actions);
    if (problem) throw new Error(problem);
  },
  // A browser is the visitor its cookie's secret is (`contact_visitor.actor`): with this plugin
  // after identity, asked after people's sessions.
  who: (_request, { cookies, query }) => {
    const secret = cookies.get(VISITOR_COOKIE);
    return secret ? query<Actor | null>("contact_visitor.actor", { secret }) : null;
  },
  // A browser coming in by a web line: let in, its cookie set.
  routes: { "/web/:name": arriveRoute },
  resources: {
    web: {},
    // What a contact sends goes in through here first: a web visitor's limits, and its own chat.
    contactSend: { web: { action: "contact.sending" } },
    // What a web line's visitors' turns cost, for its budget.
    modelUse: { webLines: visitorsSpend },
  },
});

export default webLines;
