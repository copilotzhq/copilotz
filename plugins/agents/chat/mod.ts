/**
 * Chat: threads where people and agents talk. Agents reply with an LLM and
 * tools; with the `send_message` tool they also message each other and
 * people, in the thread, in a subthread or in a new thread.
 *
 * How a conversation moves:
 * - A message addressed to agents records one `turn.requested` per agent, in
 *   the message's own commit; or, sent with `quiet` (a customer writing in
 *   bursts), once its sender has been quiet that long (`chat.quiet`, by a
 *   timer each message sets again), answering them all at once. Turns run keyed by thread and agent, so
 *   different agents work in parallel and each agent's turns stay in order.
 * - An agent's final answer goes back to whoever addressed it, as a reply.
 * - An agent that sent messages expecting replies stops, leaving a `wait`
 *   document. Each reply checks itself off; the last one resumes the agent
 *   with every reply in its history. Waiting holds nothing open.
 * - Agents read other conversations (`list_conversations`, `read_conversation`)
 *   and say something in one that's there already (send_message's `thread`):
 *   in their space, or, from their person's Personal space, in any space the
 *   person reaches, as that person may (design/work.md, "Authority").
 * - People are reached the same way: a question to a person waits until they
 *   reply to it. So does a tool that needs a person's answer to go on (a yes
 *   to run a command, `ctx.ask`): its turn waits with the step's other
 *   messages, and resumes with that call run again, as itself, after the
 *   answer. An agent another one asked still answers it, whatever it waited
 *   on meanwhile.
 * - Asking for a yes is chat's, for every plugin (its contract's `ask`): what
 *   a call waits on is an `approval` its person answers with `chat.approve`,
 *   only as that kind of ask allows (`answers`: yes this once, in this
 *   conversation, for the routine that set it going, always, or no); a yes
 *   beyond once is a `grant`, taken back with `chat.forgetGrant`. A
 *   computer's command asks so, and so does a share: a tool's write refused
 *   for going where not everyone reaches what the agent's work may read
 *   (`needs_approval`) asks the person it works for (never always), and on a
 *   yes runs again with that place `approved`. An answer to work handed over
 *   goes back without asking only where everyone could see what its work
 *   may read; otherwise whoever handed it over says where: there, or to them
 *   alone, in their Personal space.
 * - What an agent is writing shows as it comes: a `live` document per running
 *   turn, kept in memory, swapped for the step or reply it became in one commit.
 * - A step's tool calls are written (an `intent`) before any of them runs, and
 *   what each returns as it does: a retried turn goes on with those calls
 *   instead of asking its model again, so a call that returned never runs
 *   twice, and one cut short runs again as itself (`ctx.callId`, the key for
 *   what it does outside).
 * - A file goes in on its own before the message that sends it
 *   (`chat.attach`: one a call, kept as its sender's draft, which nobody
 *   else reads), and the message names it by id (`chat.send`): no call
 *   carries more than one file. Drafts not sent within a day go
 *   (`chat.prune`, hourly).
 * - A person moves a conversation to another space (`chat.move`), with
 *   everything in it; not while an agent is writing in it. Moving it is
 *   sharing it: front ends say first who'll see it there and what it drew
 *   on (`thread.moving`, from its messages' `drew`).
 * - A chat shared with someone outside its space (a contact's) has notes
 *   beside it (`chat.notes`): a thread of its own in the same space, made
 *   the first time it's asked for, where its people work with agents about
 *   it (they reach all the space does, and are told the chat's latest:
 *   the `notes` context), and that the one outside never sees. A reply
 *   drafted there goes into the chat as its person's own message
 *   (`chat.send`). The notes go wherever the chat goes, and are erased with
 *   it.
 * - A chat can be opened empty (`chat.open`), to share it with a contact
 *   (someone outside the org, who then writes there with `chat.send` and
 *   reaches only it, never its agents' private steps); a contact's message
 *   is let in first by the app's `contactSend` hooks (a web visitor's
 *   limits, and its own chat, opened with its first message); trusted code
 *   has an agent say a fixed message in one without a turn (`chat.say`: a
 *   payment confirmed; with files, a picture a tool made), and erases one
 *   with everything in it (`chat.erase`: someone's data, gone).
 * - After an agent's answer, the place it goes to may show more (additions: a carousel
 *   of trips after the answer that found them), each once per chat per key,
 *   recorded in `shown` (`chat.shown`), and told to the model after that
 *   answer (`[then shown: …]`). A choice tapped comes with its id (`tap`).
 * - A conversation moves in from another app as it was (`chat.import`,
 *   the system's): its thread in a space, its title, and its messages with
 *   who said them, their files and when, under the importer's ids, so
 *   importing again replaces what it made. Nothing runs.
 * - Messages that kept the old marks (`sources`, from before the audience
 *   rule) are moved where only those who could read them see them
 *   (`chat.unmark`), once, as the runtime first starts with this release;
 *   operators run it again, or dry, over maintenance.
 * - Threads record where they came from (`parent`). A fork (a subthread) sees
 *   its parent's conversation up to the message it started at, through every
 *   level, without copying it; a new thread starts from its first message.
 *
 * - Agents are the app's (its `agents` resource). Three optional hooks widen
 *   that, each an unrecorded Action called as the asker, and cost nothing
 *   when absent: `agentSources` say what agents beyond the app's are (the
 *   team plugin's, agents people make), the `roster` says who answers
 *   in a space (the spaces plugin's): new conversations there go to its
 *   default, and only its agents are mentioned or messaged there, and
 *   `agentModel` says which model an agent thinks with in a space (the
 *   tiers plugin's), asked once each run of a turn; null, or none, is its
 *   own. Without a roster, every agent answers everywhere. `thread.agents`
 *   answers both for front ends.
 * - Each model call is tagged with its thread, agent, turn and space, for
 *   whoever records its use.
 *
 * Declares resource kinds the app (or another plugin) fills in, plain objects:
 * - `agents`: { instructions, model, effort?, maxTokens?, temperature?,
 *   tools?, description?, default?, name?, icon? }, where `model` is
 *   `"provider/model"`, an alias, or a list tried in order (see the models plugin);
 * - `tools`:  { description, input?, run(input) };
 * - `agentSources`: { action }: `{ names }` in, the definitions of those the asker meets out;
 * - `roster`: { action }: `{ space }` in, `{ agents, default? }` out;
 * - `agentModel`: { action }: `{ agent, space? }` in, a model or null out;
 * - `contactSend`: { action }: asked as a contact about to send, `{ thread?,
 *   files }` in (each file's name, type and size), and for each file it
 *   uploads, as a message to nobody (`to: []`) carrying it; it refuses, or
 *   answers `{ thread?, transcribe?: false }` (see shared/contact-send.ts);
 * - `additions`: { order?, agents? }, each with an `addition:<name>` View in
 *   the place that shows it, given `{ thread, answer }` (see `Addition`).
 */
import { definePlugin, failure, personOf, type Plugin } from "../../../runtime/mod.ts";
import { approveAction } from "./actions/approve.ts";
import { attachAction } from "./actions/attach.ts";
import { eraseAction } from "./actions/erase.ts";
import { forgetGrantAction } from "./actions/forget-grant.ts";
import { forkAction } from "./actions/fork.ts";
import { importAction } from "./actions/import.ts";
import { moveAction } from "./actions/move.ts";
import { notesAction } from "./actions/notes.ts";
import { unmarkAction } from "./actions/unmark.ts";
import { openAction } from "./actions/open.ts";
import { pruneAction } from "./actions/prune.ts";
import { quietAction } from "./actions/quiet.ts";
import { sayAction } from "./actions/say.ts";
import { sendAction } from "./actions/send.ts";
import { shownAction } from "./actions/shown.ts";
import { stopAction } from "./actions/stop.ts";
import { approval } from "./collections/approval.ts";
import { drafter, file } from "./collections/file.ts";
import { grant } from "./collections/grant.ts";
import { serveFile } from "./routes/files.ts";
import { intent } from "./collections/intent.ts";
import { live } from "./collections/live.ts";
import { message } from "./collections/message.ts";
import { shown } from "./collections/shown.ts";
import { thread } from "./collections/thread.ts";
import { wait } from "./collections/wait.ts";
import { turnRequested } from "./events/turn-requested.ts";
import { failedProcessor } from "./processors/failed.ts";
import { turnProcessor } from "./processors/turn.ts";
import { agentsOf, modelOf } from "./shared/agents.ts";
import { contextView } from "./views/context.ts";
import { historyView } from "./views/history.ts";
import { messageView } from "./views/message.ts";
import { notesContextView } from "./views/notes.ts";
import { participants } from "./views/participants.ts";
import { prompt } from "./views/prompt.ts";
import { chatTools } from "./resources/tools.ts";

export * from "./contract.ts";
export { lineage } from "./shared/lineage.ts";

/** Chat's collections, changed only through its Actions. */
const CHAT_RECORDS = ["message", "live", "thread", "file", "shown", "approval", "grant"];
/** What a person reaches only their own of: what agents ask them, and what they let. */
const OWNED = ["approval", "grant"];

export const chat: Plugin = definePlugin({
  name: "chat",
  requires: ["models"],
  collections: { thread, message, wait, live, file, intent, shown, approval, grant },
  views: {
    "llm.thread": prompt,
    participants: participants,
    context: contextView,
    history: historyView,
    "llm.message": messageView,
    "context:notes": notesContextView,
  },
  // Every agent's model can be called as configured (the models plugin says); a window by age
  // is in ms.
  async check(merged) {
    for (const [name, agent] of Object.entries(agentsOf(merged))) {
      if (agent.model === undefined) throw new Error(`Agent "${name}" has no model`);
      const maxAge = agent.history?.maxAge;
      if (maxAge !== undefined && !(Number.isFinite(maxAge) && maxAge > 0)) {
        throw new Error(`Agent "${name}": history.maxAge is in ms, a number over 0`);
      }
      try {
        await merged.call("models.check", { model: modelOf(agent), port: "llm" });
      } catch (error) {
        throw new Error(`Agent "${name}": ${(error as Error).message}`);
      }
    }
  },
  actions: {
    "chat.send": sendAction,
    "chat.attach": attachAction,
    "chat.prune": pruneAction,
    "chat.open": openAction,
    "chat.say": sayAction,
    "chat.quiet": quietAction,
    "chat.shown": shownAction,
    "chat.erase": eraseAction,
    "chat.fork": forkAction,
    "chat.stop": stopAction,
    "chat.move": moveAction,
    "chat.notes": notesAction,
    "chat.unmark": unmarkAction,
    "chat.import": importAction,
    "chat.approve": approveAction,
    "chat.forgetGrant": forgetGrantAction,
  },
  events: { "turn.requested": turnRequested },
  schedules: {
    // Files uploaded to send that no message sent within a day go.
    "chat.prune": { every: "1h", call: "chat.prune", input: {} },
    // The old marks come off once, as the runtime first starts with this release (a deploy).
    "chat.unmark": { once: true, call: "chat.unmark", input: {}, retries: 5 },
  },
  resources: {
    // Agents' own: the latest chats where they work (or another space they reach), and reading one.
    tools: chatTools,
    // An agent in a chat's notes is told whose chat they're about, and its latest.
    context: { notes: { place: "turn" } },
    // Conversations by title on Usage.
    usageNames: { thread: { tag: "tags.thread", collection: "thread", field: "title" } },
    // With the access plugin, chats live in spaces, and what's in a chat comes with it when it's
    // shared on its own (with a contact): its messages, files and what's being written. A contact
    // reads what's said there, never its agents' private steps (their tools' calls, with what each
    // returned), a tool's files, nor what's being written that may become one: of a turn that
    // offers tools, only that the agent is at work (no words, no call, no broken call's reason, a
    // provider's own); of one that offers none (`open`: every step an answer), its words as they come.
    shared: {
      thread: {},
      message: {
        drew: true,
        part: "thread",
        contact: { private: { $ne: true }, toolCalls: { $exists: false } },
      },
      file: { part: "thread", contact: { private: { $ne: true } } },
      live: {
        part: "thread",
        contact: {
          "calls.0": { $exists: false },
          retry: { $exists: false },
          $or: [{ open: true }, { text: "" }],
        },
      },
      shown: { part: "thread" },
    },
  },
  processors: {
    "chat.turn": turnProcessor,
    "chat.failed": failedProcessor,
  },
  // Chat's records change through its Actions, never written directly from outside: what's said
  // (who said it), what a turn is doing, a conversation's state, its files, what was shown. A file
  // not sent yet (a draft) is its sender's alone, wherever it is: a rule on every read and write
  // of files, that never lets anyone read them directly where no other rule does (`direct`).
  guard: (actor, { collection, access, direct }) => {
    if (direct && access === "write" && CHAT_RECORDS.includes(collection)) {
      throw failure("forbidden", `"${collection}" changes through chat's Actions (chat.send…).`, {
        public: true,
      });
    }
    // What agents ask, and what's let them: each person's own (those they answer, those they gave).
    if (OWNED.includes(collection)) {
      const person = personOf(actor);
      return person ? { owner: person } : { owner: { $in: [] } };
    }
    if (direct || collection !== "file") return undefined;
    const by = drafter(actor);
    const sent = { draft: { $exists: false } };
    return by ? { $or: [sent, { draft: by }] } : sent;
  },
  // Files people sent, as whoever asks reaches them (or by a link signed for one).
  routes: { "/files/*": serveFile },
});

export default chat;
