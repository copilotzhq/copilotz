## 1.0.0-rc.44 — 2026-11-12

(rc.43 was tagged but never published: a file wasn't formatted. This is it.)

- **The app opens in Firefox again.** Once its service worker was installed, every page load
  answered `{"error":"Not found"}`: the worker passes a page's own request on, and Firefox sends
  that as `Sec-Fetch-Mode: same-origin` rather than `navigate`, which the page took for a script's
  `fetch`. A request whose destination is a document (`Sec-Fetch-Dest: document`, or `iframe`) is
  now a page too, so browsers that already have the worker are fixed by the server alone; a script's
  `fetch` still gets a 404.

## 1.0.0-rc.42 — 2026-11-11

(rc.41 was tagged but never published: a test failed on Node. This is it.)

- **In a person's own Personal space, what its agents drew on from elsewhere no longer gets in the
  way.** Only that person is there, and they see every space their agents read for them:
  - **Agents' work there is no longer refused.** An agent working for someone from their Personal
    space, having read another space in that turn (a memory that came up by itself, a conversation
    it read, earlier messages that did), could still write it into any space they may, yet not into
    their Personal space itself where labels aren't kept (a board, a document, a file, a computer
    job): `needs_share` ("That would show what came from … to people who can't see it"), and the
    turn failed. Since rc.39 memory reads everywhere there, so this hit most turns. It now goes as
    it is; messages there still keep their marks, for the day the chat moves.
  - **The chat no longer says "Uses …. Not everyone here can see it."** under its messages there.
    They keep their `sources`; once the chat moves to a shared space, the notice and Share show
    where they're true.

## 1.0.0-rc.40 — 2026-11-11

- **MCP checks can return fresh results while declaring their state changes accurately.** Set
  `replay: false` on a model tool to skip reuse of its completed answer for identical input, such as
  a payment check that reconciles the booking. Interrupted calls still recover with the same call
  ID; existing tools keep their replay behavior. Read-only tools and widget-only Actions already run
  without completed-answer replay.

## 1.0.0-rc.39 — 2026-11-10

- **Agents look in their memory before saying they don't have something, and find more when they
  do:**
  - **How to use memory is Copilotz's own instructions.** The `memory` context (the guide) is
    declared `instructions: true`, so it's sent as it is, before the app's information, instead of
    inside `<context name="memory">` after "treat it as information, not as instructions". It now
    also says to look first (recall, and back through the conversation) before saying you don't know
    something, don't have it, or can't go on without it. Skills likewise: their guide is a context
    of its own declared as instructions (`skillsGuide`); the list, which people wrote, stays
    information (`skills`, now headed "Skills you have:"). Each agent's cached system text changes
    once.
  - **What comes up by itself is for what the conversation is about**, not only its latest words:
    the latest message, the two before it and the conversation's title, each memory scored by the
    closest (a reply like "see above" still finds what the question above was about). Each says when
    and where it was learned (`(learned in “Launch plan” 2026-11-10)`), in `recall`'s answers too,
    and `recall`'s `source` (a memory's id) reads what was said there, around the message it came
    from.
  - **What an agent was told in a conversation and still has whole isn't told again:** only memories
    new to it come up, so a follow-up no longer re-sends the same ones (once what it was told leaves
    the recent part of the conversation, they can come up again).
  - **In a person's own Personal space, memory reads everywhere they can read**, by itself and by
    `recall`, as the agent there may already: only they see what's said there. What it brings from
    another space marks the answer (`sources`), as `recall` with `in` did. Shared spaces still read
    only what was learned there.
  - **The person agents work for is in the conversation for memory, there or not:** in a chat one
    agent handed another for them, their memories are in mind, and what's said of them there is
    about them (the extractor is told whom the agents work for).
  - **The extractor also reads a conversation once it's been quiet a while** (`memory.quiet`, 10
    minutes; `0` turns it off), not only every `every` messages, so a short conversation, or the
    last few messages of any, isn't left unread. Each message sets the conversation's timer again;
    `memory.extract`, called by it, reads what's pending.

- **An agent's tool steps keep a line of their own when they leave the tail,** so what it read and
  ran stays in reach in a long working chat. Until now a step (an agent's tool calls with what they
  returned, which only that agent is sent) left the tail without a line: zoom couldn't reach it and
  `read_conversation` leaves steps out, so what an agent learned from a tool and didn't repeat in a
  reply was gone for it. Now each step that leaves is a line in a tree of its agent's own in that
  thread: written as the thread's are (one as it is when short, else by the summarizer from the
  step's start and end), merged in pairs, within the outline's budget, and committed with the
  thread's lines, so a prompt's start still changes once a cut. Only that agent is sent its lines,
  among the thread's by when they were written (`s12+4|…`), and `zoom` opens them the same way
  (`zoom("s12", 4)`), down to the step whole; another agent's are no line of its own to open.
  `summary` documents of a step's tree say whose (`agent`), and the `outline` keeps each agent's
  lines (`steps`). Steps that left before this have no line.

## 1.0.0-rc.38 — 2026-11-10

- **MCP 2026-07-28 cacheable results, widget read schemas, cross-origin MCP lines, and
  `/.well-known/`:**
  - `resources/list`, `resources/templates/list` and `resources/read` now include `ttlMs` and
    `cacheScope` on MCP `2026-07-28` (`CacheableResult`), and handshake versions (`2025-11-25` and
    earlier) omit them on `tools/list` and resource results where `CacheableResult` does not exist.
  - Widget tool inputs (`_reads` and `copilotz_read`'s `reads`) now declare their `items` object
    schema so strict MCP clients accept `tools/list` when widgets are enabled.
  - Stateless routes (`Route.crossOrigin`) enforce their own `Origin` rules without reading session
    cookies, so an MCP line's `origins` (including `"*"`) answers browser preflights (`OPTIONS`) and
    cross-origin `POST`s with CORS headers while keeping no-browser-origin (`403`) as the default.
  - `webPage`'s `/*` catch-all leaves `/.well-known/*` as `404` when no plugin serves a route there,
    instead of answering discovery probes with the HTML page.
- **A person's next message answers the question an agent waits on them for,** as the web says it
  does ("Waiting on your answer: your next message replies"). `chat.send` finds it when a message
  names none (`replyTo`): the newest question to its sender in that chat that an agent still waits
  on; else one asked of them elsewhere by an agent whose turn waits in that chat, so what they tell
  it there resumes that turn instead of starting a second one beside it. Never for a message sent
  for them (`via`: a routine's), nor to an agent it doesn't go to (`to`, `@mentions`). Until now
  only WhatsApp found it (its own lookup is gone; a quoted message still names what it answers): on
  the web, an answer in the chat an agent opened to ask went to nobody, and the asking turn, with
  whatever waited on it (an answer to hand back to another space), never resumed.

## 1.0.0-rc.37 — 2026-11-10

**Upgrading.** The web shell says nine new words, which an app in another language gives under
`shell.<key>` (its words test names any it lacks): `yourName` ("Your name"), `addYourName` ("Add
your name"), `nameAbout` ("How people and agents here see you."), `nameLabel` ("Name"), `nameEmpty`
("Leave it empty to go by your email."), `nameNotSaved` ("Your name wasn't saved. {reason}"),
`nameTryAgain` ("Your name wasn't saved. Try again in a moment."), `cancel` ("Cancel") and `save`
("Save").

- **A person names themselves** (`person.rename` `{ name }`, identity's). Only a person, for
  themselves, in person: never a contact, a key, an agent or a routine, and there's no one else to
  name. The name is one line (spaces, tabs and breaks in a row are one space), trimmed, 80
  characters at most (said plainly past that); empty, it's cleared, and they have none. It's what
  everyone sees of them: their menu, home's greeting, the people beside them in a space, agents'
  prompts (the spaces plugin's profile follows it, else their email's name, as before).
- **Sign-ins keep the name a person chose,** or their having none: Google's sign-in, email's, and
  the system's `person.set` (a directory's handoff into an org) no longer set it back. Until a
  person chooses (their record's `named`: when they last did), sign-ins keep their name current as
  before.
- **The person's menu opens with their name,** "Your name" ("Add your name" with none), in a dialog:
  the field holds it, selected, so typing replaces it; Enter saves; a live preview shows how they'll
  appear; while it saves the field waits; a refusal is said under it and the dialog stays. So the
  menu is always a menu now, with or without front ends' entries.
- **The new name shows at once, everywhere, without reloading:** in this tab and their others. The
  web host keeps the page's viewer as the person's own record says (it watches it: their name and
  email), and draws again when it changes; Views read it as before (`ctx.viewer.label`).
- **No name, no id:** with none, the menu shows the person's email (`ctx.viewer.email`, new, from
  identity's `/me`), and home greets them plainly ("Good morning"). An app whose ids aren't names
  (`01JD3X…`) showed the id in both.

## 1.0.0-rc.36 — 2026-11-10

**Upgrading.** Chat has two tools of its own, `list_conversations` and `read_conversation`, for the
agents that list them in their `tools`. An app that made its own tools under those names drops them
and lists chat's, which do the same and take a space. A Personal space's agents now write elsewhere
for their person without labels from there (below): an app that relied on that refusal says so in
its own rules.

- **Agents work under the authority of whoever asked** ([design](design/work.md), "Authority"). In a
  person's own Personal space, where only they read the answers, their agents reach every space they
  do, and now act there too. That makes the Personal chat a chief of staff:
  - **Tools take a space** (`in`, its id, which the `elsewhere` context lists): `list_conversations`
    and `read_conversation` (new, chat's own), boards (`list_boards`, `read_board`, `create_board`,
    `create_card`, `update_card`, `move_card`), documents (`list_documents`, `read_document`,
    `write_document`, `append_document`, `edit_document`), routines (`schedule_routine`,
    `list_routines`, `cancel_routine`: a routine kept elsewhere starts a new conversation there each
    run) and `recall`, as before. From a shared space they work only there and in what it draws on,
    and say so (`workIn`, in the agents' contract, for apps' tools).
  - **`send_message` takes `thread`:** a conversation that's there already, in this space or any
    other the person can write in. Who answers there gets it (`to`, or the conversation's own
    agent), it says where it came from, and the answer comes back, as a hand-over's does.
  - **What they write elsewhere is the person's:** work for someone from their own Personal space
    takes no labels from there (`labels.write`, `ownPersonal`). Before, everything an agent wrote
    from Personal into a space others see was refused (`needs_share`), even a card the person asked
    for. What's written in the Personal space itself keeps its marks (its conversation may move),
    and labels guard shared spaces and contacts' chats as before.

## 1.0.0-rc.35 — 2026-11-09

**Fixed: a retried call's nested calls.** A call run again under its id (a retry after a failure or
a stop) looked up its own nested recorded calls without its actor. In a person's or contact's job
the runtime then refused the lookup ("This job can't act as that"), and the retry failed. It now
asks as whom the call works for. This affected any person or contact Action retried after it made a
nested recorded call, and retried Processor deliveries; it has been so since the authority checks.

The MCP line's tests now wait for what they assert rather than for fixed times (they flaked on macOS
runners). Nothing to do when upgrading from rc.34.

## 1.0.0-rc.34 — 2026-11-09

rc.33, released whole. rc.33's publish stopped before npm: packing its tarballs, npm took `dist/npm`
for a GitHub repository. JSR has `@copilotz/copilotz@1.0.0-rc.33`, and nothing else has rc.33. This
release is rc.33's code, with the publish workflow's paths starting with `./`. Upgrading from rc.32
is as rc.33 says, below, with each version 1.0.0-rc.34.

## 1.0.0-rc.33 — 2026-11-09

**Upgrading.** Copilotz's product plugins are packages of their own, released with it at its version
([design](design/plugins.md)). Their names (collections, Actions, events, Views, routes, resources)
are as they were, so an app's data stays as it is: only its imports change.

- `copilotz/plugins/work` → `@copilotz/work`, and `copilotz/plugins/work/web` →
  `@copilotz/work/web`.
- `copilotz/plugins/access`'s `directory` (with `Operations`, `OrgInfo`…) → `@copilotz/directory`;
  the directory's browser half in `copilotz/plugins/access/web` (`useOrgs`, `enterOrg`,
  `refreshOrgs`…) → `@copilotz/directory/web` (or `@copilotz/directory/contract`).
- `copilotz/plugins/billing`'s `credits`, `stripe` and `stripeWebhook` → `@copilotz/billing`, and
  `creditsWeb` → `@copilotz/billing/web`. `usage` stays in `copilotz/plugins/billing`.
- `copilotz/plugins/agents`'s `team` and `tiers` → `@copilotz/team`, and `teamWeb`, `tiersWeb` →
  `@copilotz/team/web`.
- An app serving many orgs adds `directoryWeb` (from `@copilotz/directory/web`) to its page: the web
  shell has no org switcher, org page or console of its own any more. Their words keep their keys
  (`shell.<key>`).
- On Deno, name each in the import map at Copilotz's version
  (`"@copilotz/work": "jsr:@copilotz/work@<version>"`); on npm, install it beside `copilotz` at the
  same version, or, until npm has it, from the release's tarball.

```ts
import { boards, documents } from "@copilotz/work"; // was copilotz/plugins/work
import { directoryWeb } from "@copilotz/directory/web";

await web({ plugins: [webShell, chatWeb, spacesWeb, directoryWeb, boardsWeb], root });
```

- **Product packages** ([design](design/plugins.md)): `@copilotz/work` (boards, documents),
  `@copilotz/directory` (many orgs behind one address), `@copilotz/billing` (credits, Stripe) and
  `@copilotz/team` (agents people make, model tiers), each in `packages/<name>` with its `mod.ts`,
  `web.tsx`, `contract.ts`, tests and README, on JSR and npm. They import Copilotz by its entry
  points alone, as an outside plugin would; the core imports none of them, its tests neither.
- **The web shell knows no orgs.** Its `orgs` slot (a resource) takes a switcher View, an overlay
  View and a hook for what the menu and palette list; `directoryWeb` fills it. The person's standing
  in the org is spaces' `org.me` (`useStanding`, in the shell's contract), which spaces' sidebar and
  credits' note read; renaming the org says so (`orgsChanged()`).
- **The core's contracts are entry points:** `copilotz/plugins/<theme>/contract` (access, agents,
  models, interfaces, compute), each theme's plugins' `contract.ts` together.
- **Testing:** `copilotz/testing/words` (`pseudoWords`, `englishLeft`, `wordsList`) and `openTo`
  (what a kind of caller is let into of some plugins), for packages' tests as for Copilotz's.
- **Releases:** `npm run build` builds Copilotz and every package; the smoke test installs them all
  together from their tarballs and uses a plugin of each; a release attaches every tarball to its
  GitHub release before publishing, and publishes the packages after Copilotz, each on its own (one
  a registry doesn't have yet is skipped, with a notice). `node scripts/version.ts <version>` says a
  version everywhere, in lockstep.

## 1.0.0-rc.32 — 2026-11-09

**Upgrading.** `people` now lets in an agent working for a person, and an Action's `allow` is asked
of code acting for someone too (a tool's `ctx.call`, a Processor's, another Action's), not only of
outside callers. Go through your Actions:

- Say `inPerson` for what only the person decides (consent, keys, who's in a space, money,
  publishing): it never lets in an agent, a key or a routine's work. Say `people` for the rest. An
  `allow` written as `(actor) => actor.kind === "person"` keeps your own tools' agents out: say
  `people`.
- An Action whose run takes `ctx.actor.id` for a person's id, or checks something only when
  `ctx.actor.kind === "person"`, reads `personOf(ctx.actor)` instead (an agent's id isn't its
  person's).
- A tool calling an Action its agent's person couldn't is refused (`forbidden`): let them in, or go
  beyond on purpose with a named grant, `ctx.as(grant("<why>"))`.
- An agent's work reaches only where it is (its chat's space) and what that space draws on: a tool
  that read across its person's spaces from a shared chat finds less. Have the space draw on the
  other (`member.set` of a space), work from the person's Personal space, or hand the work over.
- Tools read where they are from `ctx.in`, not their chat's `in`.
- A developer key no longer calls what's now `inPerson` (`space.create`, `member.*`, `invitation.*`,
  `share`, `chat.move`, `agent.create`…), even listed in its scope.
- An MCP line listing a tool without its `tool:<name>` View doesn't start: add the View.

```ts
import { grant, inPerson, people, personOf } from "@copilotz/copilotz";

"invoice.send": defineAction({ allow: inPerson, … }),       // only the person decides
"invoice.draft": defineAction({ allow: people, run: (ctx) => draft(personOf(ctx.actor)) }),
// a tool, in its chat's space; going beyond its person on purpose, on the record:
run: async (input, ctx) => await ctx.as(grant("availability")).call("slots.all", { in: ctx.in }),
```

- **Who, for whom, where** ([design](design/work.md)). All work runs as an actor, for whom it's done
  (`for`) and where (`in`, an opaque id: a space, to the access plugin), which the runtime carries
  as it carries the actor: into nested calls, tools, the Processors a call's events wake, its timers
  and the Views observed for it; every event records it; `guard` and `allow` see it; contexts say it
  (`ctx.in`, on Actions, Processors, tools, queries and Views). `ctx.as` stays where the work is
  unless told where. Every way in says it: a browser's calls (its page's space;
  `client.call(…,
  { in })`), the terminal (where its person works), a key (its space), WhatsApp,
  voice, web and MCP lines (theirs), routines (theirs), a chat's turn (its chat's).
- **An agent's work reaches only where it is.** Reach for work done for someone is the person's
  reach ∩ the agent's memberships ∩ its space and what that draws on, at the role it draws on it
  with; in the person's own Personal space, all they reach. North working for Ana in a shared space
  reached every space of Ana's (the core agents are members of all of them), and only labels kept
  Finance from Launch's members: now it reads Launch and its sources. A person acting themselves
  isn't narrowed; a tool or routine acting as them is. An agent actor's `at` is `in`.
- **`allow` is asked wherever someone acts:** from outside as before, and from code acting for an
  actor (`ctx.call`, a timer, a read's unrecorded calls); for an agent, of whom it works for too
  (`allows`). Actions without one stay internal. Going beyond is a named grant (`grant`), on the
  record as the grant, `via` whose work it was, and counted (`copilotz.elevated.ops`).
- **Copilotz's own Actions say which:** `inPerson` for sessions, connected accounts, who's in a
  space or the org, `share`, `chat.move`, `memory.move`, `agent.create/update/delete`,
  `computer.code`, `computer.work` and `app.publish`, beside those that were; `people` for the rest,
  boards and documents included (their agents' own tools couldn't call them). `chat.send` and
  `chat.attach` let in people and contacts writing as themselves, never an agent. Code that took the
  actor's id for its person's (`space.personal`, invitations, accounts, desks, cloud computers,
  usage) asks `personOf`; an environment changes only by its space's managers, whoever asks.
- **Reach is kept in the owner** per who, for whom and where, until a commit changes a membership or
  a space it read (`ReadContext.kept`: what rules work out from reads, let go exactly when what they
  read changes; `cache.kept`, 1,000). An agent's turn works out its reach once, not on every op.
  With narrowing, an agent's work for a person in one of 1,000 spaces (`examples/work-bench.ts`)
  takes a fifth of the time: a turn's 13 ops, 4.4 ms median (21.5 before), 5.3 ms at p95 (22.9); the
  person's own, 4.7 ms (11.7). Nothing measured got slower.
- **Tools know where they are** (`ctx.in`): documents, boards, computers, cloud computers, apps,
  memory, skills, routines and an API's files no longer read their chat to find its space. What's
  learned stays where it's learned.
- **Handing work to another space** writes under its grant (`chat.hand-over`, and `chat.hand-back`
  for the answer), for the same person, in the new space; its check is the person's, anywhere.
- **mcp:** a listed tool without its `tool:<name>` View stops the app from starting (it was left
  out, said once in the log). A line's contact, its widgets and its tools work in its space.
- **Model-use listeners** get `as` in a job; a web line's budget prices its visitors' use as its
  grant (`web.budget`).
- **Startup checks** see the Views' names (`merged.views`).

## 1.0.0-rc.31 — 2026-11-08

- **A write the rules refuse in a transaction no longer holds up every write.** Refused before it
  reached its transaction, it left the transaction open, holding the store's writer: the Action's
  failure and every other write in the app waited 30 s, until it was rolled back as idle. Now it
  ends its transaction at once, as an op that fails in one does: it rolls back, and its later ops
  fail ("The transaction is closed."), even when the error is caught. Code that caught a failed op
  and wrote on used to commit what came after it. A transaction with no op for 5 s (30 s before)
  rolls back, and `copilotz.transaction.duration` measures how long each one held the writer.
- **Boards** no longer read a new card back inside its transaction: one round trip less per card.

## 1.0.0-rc.30 — 2026-11-08

**Upgrading.** `chat.send` no longer takes a file's content. Upload each file first with
`chat.attach` (`{ name, type, data, voice? }`, as `files` took it), and send what it answers by id:

```ts
const { id } = await runtime.call("chat.attach", {
  name: "plan.pdf",
  type: "application/pdf",
  data,
});
await runtime.call("chat.send", { text: "The plan", files: [{ id }] });
```

Call both as the same sender: a draft is sent only by its uploader's message. An API key that sends
files needs `chat.attach` in its scope: the "Chat" preset has it now, and a key made with it before
is made again (or given `chat.attach`).

- **Files of about 10 MB go, ten to a message.** `chat.send` carried every file's content, on record
  with what it wrote too, in one call, and a call carries at most 16 MiB to the owner: a file past
  about 6 MB was refused (`payload_too_large`). Now each file is its own call (`chat.attach`,
  unrecorded), kept as its sender's draft (`draft`, in no conversation: nobody else reads it, a rule
  of chat's own), and the message names it: its commit makes it the conversation's, under the rules
  as the message is. The web composer uploads each file as it's chosen (reading, uploading, its
  size, or why it couldn't), so sending is instant; a voice message uploads once, also when it's
  sent again without a transcript. WhatsApp uploads what a phone sends the same way.
- **Drafts are bounded:** a sender holds 20 at most (the oldest go past them), and `chat.prune`
  (chat's schedule, every hour) drops those not sent within a day. A contact's upload is let in by
  the `contactSend` hooks as a message to nobody carrying it: a web line's file rules apply as it's
  uploaded, and it counts against the visitor's limits.

## 1.0.0-rc.29 — 2026-11-07

- **An agent waiting on your yes waits within its turn.** A command, job or file write that needs a
  person's OK used to end the agent's turn ("Waiting for ana's yes…"). The turn's answer went to
  whoever had asked it, and the yes then started a new turn that answered the person. So when one
  agent asked another, and that one needed a yes, the first got "I'm waiting on your yes" as its
  answer and the real answer went to the person. Now the turn pauses, as it does for the messages it
  sends. The call asks its person a question: the agent's message to them, answered on the approval
  card. The answer is a reply to that question, and the same turn goes on. The call runs again as
  itself, in a step after the answer, so the agent reads its question, the answer, then what the
  command did, and its answer goes to whoever started the turn. Several asks in one step wait
  together, and the turn goes on once, when the last is answered: what was allowed runs, and what
  wasn't says no. A yes in this conversation, or always, answers the agent's other asks it covers,
  and their turns go on too. A reply typed to the question isn't a yes: the call doesn't run, and
  says what they said. A card asked in a side thread shows in its conversation too ("in a side
  thread"). A card answered before its step is written is refused (`busy`, "answer in a moment");
  the card shows only once the step is written anyway. Forgetting a computer tells a turn waiting on
  it no. A model outside (MCP) still gets "Waiting for…" and asks again later, as before.
- **Tools can wait for a person** (`ToolContext.ask`, in chat's contract). In a turn, a tool asks
  `{ to, text }` and gets the question's id; the turn waits for a reply to it (a message with that
  `replyTo`), then runs the call again with `answer` (who answered, and what they said). The
  question is written with the step. Steps record it (`Step.asked`), as they record what they sent
  (`sent`). The `conversation` resource's Views get the conversation's side threads too (hint
  `side`).

## 1.0.0-rc.28 — 2026-11-07

- **A deploy hands over instead of fencing** (`serve` in `copilotz/web/node`, `lease` in
  `copilotz/stores/postgres`). While a deploy moves traffic, the platform keeps the old process
  running for as long as its browsers' sockets stay open, and the new process's store fenced it:
  every write those browsers sent failed ("This owner was fenced"). Now one process at a time holds
  the store's lease: `serve` listens first (a request is told it's starting: a 503 to retry, a page
  that reloads itself), waits for the lease, then opens the app; the old process, asked for it,
  stops listening (its browsers reconnect, to the new one), lets running work finish, and lets go.
  Only a deploy at least as new asks (`revision`); a process that loses the lease stops. Its table
  is `copilotz_lease`, in the schema it's given (`public` by default).
- **A contact's message may go to nobody** (`chat.send` with `to: []`), as a person's already could:
  it's kept in the chat, its agents read it the next time they answer there (with its `tap`, as
  `[tapped: <id>]`), and none answers it. It's how a page beside the chat says what the customer did
  there (a trip chosen in a booking panel) without a turn for each tap. A contact still names no
  agent: any other `to` goes to its chat's agents, as before. `contactSend` hooks are told
  (`to: []`): a web line's visitor's message to nobody counts against its limits but holds none of
  the line's budget, since no turn will be charged for it.

## 1.0.0-rc.27 — 2026-11-06

**Upgrading.** Chat's `file.content` query is `file.about`, and answers a file without its content
(`data`). Host code that wants the content reads it as bytes, in parts:
`runtime.bytes("file", { _id }, "data", { actor })`, or serves it at `/files/<id>`. A file's content
is plain base64 (no line breaks, no `data:` prefix): `chat.send` refuses anything else.

- **Files of any size are served** (`GET /files/<id>`): a picture or a recording whose base64 passed
  1 MiB (about 750 KB) was answered as missing (404), so it showed broken. The route read the whole
  file through a query, whose answer comes from an executor over Oxian in one chunk, and Oxian takes
  at most 1 MiB a chunk. Now it reads what the file is (`file.about`, as whoever the request is),
  then its content from the owner, as them again (`runtime.bytes`), and decodes it as the response
  is read, 192 KiB at a time; a range (`206`) decodes only its part. Who reads a file is unchanged:
  the request's actor, a signed link as the system, and a file out of reach is a 404 alike. A
  failure that isn't about reach is now a 500, logged, not a 404.
- **`runtime.bytes(collection, filter, field, { actor })`**: a large value's bytes for trusted host
  code, read by the owner itself, under the rules as `actor` (the system without one), its `size`
  and `read(start, end)`, from the document or its blob (loaded once, at the first part). The blob's
  reference never leaves the owner.
- **Projections:** `find` and `findOne` take `{ projection }`, as MongoDB's (`{ name: 1 }` keeps,
  `{ data: 0 }` leaves out, `_id` either way; dotted paths into objects). The owner applies it
  before it loads any blob: a field left out costs no blob read. Stores never see it.
- **Answers past 1 MiB go in parts:** a job's output (a query's answer, an Action's result, a
  View's) and what a browser is pushed are written in parts of at most 1 MiB, Oxian's bound on a
  chunk. A long history, a prompt with pictures (`thread.prompt`, `/prompt`) or a large read a
  browser watches failed whole before (the executor "lost", the browser's session closed).
- **A message's files reach the prompt one read each:** `llm.message` read all of a message's files
  in one answer of the owner's, which carries at most 16 MiB; pictures that together passed it
  failed the turn.
- **WhatsApp links a file without reading its content:** sending a chat's file by signed link reads
  only whether its recipient may see it; Meta's fetch streams the content from `/files/<id>`.
- **Every word Copilotz's web front ends show is the app's to change.** An app in another language
  no longer rewrites the page as it is drawn: it gives a `words` resource
  (`{ "chat.send":
  "Enviar" }`), on any plugin the page runs, merged over the English in order.
  Words are by key (`hosts/web/WORDS.md` lists them: the shell, chat, spaces, memory, team, usage,
  the command palette, the toolkit and the host's notices), with `{blanks}` for names and numbers
  and plural forms by the page's language (`{ one, other }`). Dates, times, numbers and currency
  follow the page's `lang` (`webPage({ lang })`) instead of the browser's. Front ends of an app's
  own use the same way: `defineWords(area, { … })` from `copilotz/web`. English is unchanged, so an
  app that sets nothing looks as before. Not covered: the other front ends (billing's credits,
  routines, skills, computers, apps, API keys, WhatsApp, tiers), text the server sends, and the
  offline page.
- **Boards and documents are Copilotz's** (`copilotz/plugins/work`, front ends in
  `copilotz/plugins/work/web`). `boards` is kanban in a space (boards with ordered columns, cards
  dragged between them, owners, labels, due dates; Actions `board.*` and `card.*`; agents' tools
  `list_boards`, `read_board`, `create_board`, `create_card`, `update_card`, `move_card`).
  `documents` is shared Markdown in a space (every save a version, saves merged line by line or
  refused as a `conflict`, restoring, presence; Actions `document.*`; agents' tools
  `list_documents`, `read_document`, `write_document`, `append_document`, `edit_document`). Each has
  its web front end (`boardsWeb`, `documentsWeb`). The empty Board tab's line about agents is the
  app's: `resources.boardsText.agentHint`.
- **A `@word` is a mention only when it names someone.** Chat took any `@word` as a mention, so a
  message with a social handle ("my profile is @ana.marca") and no agent named reached no agent. Now
  a mention counts only when it names an agent, or a person in the conversation; any other `@word`
  is plain text, and the message goes where it would without it (the conversation's agents, or the
  space's default).
- **A failed recall never sinks a turn.** When memory recall fails at the start of a turn (the
  embedder's provider refuses the key, or times out), the turn goes on without recalled memories.
  The failure is logged (`memory: recall failed…`) and counted (`copilotz.memory.recall_failures`).
  A failing `remember` is still a tool error the agent sees.
- **Web tools** (`webTools`, in `copilotz/plugins/agents`): agents search the web and read a page
  without a computer. `web_search` `{ query, count?, language?, country? }` →
  `{ title, url,
  snippet }` results, through a new `search` adapter port (`duckduckgo`, the
  default: its HTML page, no key, no cost, a bot challenge or empty page is a public "search is
  unavailable" error; `serper`, optional; `fake`; one more adapter adds Brave or Google), and
  `read_page` `{ url, start? }` → the final URL, title, main text and links, in parts, marked as
  data. Reading refuses non-http(s) URLs, private, loopback, link-local and metadata addresses (the
  host resolved, checked again on every redirect), other ports than 80 and 443 unless
  `webTools.ports` lists them, pages over 2 MB or 15 s, and non-text types; a turn reads at most 8
  pages. A search is a `search` use of the usage ledger (in the `agents` category), priced from
  resources, asked of the `modelUse` listeners and the `spending` check first. The models contract
  now exports `mayUse` and `used`, for uses outside model calls.
- **An agent's message with files.** `chat.say` takes `files`, and `text` may be left out when there
  are files. Trusted code, such as a tool during a turn, can now post what it made without writing
  chat's collections itself. Each file is one of these:
  - `{ id, collection? }`: a document the caller reads that holds a file as `type` and `data`.
    That's chat's own `file` by default, or another plugin's, such as the models plugin's `image`.
  - `{ name, type, data }`: the file given as it is.

  Each becomes a file of the chat, with its `thread` and space. People and contacts read it there as
  they read people's files, and it meets the same limits: ten at most, about 10 MB each, and a media
  type. Its content is the same blob, so a picture kept elsewhere isn't stored twice. The answer
  adds the files' ids: `{ message, files }`. Saying it again sends nothing, files included. An
  agent's own message tells it next time what it sent: `[sent: logo.png]`.

- **A refusal says why.** A turn that fails with a refusal written for people answers in that
  refusal's own words, where only the codes `credits` and `budget` did before. That covers any
  failure made public, including the `spending` check's refusal whatever its `why`: an app's own
  reason, such as an inactive subscription, no longer needs to borrow `credits`. The `spending`
  refusal is now public, so a model outside the app reads its message too. A web line's spent budget
  now shows its own words ("This chat has done all it can for today…"). Every other failure still
  shows people the short line, with the details in the event. Moving in from another app. Nothing
  changes for an app that doesn't call these.

- **`chat.import`** (the system's: a migration) brings a conversation in as it was: its thread (the
  importer's id) in a space, with its title, and its messages with who said them (a person's id or
  an agent's name), to whom, what, their files (`data`, or the `id` of a document holding one:
  chat's `file` by default) and when (ISO 8601 with a zone, kept to the millisecond). Nothing runs:
  no turn, no transcript, nothing delivered. Importing again replaces what it made; a long
  conversation comes in several calls, and the thread's summary (count, first, latest, when it last
  moved) is worked out from every message it has. A thread already in another space is refused
  (`chat.move` moves it). Unrecorded: the documents it writes are their own record.
- **`memory.import`** (the system's) brings memories in as they were, in a space: text, whom each is
  about, who wrote it, `core`, when it was learned and last changed, under the importer's ids. Each
  is embedded as it's kept (with an embedder), so recall finds it by meaning.
- **Dev sign-in reaches someone already there:** an email a person has (one who moved in under an id
  of its own) signs in as them, and the id of someone there signs in as them too, both as they are
  (their name isn't touched). Anyone else signs in as before.

## 1.0.0-rc.26 — 2026-11-06

**Upgrading from rc.25.** The `hosts` resource names the app's own hosts an entry each, without the
`own` key it had alone. An app that names its hosts changes one line; one that doesn't changes
nothing. The shape before is refused at start, saying what's expected.

```ts
// rc.25
resources: { hosts: { own: ["app.example.com", "*.run.app"] } }
// now
resources: { hosts: { "app.example.com": true, "*.run.app": true } }
```

- **`resources.hosts` is an entry per host** (`{ "app.example.com": true }`), in place of
  `{ own: [...] }`, like every other resource: a later plugin adds a host, or takes one away with
  `null`, without restating the rest. What it does is unchanged: with the app's hosts named, any
  other host is answered only by routes that take it. `HostsSettings` is `Record<string, true>`.
- **Email sign-in** (`emailSignIn`, in `copilotz/plugins/access`, with identity and `email`): people
  sign in with an email and a password. Nothing changes for apps that don't add it.
  - **Flows,** each an unrecorded Action behind a route, those that end signed in answering with
    identity's `signedIn`: `email.sign-up` (a six-digit code by email, the password waiting for it)
    and `email.verify` (the person made, and a session); `email.sign-in`, refused with `unverified`
    (and a new code sent) until the address is confirmed; `email.forgot` (the same answer for any
    address) and `email.reset` (the password set, the person's other sessions ended);
    `email.invite`, trusted code's (a webhook after a purchase: the person, answered at once, and a
    link that works once for a day, `/#email-invite=<token>`), `email.invitation` and `email.accept`
    (the password chosen, signed in); and `email.import`, the system's, which keeps another app's
    password hashes as they are, for a migration, with the person ids the importer chooses. Routes:
    `GET /signin/email` (it's here; `signUp`), `POST /signin/email`, and `/signin/email/sign-up`,
    `verify`, `forgot`, `reset`, `invitation`, `accept`; a refusal answers `{ error, code }`.
  - **Passwords:** legacy hashes (`"<saltHex>:<hashHex>"`, PBKDF2-HMAC-SHA256 at 100,000, as
    Copilotz 0.x apps kept them) verify as stored and are hashed again at the next sign-in; new ones
    are `pbkdf2-sha256$6x100000$<salt>$<hash>` (PBKDF2 in six stages of 100,000, each salted with
    the stage before: workerd refuses more than 100,000 in one call), on WebCrypto, compared in
    constant time, in a private field (`email_login.hash`) no event or actor's read holds.
  - **Codes and links** are kept only as HMACs under the `links` secret (still matching under its
    `previous` while it changes), used once; codes last 15 minutes and five wrong tries. A stranger
    signing up first with someone's address can't choose their password: each code confirms the
    password its sign-up came with. Messages to an address (5 an hour), tries at it (10 in 15
    minutes) and one caller's asks (30, by the `caller` resource or the socket's address) are
    limited (`too_many`), the same whether or not the address has an account (`emailSignIn.limits`).
    What's past goes every ten minutes (`email.prune`).
  - **Its words** are the `emailSignIn` resource's `messages` (`verify`, `reset`, `invite`,
    `exists`), English unless the app gives its own; `app` names the app in them (the `links`
    origin's host unless said). It needs the `links` resource (`{ origin, secret }`) to start.
- **`email`, the app's email port:** `email.send` `{ to, subject, text, html? }` (trusted code's,
  unrecorded) through the adapter the `email` resource names: `resend` (Resend's API, through
  `ctx.fetch`, with its `apiKey` and `from`) or `console` (each message in the log, for a laptop;
  refused where the `links` origin is public). `EmailAdapter` and the settings' types are in its
  contract.
- **The sign-in page offers email** when `GET /signin/email` says it's there: sign in, create an
  account, the code (sent on once typed or pasted; a new one every 30 seconds), a new password by
  code, and arriving by an invitation's link to choose a password. Signing in by name moves under
  it, a click away. The toolkit has an `eye-off` icon. The example web app takes `EMAIL=1` (and
  `EMAIL_INVITE=<address>`) to try it, its messages in the terminal.
- **The sign-in page is the app's, in every word** (the `signInPage` resource of the browser's
  plugins, merged over Copilotz's as the theme is): `words` patch its phrases one by one by key
  (`SIGN_IN_WORDS` in `copilotz/web`: every heading, label, placeholder, button, hint and refusal of
  Google's, email's and dev sign-in's screens, refusals said by their code, never in the server's
  words); `about`, the panel beside the form (a headline, its quieter end, points with icons), is
  given whole (no Copilotz pitch stays beside an app's own), and `null` leaves the form alone. Its
  logo is the theme's and its name the page's title, as before; an app that says nothing shows
  Copilotz's words and pitch, as before. Google's button speaks `page.lang`. New in `copilotz/web`:
  `SIGN_IN_WORDS`, `COPILOTZ_ABOUT`, `signInPageOf` and the `SignInPage`, `SignInWords`,
  `SignInAbout` and `SignInPoint` types.
- **Image generation** in `models`: `image.generate`
  `{ model, prompt, references?, count?, aspectRatio?, size?, tags? }` answers
  `{ images: [{ id, type, size }], text, usage }`. The images are kept in the `image` collection, a
  document each, with the content as a blob, and the answer names them by id. A reference is an
  image made here (`{ id }`), a document the caller may read that holds a file as `type` and `data`
  (`{ id, collection: "file" }`, read as the caller), or inline data (`{ data, type }`, or a data
  URL). Models are chosen as `llm`'s are: an alias, settings around one, or a list tried in order.
  Adapters go under `adapters.image`: `gemini` (`generateContent` with `responseModalities`; `count`
  images are that many calls, made together), `openai` (`/images/generations`, or `/images/edits`
  with references), and `fake` (`"fake/image"`).
  - **Metered like every model call.** The org's own key comes first. `modelUse` listeners and the
    `spending` check go before the call. Its tokens are told to the ledger after, with meter
    `image`, priced from the catalog as `llm`'s are, and counted under agents. The provider's
    `silence` and `retry` apply.
  - **Refusals are final.** A model whose safety rules say no fails `image_refused`, and no other
    model is asked. One that makes nothing fails `no_image` once the list is spent. Both are public
    messages: an agent's tool tells its model why.
  - **Recorded, unlike the other ports' Actions.** It writes what it made, so a job that runs again
    finds the call done and doesn't pay twice. `models.check` takes `port: "image"`.
  - `keyed` and `mayRun` (the org's own key, and the spending check) moved from the llm port to
    `shared/use.ts`, so every port that spends asks the same way. Nothing changes for `llm`.

## 1.0.0-rc.25 — 2026-11-06

**Upgrading from rc.24.** The runtime now answers HTTP itself. `runtime.fetch(request)` is a fetch
handler (a function from a web-standard `Request` to a `Response`) that every host calls; plugins
declare their HTTP as `routes` (plain functions by URL pattern) and say who a request is with `who`
(a function from a request to an actor, or nothing); the runtime names and sets every cookie; the
page is a plugin (`webPage`); and many orgs are the directory's routes, forwarding each request to
its org's runtime. Every URL, webhook path and cookie name stays as it was, so nobody signs in
again. Developer keys made before stop working: make them again (step 7). The steps, in order:

1. **Composition: the page is a plugin, and the runtime takes no browser options.** Drop
   `transports: [socket]` and `admit: tickets.admit`: the runtime keeps its own one-time tickets and
   takes its own socket at `/oxian`. Add `webPage` (from `copilotz/web/server`) with a `page`
   resource. What `serve` and `webServer` took as options are resources now: `code`, `title`,
   `lang`, `assets` and `base` go in `page`; `theme` in `theme`; `front: { secret }` is the `caller`
   resource's `front` (beside its `header`); `widgets` go in `widgets`. `code` may be a function
   that bundles once, on the page's first request.

   ```ts
   // rc.24
   const tickets = createTickets(); // copilotz/web/tickets
   const runtime = await createRuntime({
     store,
     plugins: [...plugins, devSignIn],
     transports: [socket], // copilotz/web/server
     admit: tickets.admit,
   });

   // now
   const runtime = await createRuntime({
     store,
     plugins: [
       ...plugins,
       devSignIn,
       webPage,
       definePlugin({
         name: "page",
         resources: {
           page: { title: "Notes", code: () => bundle(new URL("./browser.tsx", import.meta.url)) },
           theme: themeOf([]),
         },
       }),
     ],
   });
   ```

2. **Serving: a listener calls `runtime.fetch`.** On Node and Bun, `listen(runtime.fetch, options)`
   from `copilotz/web/node` replaces `serve({ runtime, tickets, code, … })`. It answers a
   `Listener`, whose `shutdown()` stops listening, and you close the runtime yourself
   (`runtime.close({ drain })`). On Deno, `Deno.serve(runtime.fetch)` replaces serving
   `webServer({ …, upgrade })` with Oxian's Deno handler, and needs no `setClientAddress`: the
   runtime reads the socket's address from what `Deno.serve` hands it. On workerd,
   `export default { fetch: runtime.fetch }`. Bun's own `Bun.serve({ fetch: runtime.fetch })` serves
   requests but not the runtime's socket, so use `listen` there.

   ```ts
   // rc.24
   const server = await serve({ runtime, tickets, code, theme, port: 8080 });
   process.once("SIGTERM", () => server.close({ drain: 8_000 }));

   // now
   const server = await listen(runtime.fetch, { port: 8080 });
   process.once("SIGTERM", async () => {
     await server.shutdown();
     await runtime.close({ drain: 8_000 });
   });
   ```

3. **Settings: flat named entries, one `caller`, and `ctx.fetch`.** Each interface plugin's resource
   is a map of what the app declares, by name, with no `lines` key. `web.caller` and `mcp.caller`
   are one `caller` resource. `caller.exempt` is the MCP server's own `exempt`, `voice.keep` each
   number's `keep`, and `mcp.atOnce` each server's `limits.atOnce`; `whatsapp.codeMinutes` and
   `whatsapp.maxFileMb` are constants now, and a declared entry's `org` is gone (each org's runtime
   declares its own). Types: `WhatsAppLine` is `DeclaredNumber`, `VoiceLine` `DeclaredVoiceNumber`,
   `McpLine` `DeclaredServer`, `WebLine` `DeclaredSite`, and `McpCaller` `CallerSettings`. Plugin
   code calls outside services through `ctx.fetch` (step 10), so the `whatsapp.graph` setting,
   Stripe's `settings.fetch`, `googleKeys(fetcher)`'s argument and openapi's `fetch` setting are
   gone.

   ```ts
   // rc.24
   resources: {
     web: {
       caller: { header: "cf-connecting-ip", front },
       lines: { site: { in: "visitors", agent: "guide" } },
     },
     whatsapp: {
       lines: { vendas: { in: "customers", phoneId, token, secret, verify, agent: "mobi" } },
     },
     mcp: { atOnce: 4, lines: { chatgpt: { in: "customers", tools } } },
   }

   // now
   resources: {
     caller: { header: "cf-connecting-ip", front },
     web: { site: { in: "visitors", agent: "guide" } },
     whatsapp: { vendas: { in: "customers", phoneId, token, secret, verify, agent: "mobi" } },
     mcp: { chatgpt: { in: "customers", tools } },
   }
   ```

4. **Routes: plain functions on a plugin.** The `routes` resource goes, with its three shapes
   (`{ path, action }`, `{ path, serve }`, `{ host, serve }`), `methods`, `HttpRequest`,
   `HttpAnswer` and `Served`. A plugin's `routes` field maps a `URLPattern` pathname to a `Route`:
   `(request, { runtime, actor, params, cookies }) => Response`. A path that took everything under
   it (`"/hooks/"`) is `"/hooks/*"`; a host route is a whole URL pattern (`"*://*-preview.*:*/*"`);
   a route checks its own method. `host.runtime` is `ctx.runtime`, `await host.whom()` is
   `ctx.actor`, `host.host` is the request's own URL (already the site the browser asked for),
   `host.upgrade()` is Oxian's `upgradeWebSocket(request)`, and `host.widgets` is the `widgets`
   resource. A route calls Actions as trusted code, as the system unless it names an actor
   (`runtime.call(name, input, { actor })`): an Action that took an `HttpRequest` behind
   `{ path, action }` takes plain data now, and one only a route calls needs no `allow`.

   ```ts
   // rc.24
   resources: {
     routes: {
       ping: {
         path: "/hooks/ping",
         methods: ["POST"],
         serve: async (request, host) =>
           Response.json(await host.runtime.call("relay.ping", { body: await request.text() })),
       },
     },
   },

   // now
   routes: {
     "/hooks/ping": async (request, { runtime }) => {
       if (request.method !== "POST") return new Response("Only POST", { status: 405 });
       return Response.json(await runtime.call("relay.ping", { body: await request.text() }));
     },
   },
   ```

5. **Sign-in: plugins' routes, `who`, and the runtime's cookies.** The `entrances` and `signIn`
   resources go. Apps on `googleSignIn` and `devSignIn` change nothing: their routes are
   `POST /signin/google` (with `GET /google` for the button's client id) and `/signin/dev`, which
   the page already used. A sign-in method of your own is a plugin built on identity whose route
   calls its Action and answers with identity's `signedIn` (from `copilotz/plugins/access`), which
   sets the session's cookie. A credential of your own (an entrance's `cookie` and `query`) is a
   plugin's `who`, and its cookie is set and cleared with `ctx.cookies`: no plugin writes
   `Set-Cookie`. Identity's `POST /signout` ends the session, disconnects its browsers and clears
   its cookie; its `GET /me` says whom the page shows.

   ```ts
   // rc.24
   resources: {
     signIn: { mine: { action: "mine.sign-in" } },
     entrances: { badge: { cookie: "badge", query: "badge.actor" } },
   },

   // now
   definePlugin({
     name: "mine-sign-in",
     requires: ["identity"],
     actions: { "mine.sign-in": signInAction }, // answers { person, session }, as before
     routes: {
       "/signin/mine": async (request, { runtime, cookies }) =>
         signedIn(cookies, await runtime.call("mine.sign-in", await request.json())),
     },
     who: (_request, { cookies, query }) => {
       const secret = cookies.get("badge");
       return secret ? query("badge.actor", { secret }) : null;
     },
   });
   ```

6. **The site chat: its own route.** `web({ arrive: { line } })` is `web({ arrive: { name } })`. The
   page posts to the site chat's route, `POST /web/<name>` (with `{ challenge }` when it has one),
   before it connects, and `/connect` takes no JSON. `contact.arrive` loses its `secret` input. The
   cookie (`visitor`) and the limits are the same.

   ```tsx
   // rc.24
   await web({ root, plugins: [siteShell, chatWeb], arrive: { line: "site", challenge: token } });

   // now
   await web({ root, plugins: [siteShell, chatWeb], arrive: { name: "site", challenge: token } });
   ```

7. **Keys: members of their space, with a scope.** Every key is the api plugin's, and every key has
   a scope: `api_key.create` takes `scope` (`call`, `query`, `view`, `read`, `write`) in place of
   `actions`, `queries` and `views`, and `apiPresets` are `{ title, description, scope }`. An Action
   that takes a space gets no default from a key: the key names `in`. Identity's unscoped keys
   (`key.create`, `key.revoke`, `credential.keys`) are gone. Keys made before stop working: make
   them again.

   ```ts
   // rc.24
   await runtime.call("api_key.create", {
     in: space,
     name: "Bot",
     actions: ["chat.send"],
     queries: ["thread.recent"],
   }, { actor });

   // now
   await runtime.call("api_key.create", {
     in: space,
     name: "Bot",
     scope: { call: ["chat.send"], query: ["thread.recent"] },
   }, { actor });
   ```

8. **REST and the client.** `/api/` is the runtime's own now (the api plugin's `serveApi` is gone),
   answered for whoever `who` says: a key, a session from the app's own page, or anonymous. Its
   paths are unchanged, with more beside them (below). A View over `/api/` asked with `?follow=1` is
   asked with `Accept: text/event-stream`, and `?id=` is `?item=` (the item, as JSON). A script
   connects with the client instead of hand-made requests, over the socket or over HTTP, and its
   collections are spelled as plugin code's.

   ```ts
   // rc.24
   const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
   await fetch(`${app}/api/actions/booking.cancel`, {
     method: "POST",
     headers,
     body: '{"id":"42"}',
   });
   await fetch(`${app}/api/views/booking.panel?id=42&follow=1`, { headers });

   // now
   const client = await connect(app, { key }); // the socket; { key, over: "http" } for the REST API
   await client.call("booking.cancel", { id: "42" });
   const stop = client.db.collection("booking").watch({ _id: "42" }, (rows) => show(rows));
   // by hand: GET /api/views/booking.panel?item={"_id":"42"}, with Accept: text/event-stream
   ```

9. **Many orgs: the directory's routes.** `orgsHost` (`copilotz/orgs`) goes. The directory's runtime
   is the app's `fetch`, and its plugin's routes forward each request, untouched and sockets
   included, to its org's runtime. Its `directory` resource takes the orgs' runtimes as a pool
   (`orgs`: `runtimes(open)`, from `copilotz`) and a `lobby` for someone signed in nowhere (a
   runtime with the page), beside `staff` and `operations`; `hosts` is the `hosts` resource's `own`.
   Each org's runtime gets `directory.member(dir, org)`, in place of what `open` was given
   (`plugins`, `admit`, `transports`) and of `here(org)`. `listen(dir.fetch)` carries sockets too:
   no `hypervisor` picker. `org.get` is the `org.info` query, and front ends import the orgs'
   browser half (`useOrgs`, `enterOrg`…) from `copilotz/plugins/access/web`. Stripe's webhook is the
   `stripeWebhook` plugin, in the directory's runtime with the pool as the `stripe` resource's
   `orgs` (below).

   ```ts
   // rc.24
   const host = orgsHost({
     directory: await createRuntime({ store, plugins: [identity, directory, devSignIn] }),
     open: async (org, given) =>
       await createRuntime({
         store: storeOf(org),
         plugins: [...plugins, ...given.plugins],
         transports: given.transports,
         admit: given.admit,
         browsers: given.browsers,
       }),
     upgrade: () => new Response("Connect again", { status: 503 }),
     code,
     theme,
   });
   await listen({ fetch: host.serve, hypervisor: (r) => host.openRuntime(r)?.hypervisor, port });

   // now
   const orgs = runtimes(async (id) => {
     const org = await dir.query<OrgInfo | null>("org.info", { org: id });
     if (!org) return undefined;
     return await createRuntime({
       store: await storeOf(org),
       plugins: [...plugins, ...page, directory.member(dir, org)], // page: webPage and its resource
       browsers: { pool: visitors }, // const visitors = contactsPool()
     });
   });
   const lobby = await createRuntime({ store: memoryStore(), plugins: page });
   const dir: Runtime = await createRuntime({
     store,
     plugins: [
       identity,
       directory,
       devSignIn,
       definePlugin({
         name: "directory-settings",
         resources: { directory: { orgs, lobby } },
       }),
     ],
   });
   await listen(dir.fetch, { port });
   ```

10. **Tests: `testWho`, `ticketFor`, `runtime.fetch` and `createRuntime({ fetch })`.** A test that
    made browsers with `createRuntime({ admit })` adds `testWho` (from `copilotz/testing`: a `who`
    that believes the `x-test-actor` header, for tests alone) and takes each ticket from the
    runtime's `/connect` with `ticketFor(runtime, actor)`. HTTP needs no listener:
    `await runtime.fetch(new Request(url, init))`. A fake outside service (Meta's Graph API, Stripe,
    Google's keys) is the `fetch` the runtime gives plugin code, as `clock` is replaced.

    ```ts
    // rc.24
    const tickets = new Map<string, Actor>();
    const runtime = await createRuntime({
      store,
      plugins: [
        ...plugins,
        definePlugin({ name: "t", resources: { whatsapp: { graph: fake.url } } }),
      ],
      transports: [transport],
      admit: (secret) => tickets.get(secret),
    });
    const ticket = () => {
      const secret = crypto.randomUUID();
      tickets.set(secret, ana);
      return Promise.resolve(secret);
    };

    // now
    const runtime = await createRuntime({
      store,
      plugins: [...plugins, testWho],
      transports: [transport],
      fetch: fakeMeta,
    });
    const ticket = () => ticketFor(runtime, ana);
    const hook = await runtime.fetch(new Request("http://localhost/hooks/whatsapp/vendas", init));
    ```

**What changes, and what goes:**

- **`runtime.fetch(request, info?)`** answers every request: a route with a host first (a host it
  takes is that route's alone); the socket (`/oxian`, and `<base>/oxian`); then requests from other
  sites are refused; `POST /connect`; the REST API (`/api/`); plugins' routes; `GET /health` when no
  route takes it (`ok`); else a 404. What a listener passes beside the request (Deno's `info`, Bun's
  server) says the socket's address. Another runtime's route may forward a request to it
  (`other.fetch(request)`), sockets included: a socket `Deno.serve` gave stays Deno's to accept. The
  runtime accepts its own socket: Deno's upgrade under `Deno.serve`, a `WebSocketPair` on workerd
  (not tested yet), else Oxian's route upgrade, whose decision `listen` takes directly (Oxian
  0.23.4's asynchronous `prepare`).
- **The site** is decided once, before anything else: the address the browser asked for, on the host
  the app's front says when the request carries the front's secret (`x-copilotz-front`, the `caller`
  resource's `front`; then `x-forwarded-host`), and under the app's base (`resources.page.base`: a
  route sees `/o/acme/x` as `/x`). Routes are matched, and cookies named and secured, by it. Without
  the secret, forwarded headers are ignored.
- **Requests from other sites are refused** (403), in one rule in place of the web host's
  `fromPage`: a request that may change something (anything but GET, HEAD and OPTIONS), whose
  `Sec-Fetch-Site` isn't `same-origin` (or `none`) or whose `Origin` isn't the site's own, unless it
  carries `Authorization`. It holds for every route, not only `/connect`; a sibling host under the
  same domain is another site; webhooks send no `Origin`, and pass. So an MCP server's `origins`
  lets a browser's call through only with `Authorization`.
- **`resources.hosts`** (`{ own: ["app.example.com", "*.run.app"] }`): the app's own hosts. With
  them named, a request to any other host is answered only by routes that take its host (a 404 when
  none does), never by the runtime's paths, its socket or `/connect`; and the app's own hosts are
  never a host route's. A host route for every host (`*`) takes only hosts that aren't the app's
  own: with none named, none.
- **`who`** (`Plugin.who`, the `Who` and `WhoContext` types): asked in plugin order, once per
  request and when `/connect` issues a ticket; the first answer wins, and none is anonymous
  (`{ kind: "anonymous", id: "" }`). A `who` can't answer the system. What it queries is kept five
  seconds per query and params, and dropped when the actor is disconnected. `WhoContext` has
  `resources`, `query` and `call` (as the system: the api plugin notes a key's last use) and
  `cookies.get`. A request with both a session cookie and a key is whoever the first plugin in order
  says (usually the cookie). A store's failure while asking is a 500, never anonymous.
- **Routes** (`Plugin.routes`, the `Route` and `RouteContext` types): matched more specific first,
  segment by segment (a literal before a parameter before a wildcard, deeper before shallower), `/*`
  last, and among patterns alike in plugin order; a later plugin's route replaces an earlier one of
  the same pattern, and `null` removes it. A route that isn't a pattern, or takes `/connect`,
  `/oxian`, `/api` or anything under `/api/`, stops the runtime from starting. What a route throws
  answers by its code: `invalid` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404,
  `too_many` 429 (with `retry-after`), anything else 500 (logged), its words only when they're
  public.
- **Cookies** (`ctx.cookies`, the `Cookies` type): `get(name)`,
  `set(name, secret, { days, sameSite })` and `clear(name, { sameSite })`, by the plain name; the
  runtime puts them on the route's response. Every cookie is httpOnly, `Path=/`, with no `Domain`;
  `Secure` and named `__Host-<name>` anywhere but plain http to this machine or one on its network;
  `SameSite=Lax` (30 days) unless said. A value is 1 to 512 cookie-safe characters (letters, digits
  and `._~+/=-`): a short one is fine where it's no secret; a cookie holding anything else reads as
  none. A response that sets or clears one is `no-store`. A name is the first plugin's to set;
  another may only when one builds on the other (`requires`), or both on the same one (Google's and
  dev sign-in's, and the directory's sign-out, all set identity's session); anything else is a
  plugin's mistake, and a 500. The `cookies` resource (`{ names, suffix }`, the `CookieSettings`
  type) renames them: `names` maps a name to the one it goes by, and `suffix` follows every other.
- **Cookies the web host kept, and no longer does:** a leftover plain `session` cookie beside
  `__Host-session` is no longer cleared (it's ignored); a cookie that proves no one (forged, ended)
  is no longer cleared, and reads as nobody; `POST /signout` clears identity's `session` only (a
  site visitor's cookie stays).
- **Tickets are the runtime's** (`runtime/tickets.ts`): one works once, for a minute; an actor has
  30 a minute (`browsers.tickets`), past which `/connect` is a 429 with `retry-after`. Disconnecting
  an actor ends its tickets not yet used; a person's key has its own, apart from its person's.
  `createRuntime`'s `admit` is gone, and the runtime always has a key for remote executors (a new
  one each start, unless given).
- **`POST /connect`** (POST only: else 405) answers `{ ticket, actor: { kind, id } }` (no `name`:
  the page asks `GET /me`), 401 for anonymous, and reads no body: arriving at a site chat is
  `POST /web/<name>`.
- **Checked at start:** routes' patterns, `page.base` (a path with no trailing slash), the `cookies`
  and `hosts` resources, and the `links` secret (too short to sign with stops the start, rather than
  failing each link).
- **New in `copilotz`:** `runtimes` and `Runtimes`; `connect` and the client's types
  (`ClientCollection`, `RemoteOptions`, `Watcher`…); `inScope` and `Scope`; `clientAddress`,
  `setClientAddress` and `loopbackAddress` (were in `copilotz/web/server`); `bodyOf` and `jsonOf`;
  `cookieSafe` and `CookieSettings`; `hostMatches`, `HostsSettings`, `ownHost`, `vouched`,
  `loopback` and `nearby`; `callerOf` and `exemptProblem`; and the `Route`, `RouteContext`, `Who`,
  `WhoContext` and `Cookies` types.
- **`runtimes(open, { idleMs })`:** runtimes by id, each opened on its first `get`, the same one
  after (a failed opening is tried again), closed once idle (no browsers, nothing pending, 30
  minutes unless said) and opened again on its next use; `peek(id)` and `entries()` never open one;
  `close(id)` closes one now, and a `get` meanwhile opens another only once it has closed, so one id
  never has two writers; `close()` closes them all.
- **`listen(fetch, { hostname, port, signal })`** (was `listen({ fetch, hypervisor, … })`) serves
  any fetch handler on Node, Bun and Deno through Oxian's Node adapter, sockets included, and
  answers a `Listener` (`url`, `finished`, `shutdown()`). `serve`, `ServeOptions` and `Server` are
  gone.
- **The page plugin** (`webPage`, `copilotz/web/server`): `/app/*` (the code; the entry `no-cache`,
  chunks kept a year), `/assets/*`, `/manifest.webmanifest`, `/sw.js`, and `/*` for GET navigations
  only (`Sec-Fetch-Mode: navigate`, or an `Accept` with HTML, `*/*` or none): a script's `fetch`
  there is a 404, not the page. Its `/*` takes `GET /health` too, so the runtime's `ok` answers only
  an app without a page (with a page, `/health` was the page before as well). It refuses to start
  without `page.code`. The page tells its code the base (`appBase()`), and its `/connect` and socket
  follow it.
- **The page in the browser:** `web()` posts to `/web/<name>` first when it arrives as a visitor
  (`arrive: { name, challenge? }`), asks identity's `GET /me` for the person's name while it takes
  its ticket, and finds the ways to sign in by asking `GET /google` and `GET /signin/dev`.
- **Sign-in and sign-out are plugins' routes:** identity's `POST /signout` (ends the session,
  disconnects whoever it was, clears the cookie) and `GET /me` (401 for anyone but a person), and
  its contract's `signedIn` (sets the session's cookie, `SameSite=Lax` so an OAuth redirect back
  carries it, and answers `{ person }`); Google's `POST /signin/google` (`{ idToken }`) and
  `GET /google` (the first client id, cached five minutes); dev sign-in's `/signin/dev` (GET says
  it's there, POST `{ name }` signs in), from this machine only, as before. Nothing refuses to start
  with a recorded sign-in Action any more (the web host did): keep yours `record: false`, since its
  answer is the session's secret. `credential.revoke` (taking someone out of an org) disconnects
  their browsers and drops what `who` kept for them, so their next request is nobody at once.
- **Webhooks and other plugins' HTTP are routes; their URLs are unchanged:**
  - WhatsApp: `/hooks/whatsapp/*` does Meta's handshake and checks the signature, then calls
    `whatsapp.receive` with `{ number, payload }`; `whatsapp.number` finds a number by its path.
    Both are the system's (no `allow`); `whatsapp.hook` is gone. `hookRoute` is exported, for a
    number's own path.
  - Voice: `/hooks/voice/<name>` and `/hooks/voice/<name>/over` check Twilio's signature and call
    `voice.ring` and `voice.hangup` (`voice.hook` is gone); `/hooks/voice/<name>/relay` takes the
    call's socket with Oxian's `upgradeWebSocket`.
  - MCP: `/mcp/*`, finding the app's widgets in the `widgets` resource (was
    `webServer({ widgets })`).
  - Maintenance: `/maintenance/*`; an org's runtime (`resources.org`) still never serves it.
  - Chat: `GET /files/<id>` is chat's route (was the web host's), read as whoever the request is, or
    by a link signed for the file.
  - Connected accounts: `GET /accounts/callback/<provider>` calls `account.callback` with
    `{ provider, code, state, error? }` as the session's person, and sends them back to Connected
    accounts.
  - Computers: previews are one route for every host shaped like a preview's
    (`*://*-preview.*:*/*`), answering only for the app's `previews.domain`, with the grant at
    `/__copilotz/previews/grant`; a release's downloads (`computerDownloads({ dir })`) are
    `/computer/download/*`.
  - Stripe: `stripeWebhook` is a plugin (was a function the app routed to by hand),
    `POST /__stripe/<seller>`: it checks the signature on the raw text, reads the event as facts
    (`stripe.fact`, asking Stripe for a dispute's charge through `ctx.fetch`), and hands them to the
    org's runtime as `billing.apply` under the event's id. Which runtime is the org's: the `stripe`
    resource's `orgs` (the directory's pool), or without them this runtime, when the event is for
    its org. The plan an org goes back to is the `billing` resource's `start` ("free" unless said),
    not a `start` option. What can be tried again answers 500; what never can, 200.
  - The cloud pool: its VMs' socket (`/__pool/oxian`) is `cloudPool`'s route, answered by its
    runtime's own socket.
- **The site chat:** `POST /web/<name>` limits newcomers by address, runs the site's challenge,
  calls `contact.arrive` and sets the visitor cookie (`SameSite=Strict`); the site chat's `who`
  reads it. `contact_visitor.actor` now answers a visitor that hasn't spoken yet too.
- **`ctx.fetch`** (`Context.fetch`, `ReadContext.fetch`): what plugin code calls outside services
  with, in Actions, Processors and queries, remote executors included; the platform's `fetch` unless
  `createRuntime({ fetch })` gives another. Adapters stay for real ports (model providers).
- **The REST API is the runtime's own** (`/api/`, answered by `runtime.fetch` for whoever `who`
  says): collections (`GET /api/collections/<name>?filter=…`, `…/<id>`; `POST`, `PATCH`, `PUT`,
  `DELETE`), Actions by the caller's own call id (`Idempotency-Key`), queries (`GET ?params=` or
  `POST`), Views, emits (`POST /api/events/<type>`), the events stream, and the reference
  (`GET /api/`); any GET with `Accept: text/event-stream` is a watch. A credential that proves
  nobody is a 401, and so is a refusal to anonymous. Any origin may call it with a key; with a
  session's cookie, only the app's own page. Streams end at once when their actor is disconnected,
  and at each ping (every 20 s, on the runtime's clock) when `who` says someone else. The api
  plugin's `serveApi`, `Served`, its own HTTP, events and reference, and its `api_key.see` and
  `api_key.get` queries are gone; the reference says `actor` (no `key` record).
- **Direct writes from outside** (REST, and the socket's new `core.write`): only where a rule speaks
  for the collection's writes (`Guard`'s operation gains `direct`), never `sys.*`, never a private
  field (nor a filter, sort or update that names one, over the socket too; a replacement keeps
  them), within the caller's reach, schema-checked, and recorded as the caller's events.
  **Breaking:** plugins' records change through their Actions: their rules refuse direct writes for
  spaces, memberships, invitations and requests; identity's people and sessions; keys; contacts;
  chat's messages, `live`, threads, files and what was shown (`shown`); memories; skills and their
  files; routines and their runs; the computers plugin's records; apps; cloud computers; agents;
  accounts; WhatsApp's phones and numbers; and voice blocks. Still writable directly, each under its
  rule: apps' own collections (an app guards its own the same way when its rules assume its
  Actions). Following events or watching a read holds a request open: an anonymous caller gets 401.
  The events stream follows the rules: a change is sent when the reader's rule matches the event's
  document.
- **Identity: only a session proves someone.** `credential.actor` asks for `kind: "session"`: a key
  identity made before (`kind: "key"`, unscoped) proves nobody.
- **The client** (`connect`, from `copilotz` and `copilotz/web`): `client.db.collection(name)`
  (`find` with `.toArray()`, `findOne`, `countDocuments`, `insertOne`, `updateOne`, `replaceOne`,
  `deleteOne`, `query`, `watch(filter, options?, onChange)`), `client.call(action, input, { id })`,
  and `connect(url, { key, over: "socket" | "http", plugins?, fetch? })` for scripts, beside the
  page's `connect({ transport, ticket, plugins })`. The socket gains a call's own id.
- **Developer keys** are members of their space, with a scope. A key's actor is
  `{ kind: "person", id, key, scope }` (`within` is gone): `people` still lets it in and `inPerson`
  keeps it out. It's a member of its space (`key:<id>`), an editor when its scope calls or writes,
  else a viewer, never more than its person may be there, and reaches what both its membership and
  its person reach, with no org role (an admin's key reaches only its space). Its `scope` (exact
  names, no wildcards) is checked by the runtime (`inScope`) only where a call from outside comes
  in: calls, queries, Views rendered for it, direct reads and writes; a scoped actor emits nothing.
  Never inside a job: an Action it may call writes as usual. `api_key` records keep `scope` and
  `role`; their id is the start of the secret's hash (`hash` is private); they live in their space
  (`shared`), where its members see them in the Members tab and its managers revoke them.
  `api_key.actor` answers the actor; `api_key.revoke` (its person, or a manager) ends the key, its
  membership and its connections, and so does its person leaving the space or the org;
  `ctx.disconnect` of a key ends only its own. Spaces add `spaceMembers` (a section of the Members
  tab). A key's default space is gone: the runtime knows no spaces, and REST and the socket must
  behave the same.
- **Identity makes no keys:** `key.create`, `key.revoke` and `credential.keys` are gone, and a
  credential is a session. People and sessions change only through identity's Actions.
- **Many orgs, by forwarding** (see design/tenancy.md): the directory's routes forward `/o/<org>/…`
  to that org (404 for none, 403 when suspended), `/*` to the org the browser is in (a page asked
  for without a session there goes in first, to the org they were in, else their last, else their
  own, made now, then 302s back), and a host an org claimed to that org's host routes; anything else
  for someone signed in nowhere is the lobby's (without one, a 401). Entering an org (`POST /orgs`,
  `/orgs/enter`, `/orgs/invites/answer`, and a page's way in) is `org.enter`, then a signed handoff,
  a minute long and never out of the process, to the org's own `POST /enter`, which keeps who they
  are, joins them the first time, starts its session and sets its cookie (`s_<org>`). The
  directory's own: `GET /orgs`, `POST /signout` out of every org it holds a session for (each ended
  where its org is open; signing out never opens one), staff's `/console/orgs…` and
  `/console/codes…`, and the front's `/__copilotz/hosts/resolve` on any host. `directory.member`
  gives each org's runtime `resources.org` (id, name, kind, address), `page.base`, its cookies'
  names (`{ names: { session: "s_<org>" }, suffix: "_<org>" }`), the app's own hosts, the
  directory's hooks (invitations, leaving, renaming, claiming and releasing hosts, gift codes) and
  its `/enter`. The directory's session is still `__Host-dir` (the directory plugin's `cookies`
  resource), and which org a browser is in, `__Host-org`. `org.info` (a query, in place of the
  `org.get` Action) is kept 10 seconds, hosts' claims a minute, each forgotten at once when the
  directory changes it. The orgs host's tests are ported (`plugins/access/tests/orgs*.test.ts`).
- **Removed entry points and exports:** `copilotz/web/tickets` (`createTickets`) and `copilotz/orgs`
  (`orgsHost`). From `copilotz/web/server`: `webServer`, `WebServerOptions`, `socket`, `Entrance`,
  `SignIn`, `Arrived`, `Door`, `Whom`, `whomOf`, `cookieOf`, `hostCookie`, `setCookie`, `siteOf`,
  `ANONYMOUS` (write `{ kind: "anonymous", id: "" }`), `Front`, `hostOf`, `HttpRequest`,
  `HttpAnswer`, `httpRequest`, `Route` (now the runtime's, a function), `RouteSocket` and `Served`;
  `clientAddress`, `setClientAddress` and `hostMatches` moved to `copilotz`. From `copilotz/web`:
  the orgs' browser half (now `copilotz/plugins/access/web`). From `copilotz/web/node`: `serve`,
  `ServeOptions` and `Server`. From `copilotz/plugins/interfaces`: `serveApi`, `WebLine` and the
  other `*Line` types. The `entrances`, `signIn` and `routes` resources; `createRuntime`'s `admit`;
  the actor's `within`; `whatsapp.hook` and `voice.hook`.

- **Oxian 0.23.5:** the Node adapter keeps an error listener on each request and response for their
  whole life, so a client leaving mid-response (a server-sent stream it stops) never reaches the
  process as an unhandled error (it did under Bun).

## 1.0.0-rc.24 — 2026-11-06

**Upgrading from rc.23** (two breaking renames; no aliases, no data moves):

1. **Views are found by name alone; the medium is gone.** Flatten `views`:
   `{ "booking.panel": { web: BookingPanel } }` becomes `{ "booking.panel": BookingPanel }` (`Views`
   is `Record<string, View>`). `render(medium, name, item, options)` and
   `observe(medium, name, item, options)` lose their first argument:
   `ctx.render("llm", "thread", t)` is `ctx.render("llm.thread", t)`,
   `client.observe("web", "booking.panel", item)` is `client.observe("booking.panel", item)`.
   `ViewContext` loses `medium`, and its `kind` is now `name`. `ctx.show(name, item)` shows exactly
   the View it names: there is no inheritance by place. The `"*"` fallback is gone; the hosts ask
   for their own default (`web.default`, `terminal.default`) when a name has no View.
   `runtime.describe().views` is the list of names. `GET /api/views/<name>` takes the name
   (`llm.thread`) and no longer reads `?medium=`; API keys that list a View by `thread` or `message`
   list `llm.thread` or `llm.message`. An MCP widget's `_meta` names the View without a medium.
   Where the same thing is shown in several places the name takes the place as a prefix; seven kinds
   were renamed:
   | Was                       | Is                                                                                          |
   | ------------------------- | ------------------------------------------------------------------------------------------- |
   | `message`                 | `llm.message`, `web.message`, `terminal.message`, `whatsapp.message`, `voice.message`       |
   | `thread`                  | `llm.thread`, `web.thread`, `terminal.thread`                                               |
   | `memory`                  | `llm.memory`, `terminal.memory`                                                             |
   | `live`, `shell`, `spaces` | `web.live`, `web.shell`, `web.spaces`; `terminal.live`, `terminal.shell`, `terminal.spaces` |
   | `*`                       | `web.default`, `terminal.default`                                                           |

   Every other name stays (`tool:<name>`, `context:<name>`, `addition:<name>`, `mcp:offered`, and
   the rest). The last plugin to register a name still wins, so an app replaces WhatsApp's message
   with its own `whatsapp.message`. A page's address still names its View as before
   (`/thread/<id>`): the web shell looks for that name, then `web.<name>`, then `web.default` (hint
   `of` names the address's kind); the terminal's `open` does the same with `terminal.`.
2. **The anonymous actor is `anonymous`, not `visitor`:** a request nobody is signed in to is
   `{ kind: "anonymous", id: "" }` (`VISITOR` is `ANONYMOUS` in `copilotz/web/server`). Rules that
   named `visitor` name `anonymous` (identity's `callback` allows `person` or `anonymous`). The
   `visitor` entrance and its cookie keep their names. `runtime/actor.ts` now lists all six kinds
   (person, agent, contact, system, maintenance, anonymous); `routine` is an origin and `space` a
   kind of member, not actors.

- **Oxian 0.23.4:** its adapters await an asynchronous `prepare`, so a front serving several
  runtimes behind one listener can open the right one before deciding a socket upgrade.

## 1.0.0-rc.23 — 2026-11-05

**Upgrading from rc.22** (three renames and one host change; nothing else needs doing):

1. **`renderer` is `medium`:** rename `ctx.renderer` to `ctx.medium` in Views and in hand-made test
   contexts (`renderer: "web"` to `medium: "web"`). No alias.
2. **Web lines moved to the web interface:** add `webLines` beside `...access`
   (`plugins: [models, chat, ...access, webLines]`) and import `WebLine`, `WebLimits`, `WebSettings`
   and `WEB_LIMITS` from `copilotz/plugins/interfaces`. The `contactSend` hook's key is `web` (was
   `contacts`). No data moves.
3. **One web host:** `serveRoutes`, `routeHost` and `RouteListener` are gone, and so are `serve`'s
   `google` and `dev` options: declare sign-in with `googleSignIn` and `devSignIn` plugins instead.
   `serve` answers a `Server` (`close({ drain })`); `/connect` answers `{ ticket, actor, name? }`
   (`person` is gone).

- **Breaking: web lines are the web interface's, not contacts'.** `resources.web.lines`, arrival,
  the `visitor` entrance, the budget, the challenge, prune and the limits moved from
  `plugins/access/contacts` into `plugins/interfaces/web`, as one plugin, `webLines` (exported from
  `copilotz/plugins/interfaces`), as WhatsApp's, the phone's and MCP's lines are in theirs. The
  resource shape is the same (`web: { caller?, lines: { … } }`), and so are the Actions
  (`contact.arrive`, `contact.sending`, `contact.prune`, `contact.spent`, `contact.budget`) and
  collections (`contact_visitor`, `contact_rate`): nothing is renamed, so no data moves. Migrate by
  adding `webLines` beside `...access` (`plugins: [models, chat, ...access, webLines]`) and
  importing `WebLine`, `WebLimits`, `WebSettings` and `WEB_LIMITS` from
  `copilotz/plugins/interfaces` instead of `…/access`. Contacts keeps the contact, `contact.start`,
  `contact.chat` and `contact.forget`; erasing a visitor's contact now ends its cookie and its
  connections in a processor of `contact.deleted` (`web.forget`), a moment after the erasure, not in
  the same transaction. The `contactSend` hook's key is `web` (was `contacts`).
- **Breaking: `renderer` is `medium`.** The docs said "medium" and the API said `renderer`; now one
  word. A View's context field `ctx.renderer` is `ctx.medium`, and the wire/owner `render` job's
  `renderer` field is `medium`. Migrate by renaming `ctx.renderer` to `ctx.medium` (and a test's
  hand-made context `renderer: "web"` to `medium: "web"`); `render(medium, kind, item)` already took
  the medium by position. The medium names are unchanged (`llm`, `web`, `terminal`, `whatsapp`,
  `voice`). No alias.
- **One web host, its parts from the app's plugins.** `serve` (and `webServer` beneath it) is the
  host for every app: routes from `routes` resources, as before; the page and its code from `code`
  (none: no page, the routes and `/health`); who a browser is from a new `entrances` resource; how
  people sign in from a new `signIn` resource; browsers connecting with `tickets` (none: no browser
  connects). `serveRoutes`, `routeHost` and `RouteListener` are gone, and so are the host's `google`
  and `dev` options; `serve` answers a `Server`, whose `close({ drain })` stops listening and then
  closes the runtime.
  - **Entrances:** each is a cookie and the query that says who its secret is (`{ secret }` in, an
    actor out), asked in `order`; one may let a newcomer in on `POST /connect` (`arrive`, given the
    socket's address and the secret its cookie holds when that's no one yet), and end what it is on
    sign-out (`end`). The host keeps every cookie (httpOnly; `Secure` but over plain http to this
    machine or a LAN host, by the host the request is for as the app's front says it; `sameSite` lax
    or strict; `hostOnly`: `__Host-<name>` wherever it's Secure), clears one that's no one (forged,
    ended), and never takes a store's failure for no one. Identity declares the session (`session`,
    host-only, read by `credential.actor`, ended by `session.end`, which now takes `{ secret }` and
    is unrecorded: its secret was in the log). `/connect` answers `{ ticket, actor, name? }`
    (`person` is gone); `web()` connects as whoever it is (`start(client, actor)`), and
    `web({ arrive })` is what the page asks coming in, at the app's `base` (an org's, with many).
  - **Sign-in:** `POST /signin/<name>` for each way a plugin declares: an unrecorded Action (the
    host refuses to start with a recorded one), called as the system with the request's JSON,
    answering `{ person, session }`; `local` ones from this machine only: the socket's address (as
    the listener saw it, `clientAddress`) and the host must both be loopback, a request whose
    address nobody set is refused, and so is one carrying any header a proxy adds (`forwarded`,
    `via`, `x-forwarded-*`, `x-real-ip`, `cf-connecting-ip`…: a proxy on this machine that rewrites
    `Host` made every request this machine's). `devSignIn` refuses to start in an app whose `links`
    origin is public (a proxy that adds no header, as nginx's `proxy_pass` as it comes, can't be
    told from this machine). `googleSignIn` declares `google` (the page shows its button for the
    first client id); the new `devSignIn` plugin declares `dev` (by name or email, this machine
    only). The orgs host signs in with whatever its directory declares (`signIn: { at: directory }`
    for its orgs' pages). `describe()` marks unrecorded Actions (`record: false`).
  - **Visitors** (the contacts plugin's web lines, `resources.web.lines.<name>`: `in`, `agent`,
    `title`, `days`, `limits`, `files`, `transcribe`, `org`; `web.caller`, as MCP's; and the app's
    `links` secret, which visitors' cookies are signed with): a page asking to come in by a line
    (`{ line }`) that isn't anyone becomes a visitor, its browser keeping a signed secret in a
    `SameSite=Strict` cookie (`__Host-visitor` wherever it's Secure) that's the same visitor for
    `days` (30). Coming in makes and keeps nothing, in memory either: the visitor the server issues
    carries its line (`web`) and its networks' tags (`from`: HMACs, never the address), which its
    messages are counted by. Its first message (`chat.send`, naming no chat) makes its contact
    (`via: "web"`), its own chat in the line's space and its record (`contact_visitor`), through
    chat's new `contactSend` hook (`contact.sending`). Limits, each a plain 429 for that caller
    alone, by address held for each network it's in (`networksOf`: an IPv4 address and its /24, an
    IPv6 /64, its /56 and its /48, each as many callers' worth as it counts, `SCALE`: 8, 4 and 8):
    new visitors an hour from one address (`ipVisitorsPerHour`, 20), and as many first messages,
    counted by the address the app's front says, else the socket's (with neither, nobody's let in,
    said loudly; all from one private address, said once); a visitor's messages a minute and a day
    (`perMinute` 10, `perDay` 200), its address's (`ipPerMinute` 30, `ipPerDay` 1,000), the line's a
    minute (`linePerMinute` 300, of which newcomers, who hadn't spoken before the minute, send
    `newcomersPerMinute` 200: the rest is kept for conversations going on), and new visitors who
    speak an hour (`visitorsPerHour`, 600), each place taken in one conditional write, so messages
    at once can't pass a limit. A line's `budget`: what its visitors' turns may be charged a day
    (UTC), as the usage ledger prices them (`usage.quote`, through `modelUse`); past it, its
    visitors' messages wait for tomorrow. A line's `challenge`: an Action of the app's a newcomer
    passes first (a CAPTCHA's check, given what the page sent,
    `web({ arrive: { line, challenge }
    })`). Files only on a line that takes them
    (`files: { count, bytes }`, 1 of 5 MB unless said), each with a media type; audio transcribed
    only with `transcribe: true`. `contact.forget` ends a visitor's cookie and its browsers'
    connections at once (its record stays, ended, until its cookie's time is past), and so does
    removing its line. Every ten minutes (`contact.prune`) what's past goes: counters, records past
    their time, a contact made for a first message that never went in. A visitor fetches its own
    chat's files (`file.content` is open to contacts, under the rules), and finds its chats by its
    own memberships (`member` by its key, `contact:<id>`). Checked at start (a challenge that's no
    Action, a budget without the usage plugin).
  - **What a contact reads:** never an agent's private steps (each tool's input and output), a tool
    call being written, a step's words before it's known to be an answer, why a model's call broke
    (the provider's words), nor a tool's files. The access rules' `shared` resource takes `contact`,
    a filter a contact acting itself (never the agent working for it) reads and writes through:
    chat's messages without `private` or `toolCalls`; `live` without a tool call or a `retry`, and
    with words only of a turn that offers no tools (`open: true`, every step an answer; of one that
    does, a contact sees only that the agent is at work); files without a tool's (`private`, as
    OpenAPI's are now). A turn stopped mid-step keeps its words only when they were surely an
    answer. A contact's own reads from its browser name what of its own they read (its chat:
    `thread`, or `_id`, 32 at most, its read 2 KB of JSON at most: `CONTACT_READ`; of spaces and
    memberships, only its memberships by its key), else they're refused and never watched; it reads
    no `aggregate` or `nearest` directly. The voice relay reads its call as the line's agent working
    for the caller (only what both may read), and says what a web visitor reads: answers, never a
    step's words before its tools, and words as they're written only of a turn that offers no tools
    but those called beside an answer (a tool's new `aside: true`, as the voice plugin's `end_call`
    is): one with other tools says its answer once it's whole. A contact's message says 4,096
    characters at most (`CONTACT_TEXT`), never what sent it (`via`), and never titles its chat or
    lets an agent rename it (`title`, `renamable`); a file's media type is one (`MEDIA_TYPE`, 127
    characters at most, `MEDIA_TYPE_LENGTH`), which the agent is told. WhatsApp, voice and MCP
    contacts never held a browser connection: they read only through the app's own code.
  - **Security:** `/connect`, sign-in and sign-out (and the orgs host's own POSTs) answer only the
    app's own page: an `Origin` that isn't this host (as the front says it), over https off this
    machine and its LAN, or a cross-site `Sec-Fetch-Site`, is a 403, so another site can't make its
    visitors arrive here or sign anyone in. Bodies there are JSON objects of 16 KiB at most; route
    bodies are refused (413) as soon as `content-length` is over 10 MB, and read no further than
    that while streaming. What either host answers in JSON is `cache-control: no-store`, and what
    goes wrong says only its public words, with its code's status (500s are logged). So does a
    route's Action that refuses (`forbidden`, `invalid`, `not_found`, `unauthorized`: its status,
    and its words only when public). The caller's address parser (`callerFrom`, `callerProblem`,
    `CallerSettings`, and `countedOf` for a socket's) moved from MCP into the runtime, so MCP and
    web lines read callers one way. `mcp.call` refuses a contact without an MCP line (a web
    visitor), naming a line or not.
  - **Limits on browsers:** 30 tickets per actor a minute (`createTickets({ perMinute })`; past them
    `/connect` is a 429 with `retry-after`, and `issue` throws `too_many`), 16 browsers (worker ids)
    per actor, each on two connections at most (one coming while the last goes), 512 watched reads
    per connection (past them, `too_many`; those watched keep going), 16 resume credentials per
    actor (the oldest dropped), each working once, for the browser it was given to. A connection
    counts from the moment it's let in (Welcome) until it goes, ready or not, and one that doesn't
    say it's ready within 10 seconds is closed (the owner's Hypervisor `readyTimeoutMs`, for every
    worker: none starts anything before Ready). A contact far less: 2 browsers, 32 watched reads on
    each connection; and contacts together 16 connections from a network (as many times as it
    counts: by the tags of `actor.from`, `scaleOf`), 300 on a web line, 400 in all: well under what
    a listener holds (`LISTENER`, Oxian's Node adapter's 1,000), so people find room. Runtimes on
    one listener count their contacts together with one `contactsPool()`: the orgs host gives each
    org one (`open`'s `given.browsers`, for `createRuntime({ browsers })`). The limits are settings:
    `createRuntime({ browsers })` (`BrowserLimits`: `sockets`, `watches`, `resumes`, `contact`,
    `network`, `line`, `contacts`, `pool`), checked at start; people never count against contacts'.
    A contact's browser is told a failure's words only when they're for anyone (`public`), as MCP's
    callers are: never a provider's (a transcription's raw error said a key's prefix). Tickets and
    resumes expire on a timer (`runtime/expiring.ts`), never by looking through them all on each one
    issued.
  - **Cookie names, and a one-time sign-out:** every entrance's cookie is the host's alone unless it
    says `hostOnly: false`: identity's session is `__Host-session` wherever it's Secure, and the
    orgs host's own cookies (`dir`, `org`, `s_<org>`) and every org's entrances' are `__Host-` too,
    so no other host under the domain (a preview's page) can set one to make a browser someone it
    chose. The names change: every browser signed in before is signed out once, on upgrade, and what
    it held under the old plain name is ended where it lives and cleared (on `/connect` and on
    sign-out), so a version rolled back that reads the plain names finds no one there. Stripping
    `Domain` from a preview's Set-Cookie (as previews do) doesn't stop that by itself: a preview's
    page script can still set `document.cookie` with `Domain=<parent>`; the `__Host-` names are what
    stop it.
  - **Signing out, and erasing a contact, end their browsers** (`runtime.disconnect(actor)`, and
    `ctx.disconnect` from an Action): their resume credentials go and each connection closes. A
    browser comes back only with a new ticket: the client now asks for one when its way back is
    refused (it used to stop, until its page reloaded), which only a cookie that's still someone
    gets; another device of the same person comes straight back. A connection let in before (not yet
    ready) is never ready, and tickets handed out to them not yet used are no one's (`Tickets.end`,
    which sign-out calls). An org's own (`bound:`) executor can't end anyone's browsers; plugins are
    trusted code, as with `cancel`. With the orgs host, sign-out ends every open org's session the
    browser holds.
  - **Migration:** `serveRoutes({ runtime, … })` is `serve({ runtime, … })` with no `code`.
    `google: { clientId }` and `dev: true` are the plugins' resources now: add `googleSignIn` (with
    the `google` resource) and `devSignIn` to the runtime's plugins (the directory's, with orgs). A
    listener of the app's own (`Deno.serve`) says where each request came from
    (`setClientAddress(request, info.remoteAddr.hostname)`, from `copilotz/web/server`), and so do
    tests that sign in with dev sign-in through a hand-made `Request`
    (`setClientAddress(request, "127.0.0.1")`); `serve` and `listen` do it themselves. Web lines
    need the `links` resource. `whomOf(runtime, { cookie?, front? })` (was
    `whomOf(runtime,
    cookie?)`), and `setCookie` takes the request's site
    (`siteOf(request, front)`). An entrance whose cookie something else under the domain reads says
    `hostOnly: false`. A visitor's page finds its chat through its memberships (`member`
    `{ member: "contact:<id>" }`), not by reading every `thread`. An app that ran this branch
    before: visitors' cookies (their secret's format and key changed) and links signed before
    upgrading don't open; visitors are newcomers once.
- **The runtime, for the web host's limits** (from the second security review of the one host):
  - **The in-memory store reaches a document by its id at once.** A filter that keeps to ids (`_id`
    a string, `$eq` one, `$in` strings, also in a top-level `$and`) looks them up, rather than
    copying and scanning the whole collection on every read and write; other reads scan without a
    copy, and stop at a `limit` without a `sort`. The `durable: false` collections (`live`, the web
    lines' counters, billing's `room`) share that store and its one transaction queue, so their cost
    no longer grows with what they hold. Results come in the same order.
  - **Links are signed with a key of their own** (`keyOf(secret, use)`, HKDF-SHA256 of the `links`
    secret; web visitors' cookies use another), never the secret itself, and the `links` resource
    takes the one before it (`previous`), while what it signed should still open: a link until it
    expires, a visitor's cookie (the same contact) while it lasts. **Breaking:** links signed before
    upgrading (an hour's) no longer open. A secret that leaked is never given as `previous`: it goes
    at once.
  - **A rule hears a browser's own reads** (`Guard`'s `direct`, asked with the read's filter before
    it's watched) and may refuse one it won't watch, throwing. Plugins' `check` sees every Action
    (`merged.actions`). A contact reads its own memberships by its key (anyone else, memberships as
    far as they reach: a key `within` a space, that space's).
  - **An aggregate with its own `$match` works under a rule:** the rule's filter joins it in one
    `$match`; before, every such read failed `invalid`.
  - **Who calls, by network:** `networksOf(counted)` (an address's wider networks, each with its
    prefix and `scale`), `SCALE`, `scaleOf(tag)`, `privateAddress(address)`.
- **From the third security review of the one host:**
  - **A watched read is matched only against changes it could concern.** A read whose filter names
    values of a field of its own (a string, `$eq`, `$in` of up to 256 strings: a chat's `thread`, an
    `_id`) is filed under them; a change to a document holding none of them (before or after, in
    that field or an array there) skips it before any matching. The owner's read cache does the same
    for the queries it keeps. Results are exactly as before. New in the reference
    (`runtime/mongo.ts`): `namedBy(filter)`, `valuesAt(doc, field)`.
  - **A web line's budget holds, and fails closed.** Each visitor's message holds an estimate of its
    turn's cost as it goes in (the most one of the line's visitors' model calls cost lately; before
    any is known, the rest of the day's budget, so one turn goes at a time until a cost is),
    released as its first call is charged, or lapsing in two minutes: messages at once can't all
    pass a budget only one fits. Before each model call (and transcription) for a visitor, a spent
    budget refuses it, for good, so a turn's tool loop stops there: the models plugin's `modelUse`
    listeners may now refuse a call before it's made (`may`, its refusal `final`; `mayUse`,
    `ModelCall`). Use the ledger prices at nothing (no price for the model, or pricing failing)
    closes the line for the day, said in the log. New: `contact.budget`; `contact.spent` takes
    `contact`, and `unpriced`.
  - **Web visitors:** a secret dated more than 5 minutes ahead is nobody's. An erased visitor's
    record is kept as long as any cookie made before could last (400 days, the most a line may say,
    `MOST_DAYS`), so raising a line's `days` can't bring an erased visitor back.
  - **MCP's ids** (contacts, chats, users, addresses) are HMACs with the `mcp` key of the app's
    secret (`keyOf`), never the secret itself; with `links.previous`, a conversation made under the
    one before goes on as itself (the new system-only `mcp.conversation`; `mcp.call` takes the chat
    the route found, `thread`). **Breaking:** every MCP conversation from before is new once (no
    deployment uses the MCP interface yet).
- **MCP widgets: an app's web Views drawn inside ChatGPT and other MCP Apps hosts** (#165). A line's
  tool can name a web View (`mcp.lines.<name>.tools.<tool>.widget`); the web host serves one
  `ui://<line>/widget-<version>.html` template per line (`webServer({ widgets: widgetsOf(...) })`),
  and a result carries the View, a snapshot of what it reads, and a short-lived grant in `_meta`
  only, never in what the model reads. Widget-only tools (`visibility: ["app"]`, `action`) refuse
  calls without a grant for that conversation. The widget host is `copilotz/web/widget`
  (`widget({ plugins, root })`), speaking MCP Apps' postMessage bridge with ChatGPT's
  `window.openai` as fallback.
- **A tab comes back after a network flap.** A new connection on a worker id that already has two
  closes the oldest instead of being refused (a Welcome lost on the way no longer locks the tab
  out), and a client that was in once keeps re-enrolling, longer apart, when it's refused.
- **A model the app doesn't pay for is checked against a web line's budget too** (`paid`-tagged ones
  skipped `may`, so a visitor's tool loop could go on past a spent day).
- **A web line's budget loses no charge under load:** `charge` is one atomic write (`$inc` the
  spend, `$unset` the hold), and `hold` retries with jitter until a deadline instead of eight
  immediate tries (no more false "busy"). One call costing more than the whole budget no longer
  closes the line for 30 days: with nothing held, a message holds at most what's left.
- **Voice: a line's `waiting` phrase** (`voice.lines.<name>.waiting`, none by default) is spoken
  once when a turn starts running tools before any answer, so a caller doesn't hear silence. Never
  for an answer without tools, nor for `end_call`.

## 1.0.0-rc.22 — 2026-11-04

**A security release: upgrade now.** Before it, a Google sign-in wrote the new session's secret to
the event log, and connecting a computer wrote the computer's secret (the first entry below). After
upgrading, every deployment should:

1. **End every session made before the upgrade:** delete the `credential` documents of
   `kind: "session"`, so every signed-in person signs in again. Keys are unaffected.
2. **Scrub the old events that hold these secrets**, from the store and from anything that copied it
   (backups, exports, exporters): the `action.started` and `action.completed` events of
   `google.sign-in`, `computer.code`, `computer.enrollment` and `computer.work`, and the
   `action.started` events of `session.end`, `computer.admit`, `pool.admit` and `pool.serve`.
3. **Reconnect computers whose log may have been read:** forget each one (`computer.forget`) and
   connect it again with a new code. A computer's secret can't be rotated yet.

- **Security: a Google sign-in no longer writes the session's secret to the log.** `google.sign-in`
  was a recorded Action, so the event log kept its input, the Google ID token, and its result,
  `{ person, session }`, with the new session's secret in plain text. Anyone who could read the log
  (a database reader, a backup, an export, an exporter) could sign in as that person, staff
  included. The identity plugin keeps secrets only as hashes, and this Action undid that. It is now
  unrecorded (`record: false`), like `session.start`. So is `session.end`, whose input is the secret
  being ended. Found by a security review.
  - **Computers' secrets are kept out of the log too**, found by checking every Action for the same
    mistake. These are now unrecorded: `computer.admit`, whose input is a computer's secret (or the
    code connecting it) on every connect; `pool.admit`, whose input is a pool VM's identity token;
    `computer.code`, whose result is the code that connects a computer as its person; and
    `computer.work`, whose input and result are what a person types and sees in their shell, files'
    contents and the env values they pass. `computer.enrollment`'s result (`code`) and
    `pool.serve`'s `assign.code` and `assign.secret` (also when forwarded by `remotePool`) are
    private: still recorded, so a retried wake gets the same code, but the code isn't logged.
  - **Deployments should end every session made before this fix.** Delete the `credential` documents
    of `kind: "session"`, so every signed-in person signs in again. Keys are unaffected. A
    computer's secret can't be rotated yet: where the log may have been read, forget the computer
    (`computer.forget`) and connect it again with a new code.
  - **Old events still hold these secrets until they're scrubbed**, from the store and from anything
    that copied it: the `action.started` and `action.completed` events of `google.sign-in`,
    `computer.code`, `computer.enrollment` and `computer.work`, and the `action.started` events of
    `session.end`, `computer.admit`, `pool.admit` and `pool.serve`. Ended sessions, used codes and
    expired tokens prove nobody, but scrub them anyway.

- **MCP: a conversation whose first call an owner stopped no longer ends for good.** A new
  conversation's chat is made (`chat.open`) and then shared with its contact (`member.set`), two
  writes; an owner that stopped between them (a deploy, which doesn't wait for running calls, or a
  crash) left a chat its contact couldn't reach, which is how a contact its people took out of its
  chat looks, so every later call said "This conversation with the app is over". A new
  conversation's opening is now noted with its first call's counts (`mcp_opening`, durable, no
  events, gone with its receipts after 15 minutes) and dropped once the chat is shared: a chat out
  of its contact's reach, with its opening noted, goes on as new (asked again within 15 minutes, its
  contact not erased); without one, it stays over. Erasure's tombstones are read first, as before.
  This is what failed the MCP restart test on slower machines (macOS CI); the test now waits on what
  it watches for, not on fixed times, and a new one stops an owner at each of a first call's writes.
- **Contacts: a start cut short after a contact's record, before sharing it with the contact, is
  finished when it's started again** (`contact.start`, on WhatsApp, voice and MCP): the contact, and
  the agent working for it, read the record again. A known contact was returned as it was.
- **Maintenance SQL can run as the store's own role, told so:**
  `postgresStore({ url, schema, maintenance: { storeRole: true } })`, beside a role of its own
  (`maintenance: { url }`; both at once stop the store from opening, and neither still refuses raw
  SQL on a server, its message naming both). Anyone holding the maintenance key can then do whatever
  the store's role can: drop or truncate its tables, delete from the log, read every schema it
  reaches. Only the allowlist check is skipped; the statement filter, a connection of its own for
  each statement over the extended protocol, the timeouts, caps and `connections`, fenced writes in
  the owner with their `maintenance.sql` event, the rollback of what changes `meta` or makes a
  trigger, and the emptied cache all hold. Still refused, before each statement and after a write: a
  role that is or may become a superuser, a member of `pg_execute_server_program`,
  `pg_read_server_files` or `pg_write_server_files`, one with `CREATEROLE` before PostgreSQL 16, or
  one that may run the server's file functions (`pg_read_file`, `lo_import`, `lo_export`…). Cloud
  SQL's `postgres` user passes from PostgreSQL 16. An orgs host's orgs still don't get the plugin.

## 1.0.0-rc.21 — 2026-11-04

- **Security: a burst of calls no longer drops an executor's connection** (Oxian 0.23.3). About 35
  concurrent calls on one executor (around 20 holding transactions) filled Oxian's queues, and the
  connection was lost with every job in flight on it (`executor_lost`): a remote DoS on any app with
  a public entry point, flagged by a security review. Full queues now hold senders back instead.
  Long-lived workers also move to a fresh connection before one's streams run out, instead of
  failing calls with `capacity`; Copilotz treats the move as the same worker (#154).
- **MCP: models outside the app call its tools** (the new `mcp` interface; widgets come next). An
  app declares lines in `resources.mcp.lines.<name>`, each an MCP server at `POST /mcp/<name>`
  (`/o/<org>/mcp/<name>` under many orgs): the space its chats live in (`in`), the tools it offers
  (`tools`, by name: only these, never an agent's; each needs its `tool:<name>` View, else it isn't
  offered, and one whose `offer` says no to a contact isn't either), how each is shown (`title`,
  `annotations`, ChatGPT's `invoking`/`invoked` lines, 64 characters), who calls (`client`, the
  steps' sender), `title`, `version`, `instructions`, `handles`, `origins`, `org` and `limits`; and
  plugin-wide, how it knows a caller's address (`caller`) and calls at once in the process
  (`atOnce`, 8). Checked at start; it needs the `links` resource's secret.
  - **The protocol:** Streamable HTTP and JSON-RPC 2.0, written in the plugin, answered as JSON,
    with no session (GET and DELETE are 405; no `Mcp-Session-Id`). MCP 2026-07-28 (per-request
    `_meta`, `server/discover`, the `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and
    `Mcp-Param-*` headers checked against the body: -32020) and 2025-11-25, 2025-06-18 and
    2025-03-26 (`initialize`; batches only for 2025-03-26, 10 messages at most, one after another).
    Unknown versions are -32022 with the supported ones. Every tool says `noauth`, and all four of
    MCP's hints. A request with an `Origin` the line doesn't name is 403; input nested past 64
    levels, or holding a `$blob`, is -32602.
  - **Conversations:** ChatGPT's `_meta["openai/session"]` (with `openai/subject`) names one; a
    client that names none gets a `chat` handle (128 random bits, an optional input on every tool,
    said once, at the end of the first answer), or with `handles: false` is refused. Each is a
    contact (`via: "mcp"`) in a chat of its own in the line's space, its ids HMACs of the key with
    the `links` secret: no table. A handle the app never gave is refused; a chat whose contact its
    people took out, or that was erased (`contact.forget`, `chat.erase`: a tombstone, `mcp_closed`,
    no personal data), is over for good.
  - **A call** is `mcp.call`, called by the route as the conversation's contact (an actor only the
    route makes: `{ kind: "contact", id, mcp, client }`, which the Action's `allow` asks for). It
    runs the tool through chat's runner, writes a private step from the line's `client` in the chat
    (in its space as it is now; only input that fit the tool's schema, else a note of what was
    sent), and answers with the tool's View, read as the contact, never its output as it is. Only a
    public error (below) says its message. `ctx.callId` is the step's id (the call's,
    `mcp:<thread>:<hash of the request id>:<hash of tool and input>`, and when it began), the same
    however often a call cut short runs again; a new call has a new one. A tool that changes things
    keeps a receipt (`mcp_receipt`, durable, no events, gone after 15 minutes) by what it asks in
    its conversation (tool and input), whatever the request's id: the same call while it runs waits
    for that run; asked again, under any id, within two minutes of its end it's answered what it
    said (kept up to 8,000 characters), beginning with a line saying it wasn't done again (so a
    second, deliberate purchase isn't taken for done); begun and never done (stopped, an owner
    restarted, or failed by accident and told to try again), it runs again as the same step, with
    `retry` and the same `callId`. A public refusal is an answer, and is said again. A read-only
    tool always runs.
  - **Limits** (`limits`): calls at once in the runtime (`mcp.atOnce`, 4: each org's own under the
    orgs host), on the line (4: an executor's connection takes about that many tools that change
    things at once until Oxian's send backpressure is released), from one caller's address (2; a
    batch's every call counts) and in one conversation (2), past any of which it's 503 busy, -31000
    (a batch, an error for each of its requests; a batch with more tool calls than `addressAtOnce`
    is refused, -32600); how long the route waits for an answer (`timeout`, 20 s: then the model is
    told it's still working, as long as few calls are, `lateAtOnce` 2 on the line and
    `addressLateAtOnce` 1 from an address, else it's stopped) and a call may run (`stop`, 60 s: then
    it's stopped; tools should honour `ctx.signal`); a request's body (64 KiB), calls a minute by
    conversation (30), by caller's address (60) and on the line (600), new conversations an hour by
    user (30, ChatGPT's `openai/subject`), by address (20) and on the line (600), and an answer's
    length (100,000 characters). Only calls taken count, and a new conversation once it's made. The
    address is believed only as the app's front says it (`caller`: its header, with the front's
    secret, a request without which is refused, or the proxies' `hops`, which a list header such as
    `x-forwarded-for` needs); IPv6 is counted by its /64, IPv4 written as IPv6 as IPv4, and an
    address that can't be read with every other such call, as one. Ranges in `caller.exempt`
    (OpenAI's) aren't limited by address.
- **A failure can be public** (`failure(code, message, { public: true })`, `isPublic`): its message
  is for any caller, even a model outside the app over MCP, which no other error's words reach. It
  stays public from job to job. A code alone isn't public: libraries' errors have codes too.
- **Chat's tool runner is in its contract** (`runTool`, `toolText`): a tool's input checked, run,
  and its result read as agents read it, as a turn does; the turn uses them. Input that doesn't fit
  a tool's schema is a public failure, and the runner says so (`unchecked`). `Tool` gains `title`
  and `annotations` (`readOnly`, `destructive`, `idempotent`, `openWorld`).

- **Phone calls: the `voice` plugin** (in `copilotz/plugins/interfaces`), on Twilio's
  ConversationRelay. The app declares its lines (`resources.voice.lines.<name>`: `in`, `account`,
  `token`, `origin`, and optionally `agent`, `language`, `tts`, `voice`, `stt`, `texts`, `gap`,
  `trustCallerId`, `keys`, `limits`, `org`), each a Twilio number open to anyone who calls; their
  settings are checked at start.
  - **Twilio's webhook** is `POST /hooks/voice/<line>` (the `voice.hook` route): checked against
    `X-Twilio-Signature` with the line's auth token. A caller the line's managers blocked isn't
    taken (`voice.block { thread, days? }`, kept by the number's hash; `voice.unblock { block }`
    lifts it by its id, whatever is left of the call); then a call is taken within its caller's
    limits (`callerAtOnce` 1, `callerPerDay` 10; withheld numbers, together, their own
    `hiddenAtOnce` and `hiddenPerDay`, by default the line's `atOnce` and half its `perDay`), then
    the line's (`atOnce` 2, `perDay` 50 calls that went on in any 24 hours), or rejected as busy
    (`<Reject reason="busy"/>`: nothing is spent). A call taken gets TwiML that opens the line's
    socket (`<Connect><ConversationRelay>`, the line's language, greeting and voice) with a ticket
    good once, for a minute; `POST /hooks/voice/<line>/over` hears the relay end and hangs up.
  - **The socket** (`GET /hooks/voice/<line>/relay`, a `serve` route): its signature checked, its
    ticket used, then Twilio's `setup` must name the call the ticket was for. The caller is a
    contact (`via: "voice"`) in a chat of their own in the line's space, answered by the line's
    agent (a line whose agent doesn't answer there fails the call). A number isn't proof of who's
    calling: calling back goes on in the same contact and chat (until the line's `gap`, 12 hours,
    and never into a chat with another call on, checked in the write that puts the call live) only
    when Twilio verified the number (`StirVerstat` `TN-Validation-Passed-A`) or the line sets
    `trustCallerId`; otherwise, and for withheld numbers (Twilio's placeholders, `+266696687`,
    `+7378742833` and the like), each call is a new contact.
  - **What's said:** what the caller says goes to the agent at once, one prompt after the other; a
    prompt said while the answer to the one before is still being written stops that turn, and the
    next turn reads both (Twilio already waits for the caller to finish: a quiet window would add to
    every answer). What the agent writes is said as it writes it, word by word (a step's words
    before its tools, then its answer), through the `voice_call` View read as the caller, and only
    of the turns the caller's own words started: a staff member's turn in their chat isn't said.
    Speaking over it (`interrupt`) cuts what was being said, and the agent is told what was heard
    (the `voice` context). Keys pressed (with `keys`) come as a tap, `keys:<digits>`.
  - **What a call may cost** (`limits`): an answer that failed, or took longer than `turn` (25 s,
    then stopped), says the line's `failed` text, never the error; one past `said` characters
    (1,200) is cut at a word and stopped; `idle` (90 s) of silence, a call past `call` (600 s) or
    past `turns` prompts (30) says `bye` and ends it. The goodbye waits 15 seconds at most for
    what's being said; a call is over by its hard end (`call`, the goodbye and closing), and holds
    its place among the line's calls until then. A call that ends stops its turn, and any turn of it
    that starts just after. The agent ends a call too, once its goodbye is said (the `end_call`
    tool, offered to whoever answers a call while it goes on). Twilio's `end` says why
    (`handoffData`).
  - **The phone is a medium:** messages are said through their `message` View (renderer `voice`: the
    words without Markdown, a link's words, a web address's site), which an app may replace.
  - Each call is a small record (`voice_call`, no events: when, how long, why it ended, whether the
    number was verified; the caller's number private), and `voice_phone` keeps each verified
    caller's contact and chat. Erasing a contact erases its number from both; erasing a chat
    (`chat.erase`, `contact.forget` with `chats`) erases what the calls kept of it. Calls' records
    go after the plugin's `keep` days (30, at least 1: `voice.prune`, daily), once they're over: a
    call going on is never pruned. Agents working for a caller are told it's a phone call, and that
    the number isn't proof of who they are (the `contact` context).
  - It needs a host that takes a route's socket (`host.upgrade()`: `serveRoutes`, or `serve`, from
    `copilotz/web/node`).

- **Maintenance endpoints** (the new `maintenance` plugin, in `copilotz/plugins/interfaces`): HTTP
  under `/maintenance/` for an app's operators when they can't reach its database. A key (`key`, or
  several in `keys` to rotate one; 32 random characters at least, a weak one stops the app),
  compared in constant time; without one, every request is unauthorized. Requests act as the
  maintenance actor (`{ kind: "maintenance", by }`), whose Actions run as the system on the record,
  and each writes a line (`log`) before it runs. An orgs host's orgs don't get it.
  - `POST /maintenance/sql`: one read-only statement, with `params`, at most `limit` rows and
    `bytes`, cut off after `timeout`.
  - `POST /maintenance/collections/<collection>/<op>`: insertOne… deleteMany, find… aggregate,
    through the owner's write path: schema-checked, recorded, cached, heard by Processors.
  - `POST /maintenance/queries/<collection>.<name>`: a collection's named query, the body its
    params, read as the system.
  - `POST /maintenance/sql/write`: one statement that writes, run by the owner alone among its
    writes, fenced by its epoch, with a `maintenance.sql` audit event in the same commit; then the
    owner empties its read cache, runs observed Views again and re-reads its timers. A statement
    that changes `meta` (the epoch, Processors' positions) is rolled back. An `Idempotency-Key`
    makes it safe to send again.
  - `GET /maintenance/blobs/<id>`: a blob's bytes, as a download.
- **SQL on the store port, for maintenance only:**
  `Store.inspect?(sql, params?, { limit, timeout })` (now SQLite's too), a transaction's
  `execute?(sql, params?)` and `transaction(…, { maintenance })`. Both run exactly one statement: a
  second, or one that ends the transaction or changes the connection (`COMMIT`, `SET`…), is refused
  (PostgreSQL ran every statement of an unparameterized `inspect` before; PostgreSQL's line comments
  end at a CR too). `runtime.maintenance` is the owner's way to them; plugin code has none. The
  cache gains `clear()`, observers `stale()`.
  - **PostgreSQL servers:** raw SQL runs only as a role of its own
    (`postgresStore({ maintenance: { url, connections } })`), which must hold exactly maintenance's
    grants: no attribute but LOGIN, membership in no role (but Cloud SQL's IAM marker, itself held
    to the same), no settings of its own, nothing owned (a large object neither), nothing granted
    outside the store's schema, `CREATE` nowhere, no large object, table or column of another's to
    read, nothing on the store's tables beyond what it needs, no `SECURITY DEFINER` function to run,
    no `dblink` or `postgres_fdw`, no trigger on the store's tables: checked before each statement
    and again after a write, in its transaction, reading only `pg_catalog`'s names. `ALTER ROLE`,
    `DO` and `LOCK` don't run; a password literal is kept as `PASSWORD '***'`. Each statement on a
    connection of its own, over the extended protocol, closed after; at most 2 at once, else `busy`.
    A read stops fetching before a row would pass its bytes. PGlite runs it as its one session, and
    discards what it left there.
  - **SQLite:** the store names its tables in `main`, so a temporary object can't stand in for them
    (a write that leaves one, or a trigger, is rolled back); a read runs in a process of its own
    (`deno`, `node` or `bun` itself, never a compiled app; an empty environment; on Deno and Node,
    read access to the database's files alone), killed at its timeout. Else, on the reading
    connection, a pragma only from those that only read, said once and on each answer
    (`inline: true`).

- **Security: a forged blob reference is refused, never loaded.** Large strings are kept as blobs
  and documents hold `{ $blob, size, type }` in their place; the owner loaded any object with a
  string `$blob` on every read. So an Action that stores what it's given (a tool's input, a
  webhook's body) could plant one: an id no blob has made every read of that document fail (a chat
  that can't be read or erased, Processors giving up on its events); another document's hash pulled
  that content in; and a path or a name read a file (`fileBlobs`) or any object in the bucket
  (`gcsBlobs` without a prefix).
  - What plugin code writes (documents, updates, upserts' filters, edges, events, records, timers'
    inputs, Action results) and what an Action is called with may hold no `$blob` key: `invalid`.
    The owner checks it as it walks what it offloads, so it costs no extra pass.
  - No part of an update's field path may start with `$` (as MongoDB refuses) or be `__proto__`
    (`invalid`): `{ $set: { "bio.$blob": … } }` made a reference out of plain strings, and on Node
    and Bun `{ $set: { "__proto__.x": … } }` set `x` on every object's prototype (Deno has no
    `__proto__`). `constructor` and `prototype` are fields like any other: paths read and make a
    document's own fields only, so a filter on `constructor` no longer finds `Object` in every
    document.
  - A path ends at a blob reference as it does at a string, so a large string is treated like a
    small one (`$set: { "text.note": 1 }` replaced the reference's insides, losing the text), and at
    any other object with a `$blob` key, so no update turns a planted one into a reference.
  - An aggregate's `$group` can't name a field `$…` either: `_id: { $blob: …, size, type }` built a
    reference from strings, which a browser's own read then loaded.
  - The API's event stream sends a call's result whole; one over 16 KiB went as its reference.
    Published events (`runtime.subscribe`) have `full()`: the event with its large values.
  - Only an exact reference loads a blob: the keys `$blob`, `size` and `type`, a `sha256-<64 hex>`
    id, a numeric size and a string type. Any other object is data.
  - Every blob store (memory, SQLite, PostgreSQL, `fileBlobs`, `httpBlobs`, `gcsBlobs`) takes only a
    blob's id (`checkBlobId`, exported for your own `Blobs`).
  - Fixed on the way: a timer's input over 16 KiB reached its Action as a reference; it comes whole.
    An occurrence of one that a deploy to this version cuts short fails once when it resumes
    (`id_conflict`: it started with the reference as its input); the timer's next ones run.
  - A store may already hold planted references: an exact one still loads (its blob gone, reads
    fail), and any other, carried on, is now refused. #155 has read-only queries (PostgreSQL,
    SQLite) that find them; clean every one, `sys.timers` first.

- **Contacts: people outside the org who talk to its agents** (the new `contacts` plugin, part of
  `access`). A WhatsApp customer is a contact, its own kind of actor (`{ kind: "contact", id }`),
  never a person: every `allow: people` Action and query stays shut to it, and nothing that asks for
  a person (`personOf`) finds one. The runtime's `principalOf` says whom work is for, a person or a
  contact (it moved there from chat), and `peopleOrContacts` is what an Action opened to contacts
  allows: today only `chat.send`, whose message is then from `contact:<id>`.
  - A contact's chat is shared with it on its own (a membership `on` the thread, made by
    `contact.chat`): it reaches that chat, what's said and filed there, and its own record, nothing
    else. The space's people reach it as any chat there; the agent working for the contact reaches
    exactly that chat. Three generic completions in spaces make it so, and help people too (a person
    can now share one chat): a shared collection's documents can be part of another's (`part`: a
    message's `thread`), reached with it; an agent working for someone reaches a document one of
    them reaches on its own in a space the other reaches; and `present(ctx, space)` says whether
    someone reaches a space or a document in it, so `space.roster` tells a contact in its chat who
    answers (agents only).
  - A contact is let into documents only, never a whole space (`member.set`, a request granted), and
    never manages one. `request_access` isn't offered to agents working for a contact, nor memory: a
    customer's chat keeps to itself.
  - `contact.start` (trusted code, idempotent by id) and `contact.chat`; `contactOf(actor)` says
    whose work an event's actor's is (the contact's id, through the agent working for them too);
    agents are told whom they talk with (the `contact` context) and see them by name: the `names`
    resource is now a map of sources
    (`{ people: { collection: "profile" }, contact: { collection: "contact", prefix:
    "contact:" } }`),
    replacing `{ collection }`. On the web, add `contactsWeb` to show contacts by name.
- **A WhatsApp number can be a customer line.** Its space's managers open it to anyone
  (`whatsapp.set { number, open, agent, gap }`). A stranger who writes is then a contact, in a chat
  of their own in the number's space, answered by the number's agent (or who answers new chats
  there); a chat quiet for `gap` hours (12 by default) is over, and their next message starts a new
  one. Their text always goes to the agent (commands stay linked people's); a code from the app
  still links a phone, and linked phones keep working as their person. The `whatsapp` plugin now
  requires `contacts`.
- **WhatsApp is a medium.** A View for it (renderer `whatsapp`) returns parts, each one WhatsApp
  message, built with the toolkit in WhatsApp's contract (`text`, `buttons`, `list`, `carousel`,
  `image`, `document`, and `clip` for titles), which checks Meta's limits and throws `invalid`
  instead of cutting anything short. A message goes out as its `message` View there (the plugin's:
  its text as WhatsApp formats it; an app's replaces it).
  - **Additions:** chat declares the `additions` resource kind (`{ order?, agents? }`, each an
    `addition:<name>` View in the medium, given `{ thread, answer }`, returning `Addition`s:
    `{ key, parts, fallback?, note? }`). After an agent's final answer that didn't fail
    (`isAnswer`), each goes once per chat per key, recorded in chat's new `shown` ledger through
    `chat.shown` (trusted code, unrecorded); its `note` is told to the model after that answer
    (`[then shown: …]`).
  - **One message, not two:** an answer's last text goes as the first addition's body (or caption)
    when there's room, as Meta charges per message. A part Meta refuses (a 400 that isn't the token
    or the 24-hour window) sends the addition's fallback instead, with the answer joined to it;
    without one, it's logged. A retried delivery sends only what didn't go (`whatsapp_sent` now
    keeps each part by id, with its addition's `key` and `thread`).
  - **Taps:** a button's, a list row's, a carousel card's or a template's reply comes as its title
    with `tap: { id, title, key }` (`chat.send` takes `tap`; messages keep it), answering the
    message it was on; agents read `Carla: PIX [tapped: pay:pix]`. Typing the title is just text. A
    tap is a choice, not a permission: anyone can send any id, so a tool acting on one checks it
    against what was shown there. A quote or a tap answers only what went out in its own chat.
  - What a message and its additions show is read as whom they go to, never with the reach of
    whoever's work the answer was.
  - **"Typing…" while agents work:** each step an agent takes in a WhatsApp chat shows it again once
    WhatsApp may have hidden it (after 20 s, for up to five minutes); nothing says "please wait".
  - **Media:** a part's picture or file is a public https link (as given), one of the app's routes
    (`{ route, params }`: a link signed for a day with its params, which the route checks with
    `verifyLink`), or a chat's file (`{ file }`: a signed link to `/files/<id>`, or, without the
    app's `links`, uploaded to Meta and sent by its id). A carousel's pictures must be links: a file
    with nowhere to link it sends the fallback. A message's files go as images (jpeg, png up to 5
    MB) or documents, a short text as the first one's caption.
- **WhatsApp lines for an app, as it uses them**:
  - **A line the app declares** in its settings (`resources.whatsapp.lines.<name>`: the space,
    Meta's number id, token and app secret, its own verify token, a webhook path it routes to
    `whatsapp.hook`, its agent, gap, rate, quiet window and language): open to anyone, kept as the
    settings say at every use, with no person connecting or opening it; people can't change it
    (`whatsapp.set`, `whatsapp.credentials` and `whatsapp.disconnect` refuse), and the web tab
    leaves it alone. `whatsapp.set` stays for numbers people connect.
  - **Spaces the app declares** (the spaces plugin's `spaces` resource, by id: `{ name, agents }`):
    the app's own, owned by no person, made and kept by the system when something needs them
    (`space.keep`, trusted code; a declared line keeps the space it's `in`). Its agents are editors
    there, the first answering its new chats; people neither take them out, nor change their role,
    nor rename the space. Otherwise it's a space like any other.
  - **The reply is the body:** after an answer, an addition's own words (a question its buttons ask)
    are what it says without one; with the answer, the answer is its whole body. A fallback keeps
    its words after the answer.
  - **What Meta took but couldn't deliver** (a failed status on the webhook, such as a picture it
    couldn't fetch: `whatsapp.undelivered`) sends that addition's fallback, once, with the answer's
    text when it went in the same message.
  - **A burst gets one answer:** a customer's messages wait for the line's quiet window (`quiet`, 4
    s by default, up to 30) before the agent answers, all of them in one turn and one reply
    (`chat.send`'s new `quiet`: a durable timer each message sets again, `chat.quiet`, so a restart
    in the window still answers once).
  - **A failed turn** tells a customer only that, in their line's language, never its error.
  - Each sender's quiet window is their own (`quiet:<thread>:<sender>:<agent>`): a staff member's
    message never takes a customer's place, nor the reverse. Erasing a chat ends its windows, and a
    window whose message is gone (or no longer theirs to read) starts no turn.
  - A declared line is one org's with the orgs host: it names the org (`org`), and every other org's
    runtime has nothing of it; a line naming none is a single-org app's.
  - What Meta couldn't deliver is rendered again as its addressee, as any reply is.
- **Signed links** (the runtime's `signLink` and `verifyLink`, with the app's `links` resource:
  `{ origin, secret }`, a secret of at least 32 bytes, checked at start): the app's origin, a path,
  its params and an expiry (an hour unless said), HMAC-signed, with a line break between origin and
  path, so a link for one app or org never opens another (under `hosts/orgs`, give each org its own
  origin). The web host checks the secret as it starts serving. A chat's file is linked or uploaded
  only for someone who may read it. The web host serves a file at a signed `/files/<id>` link
  without a session, as the system; expired or altered, a 404.
- **Chat in spaces declares its own `shared` entries** (`thread`, `message` with labels, `file`,
  `live` and `shown`, each a part of its thread). `chat.open` opens an empty chat in a space;
  `chat.say { id, thread, from, text, to? }` has an agent say a fixed message in a chat without a
  turn (trusted code only; the same `id` is said once), sent out like any of its answers.
- **What a contact's chat shows stays theirs to see** (from a security review):
  - A document others are parts of (a chat) labels as itself, and so do its parts: a write into a
    chat shared with someone outside its space (a contact) that drew on anything else, even the same
    space, carries that space as its source (staff read it; the contact doesn't), or an agent
    writing it is refused (`needs_share`). WhatsApp sends only what its addressee may read.
  - Agents are told who else is in a chat from outside the org (the `where` context), from a chat's
    members on its own, which its space's people now read by asking for that chat.
  - A part of a shared document, and a document shared on its own, are reached only where it lives:
    nothing written as one lands in another space. `may`, `must` and `present` never take a document
    shared on its own for a space (`may(ctx, verb, id, on)` asks about the document).
  - A contact's message goes to whom its chat is with (or the agent that wrote what it replies to):
    never to agents it names. Anyone's `replyTo` is kept only for a message of the same chat that
    they read.
  - A tool whose `offer` is a function decides for agents that name it too; `request_access` refuses
    for a contact; computers aren't woken (or billed) for work that's no person's; memory declares
    its own `shared` entry; the identity guard keeps people's records to people.
  - `chat.say`'s message is `<thread>:say:<id>`, said only by an agent answering in that chat.
  - Work handed to another space from a chat shared with a contact comes back labelled with that
    space (`sources`): the contact doesn't read it (spaces' contract: `sharedWith`).
  - The `shared` resource's entries are its own keys: a collection named like what objects inherit
    (`constructor`) is none.
- **Erasure:** `contact.forget { contact, chats? }` (managers of its space) ends a contact's access
  at once, deletes its record (`contact.deleted`: WhatsApp erases its phone, but a block on it
  stays, by the phone's hash) and, with `chats`, its chats, each for someone who manages that chat's
  space (chat's new `chat.erase`, trusted code only: messages, files, waits, steps in flight; the
  history plugin erases its summaries on `thread.deleted`). The event log keeps what happened (what
  WhatsApp delivered, each change with its document) until retention removes it; memories learned in
  staff's chats, and chats a hand-over opened elsewhere, aren't erased.
- **An open line, kept in hand:** `whatsapp.block { thread, blocked }` (managers) blocks the phone
  behind a chat: what it sends goes nowhere, unanswered. A customer sending more than the number's
  `rate` a minute (20) goes unanswered. One taken out of their chat is heard again once it's been
  quiet for the gap. Customers are told what can't go on in the number's `language` (`en`, `pt`),
  never in an error's own words.
- **Fixed:** `message.questions`, and the terminal's `shell.mine`, `shell.set` and `shell.print`,
  let anyone whose id matched in; they're a person's own now.

- **Private fields for recorded Actions.** `private: ["buyer", "passengers"]` on an Action (dot
  paths, as a collection's): its calls are recorded without them, in `action.started`'s input and
  `action.completed`'s result alike, so the personal data a booking's buyer gives (names, CPFs,
  emails) never lands in the log, while the calls are still recorded, retried and deduplicated.
  - The call's `inputHash`, and so a nested call's id, still covers the whole input: a retry with
    the same input answers from the log, and a changed one is a new call (under an outside call id,
    `id_conflict`).
  - A result that had private fields is kept whole in `sys.results` (a document by call id, written
    in the completion's commit, no events), and `action.completed` says `private: true`: a retry
    answers with all of it, as it would without them.

- **A host without the web app: `serveRoutes`** (`copilotz/web/node`), for an app people use on
  WhatsApp or on the phone. Given the runtime, it serves the app's routes alone (webhooks),
  `/health` (unless a route takes it), and 404 for anything else: no page, no code, no sign-in; a
  route's Action is called as a visitor. Its `close({ drain })` stops listening, letting running
  requests finish, then closes the runtime with those options. A runtime that declares the `socket`
  transport still takes its sockets at `/oxian`. `routeHost(runtime)` (`copilotz/web/server`) is the
  same as a fetch handler. On Node, Deno and Bun (`examples/web-node/routes.ts`).
- **A route can take a WebSocket** (a voice call's relay): a `serve` route calls `host.upgrade()`,
  and answers with the response it gives; its `socket` is a browser's `WebSocket` as far as
  `onmessage`, `send` and `close` go. It can refuse first, before any handshake. `serveRoutes` and
  the web host's `serve` take it, through Oxian's adapter (route sockets, Oxian 0.23).

- **A tool call runs once, even when its turn is tried again.** A step that failed after its tools
  ran (a tool's `llm` View throwing, a commit failing) was run again whole: its model asked again,
  its tools run again, with whatever input the model now chose, and the model never saw the first
  run. Now a step's calls are written before any of them runs (chat's new `intent` collection, one
  document per running turn, no events), and what each returns as soon as it does. A retried turn
  goes on with those calls without asking its model: a call that returned answers from its record,
  and one cut short (its executor lost, the runtime closed) runs again as itself.
  - Tools get `ctx.callId`, the same however many times the call runs (`<turn>:<step>:<n>`): the
    idempotency key for what they do outside. `ctx.retry` is now true only for a call that may have
    run before. The recorded Actions a tool calls answer from the log when it runs again.
  - A turn that ends without its step (failed for good, or stopped mid-tool) keeps the step, with
    what each call returned, or that it never did ("Interrupted before it returned: it may or may
    not have taken effect…"); a stopped answer no longer repeats that step's text.
  - A tool step costs one more commit (its calls, before they run) and one per tool call (what it
    returned). A step that only sends messages costs nothing more: they commit with it.
- **Closing drops no turn.** `runtime.close()` returned from a delivery it cut short as if it were
  done, then saved its Processor's cursor past it, so a turn running at a deploy never answered. Now
  closing starts no more deliveries or timer occurrences, gives the running ones `drain` ms to
  finish (`close({ drain })`, 5 s by default), and keeps each cursor before an event it didn't
  finish: the next owner delivers it again, with `retry`, and with the above it doesn't repeat its
  tools. Workers are told they're gone after the drain, so running work can still use them. The orgs
  host's `close({ drain })` passes it on to every org's runtime.

- **Fixed: messages in a row ended an agent's prompt with its own answer.** A person writing several
  messages a few seconds apart starts a turn for each; one that ran after the agent had answered
  (while it wrote, or with the next turn) was sent a conversation ending with that answer, which
  Anthropic's newer models refuse ("assistant message prefill", HTTP 400), so it failed. Now an
  answer keeps how far its turn had read its thread (`knew`, the `at` of the newest message there);
  the prompt reads what others said after that, while it wrote, after the answer; and the turn of a
  person's message that an answer to them had already read ends without a model call. Adapters never
  send a conversation ending with the model's own message: a user turn ("Continue.") follows it, for
  every provider alike.
- **Fixed: a failed turn's answer said what its provider said.** "booking failed: Anthropic 400:
  {…}" was written in the chat, where everyone there read it (and a WhatsApp customer got it). It
  now says "booking failed: something went wrong, so it couldn't answer. Try again in a moment."
  What went wrong stays in the `processor.failed` event; a missing key still says who can add one.
- **Fixed: MiniMax's usage counted no input.** Anthropic's adapter read input and cache counts only
  from `message_start`; MiniMax (on Anthropic's protocol) says them in `message_delta`, so its calls
  were recorded with 0 input tokens. It now reads every count from both, the greatest of each (they
  are totals so far), so Anthropic's, said in both, count once.
- **OpenAI keeps nothing: `store: false`.** The Responses API stores every response (30 days) unless
  told not to, and Copilotz never read them back: a model's reasoning already comes back encrypted
  and goes back with each call. A server that refuses `store` is asked again without it, from then
  on, as one refusing `include` is. A model's `options` can still set it.

- **Fixed: a collection's private fields reached the log on PostgreSQL.** Writes that go as the
  store's single command (most of them) recorded `.created`, `.updated` and `.deleted` with the
  whole document, so `private` fields (a computer's `pending` secret, unsealed account tokens) were
  in the log there; memory and SQLite left them out. The command now records documents without them
  too. Events already written still hold them.

## 1.0.0-rc.20 — 2026-11-04

- **A model thinking past two minutes isn't a dropped call.** A call counted as dropped once its
  adapter yielded nothing for `silence` (2 minutes), and was retried or handed to the next model. A
  reasoning model yields nothing while it thinks, though its provider's stream goes on (GPT-6 Luna
  at xhigh on a hard problem: 108 s before its first word), so its thinking was thrown away past two
  minutes while the page showed the agent thinking. Adapters now say a stream is alive (`thinking`
  chunks, at most about once a second, for every provider); `generate` passes them on without
  counting them as written, so a model that thinks and then truly stalls still hands over.
  `complete` no longer reads a chunk it doesn't know as usage.
- **`terminal`: a running command is seen again by its `commandId` alone.** rc.19 said so, but sent
  the computer no input with it, and every look at a slow command answered "stdin is required". A
  `commandId` beside a blank `command` is a look too; beside a real one, the refusal says how to
  look, type into it or stop it.
- **An agent's OK shows once its own turn is over.** With agents answering in parallel, the
  computer's approval cards waited for every agent's turn to end, so one that asked and finished
  waited on a card that didn't show. Chat's `conversation` Views get `busy` (the agents whose turns
  run, each held 600 ms after its last step) beside `working`.
- **People show by name on the web.** The browser loads only front ends, and the `names` resource
  was declared only by the spaces plugin: everyone signed in with a sign-in id (`google:…`) showed
  as "someone", in Members, a chat's people and messages, memories, computers and routines. The
  spaces front end declares it too.
- **People's pictures beside their names**, in a space's Members, a chat's "In this chat" and a
  person's messages: a `profile.pictures` query (`{ ids }`), and `picturesIn` for Views.
- **`openai-compatible` sends a model's thinking back.** `reasoning_content` (DeepSeek, Moonshot,
  Qwen, vLLM) is kept as the answer's state and goes back with it, as Anthropic's, Gemini's and
  OpenAI's already did; DeepSeek asks for it once tools are given.
- **OpenAPI tools** (`openapi({ name, spec })`, in `copilotz/plugins/agents`): an API's operations
  as recorded Actions (`<name>.<operationId>`, not called again when a turn is retried) and agent
  tools (`<name>_<operationId>`); settings per deployment in `resources.openapi.<name>` (base URL,
  headers, query, timeouts, size limits, file fields).
- **History by age:** an agent's `history: { maxAge }` (ms) leaves older messages out of its prompt
  (they stay in the chat), counted back from the newest message it sees, its start on a grid of a
  tenth of `maxAge` so the prompt cache holds between steps.
- **Blobs in Google Cloud Storage:** `gcsBlobs({ bucket, prefix? })` (`copilotz/blobs/gcs`), signed
  in as the process's service account on Cloud Run or Compute Engine.

## 1.0.0-rc.19 — 2026-11-03

- **`terminal` takes the command in `command`.** It took it in `stdin`, while `start_job` takes
  `command`, and the tool answered any other field with an empty success: a model that sent
  `command` (gpt-6-luna in 21 of 22 calls in our tests, Claude Haiku 5.5 in 7 of 35) was told it ran
  when nothing had. Now `command` runs a command; `commandId` with `stdin` answers a running one,
  and with `operation: "interrupt"` stops it. A call it can't read (another field, both a command
  and a commandId, an empty command, `stdin` without a commandId) runs nothing and says what to give
  instead. The computer program is unchanged. A chat shows the command from `command`, and from
  `stdin` on calls made before.

## 1.0.0-rc.18 — 2026-11-03

- **Model tiers for the app's agents** (the new `tiers` plugin, in `copilotz/plugins/agents`). An
  app declares its tiers (`tiers` resource: a title, what it's good for, and a model for each of its
  agents, as an agent's `model` takes one). Which one an agent thinks with, first that applies: a
  model picked for it in the space, the space's tier, a model picked for it by the org, the org's
  tier, the tier the org's plan names (`planTier`), else its own model.
  - An org's owners and admins choose for the org, a space's managers for the space (`tiers.choose`,
    `tiers.pick`); everyone who reaches them sees it (`modelChoice.offered`, `modelChoice.agent`).
    Choices keep the tier's name, so retuning a tier moves everyone on it.
  - A pick keeps the tier's list behind it as fallback, and carries the `maxTokens` of the entry it
    replaces, and its `effort` when the picked model takes it (`models.efforts`, from the catalog).
  - Chat asks through a new `agentModel` resource, once per run, for the app's agents only; agents
    people make keep their own model. A turn's usage now says its `space`.
  - On the web (`tiersWeb`): "Agents' models" in org settings (the tiers with a typical reply's
    price, choosing one with Undo, a model per agent), and on a space's Members tab its tier and
    each app agent's model with where it comes from. Team's model picker is a View (`model.pick`)
    other plugins show.
- **Plans say whom they're for and which tier they give.** `PlanTerms.for` (`"personal"` or
  `"team"`) is enforced on every move to a plan (checkout, staff, a provider's webhook);
  `PlanTerms.models` names the plan's tier (`billing.tier`). The Billing page offers an org only the
  plans for its kind that its seller can sell (`billing.sellable`), says how much of this period's
  plan credits is left and when they lapse, and speaks of seats only to teams.
- **The Usage page, rebuilt around money.** One line: spent this billing month, against the budget,
  what's left and how long it lasts at this pace. One "By" switch (kind, space, person, agent,
  model) drives a stacked daily chart and a ranked list; a row filters the page. Activity shows
  turns, computer sessions, app days and conversation upkeep instead of ledger records; staff see
  cost and margin in place.
  - `usage.calls` is gone: `usage.activity` replaces it. `usage.org` groups and filters by
    `category` (agents, computers, apps; `usage.categories`) and by `tags.space`, and names what it
    groups by as the caller reads them, through a new `usageNames` resource kind each owning plugin
    contributes (spaces, conversations, computers, apps).
  - Cloud computers' records say their `space` and, for VM time, their `session`; summaries, memory
    notes and their embeddings say their conversation's `thread` and `space`.
  - Rollups keep `tags.space`. A closed day remembers its shape; days closed with an older one are
    read from records until `usage.close` closes them again (the next nightly close, or by hand).
- **An app's own instructions are sent as instructions.** A `context` entry with
  `instructions: true` (`system` only) goes right after the agent's instructions, without the
  `<context>` tag that marks other contexts as information, not instructions.

## 1.0.0-rc.17 — 2026-11-03

- **A model's state goes back with its answers.** What a model returns to be sent back (Anthropic's
  signed thinking, Gemini's thought signatures) was kept on tool steps but dropped on the final
  answer, so the next turn started without it. Answers keep it now, and agents are sent it on
  text-only messages too. A message's `state` is private, like `told`: people's reads and events go
  without it, and an answer handed back to another space doesn't carry it.
- **OpenAI's reasoning goes back to it.** The Responses adapter asks for a reasoning model's
  reasoning, encrypted (`include: ["reasoning.encrypted_content"]`), keeps it as its answer's state,
  in its place among the answer's text and calls, without ids, and sends it back. Between tool steps
  the model carries on instead of thinking again: on gpt-6.1-sol, a two-turn tool task wrote 42%
  fewer output tokens. A server that refuses `include` is asked again without it, and not asked
  again. Sent back, past reasoning stays in later prompts (a probe: 616 input tokens with it, 48
  without), so a state now says about what it adds (`LlmState.tokens`), and history counts it.
- **History counts what a prompt really carries.** The history plugin's tail is measured in
  estimated tokens of what an agent is sent for each message: its text, its model's state, text
  files' content, transcripts, images (1,600 each) and PDFs (2,000 a page), and agents' tool steps,
  which leave the tail without a line. `tail` is in tokens now (was bytes), and its default stays
  `[16_000, 48_000]`, so a text-only conversation keeps about four times more whole.
  - Until the tail first cuts, every message is sent: no 50-message cut before anything is
    summarized. That holds for threads whose outline began with them; older ones get chat's window
    until their first cut.
  - The four newest shared messages always stay whole, so a big file stays while it's talked about.
  - A message's line names its files, and `zoom(id, 1)` gives the message as the agent is sent it,
    text files' content included.
  - After a cut, state from before it (thinking bound to how the conversation began) isn't sent
    again; and when a provider refuses a model's own state as stale anyway, the call is tried once
    more without any.
  - Outlines no longer log events.
- **Without the history plugin,** an agent's window holds 50 to 100 messages and drops 50 at a time
  (was the latest 50, one off every turn), so the prompt cache holds between drops. `lineage`
  (exported) takes `batched`; its `since: ""` now means every message, and its db needs
  `countDocuments`.
- **Fixed:** lifting a usage waiver gave back nothing for a use recorded in the very millisecond it
  was lifted (a flaky billing test showed it).

## 1.0.0-rc.16 — 2026-11-02

- **Fixed:** staff by email weren't staff anywhere but going into an org. `org.mine` asked without
  their email, so anyone signed in with Google, whose id isn't their email, had no console and no
  "Enter as staff". It takes `email` now, and the orgs host passes the one they verified.

## 1.0.0-rc.15 — 2026-11-02

- **Enter as staff, in your own org too.** Staff who belong to an org go in as one of its people, as
  before, but can now ask to go in as staff: from the console, or the org switcher. They keep their
  role, get the staff tools, and "Continue as Owner" takes them back. `POST /orgs/enter` takes
  `staff: true`, `org.enter` takes `staff`, and `GET /orgs` says `asStaff`, which `asStaff()` now
  reads instead of guessing from membership.

## 1.0.0-rc.14 — 2026-11-02

- **Credits** (`plugins/billing/credits`): what an org can spend. Plans, credits and payments are
  its own rows, the balance is walked from them and the ledger, and one check stops model calls,
  computers and builds at the limit, in plain words. Staff set plans, give credits, waive usage or
  seats, and record payments; gift codes wait in the directory.
- **Stripe** (`plugins/billing/stripe`): Checkout, the customer portal and signed webhooks, for one
  or more accounts. A subscription's credits come with its paid invoice.
- **Prices:** a use on an org's own key costs nothing; a plan can name a price list; `usage.quotes`;
  the model picker shows the org's real price.
- **Removed:** the cloud plugin's `create` and `budgetUsd` settings. Anyone in an org but its guests
  makes a computer; what the org can spend keeps the cost.
- **Fixed:** model use listeners are awaited, so a late record isn't lost; a VM's seconds stop at
  its lease, so an org closed for days isn't charged for a VM long gone.
- `composerNotes`, a note above the composer from another front end.

## 1.0.0-rc.13 — 2026-11-01

- **Choose an agent's model from the catalog, with your own key.** The agent editor searches every
  provider and model in the models.dev catalog an agent can work with (`models.offered`): those with
  a protocol we speak and an address of their own. An org's owners and admins add a key for a
  provider right there (`modelKey.set`): it's sealed, shows only its end, and its agents' calls to
  that provider use it, over the app's. Those uses are tagged `paid: "own-key"`. The catalog now
  keeps names, release dates, and which models can't call tools or answer in text.
- **Secrets stay out of the log.** `env.set` and `apps.configure` recorded their input, so a space's
  or an app's secret was kept in plain text in its `action.started` event, sealed field or not. Both
  are unrecorded now. Secrets set before this remain in events already written: rotate them.
- **Agents manage cloud computers.** `list_computers`, `create_computer` and `manage_computer` (add,
  remove, rename, default, destroy) work in the conversation's space, as the person the agent works
  for, through the same Actions and rules a person has. Nothing asks first except destroying, which
  loses the disk: like publishing, it's asked every time and only "once" allows it. A person's own
  machine isn't an agent's to manage. An agent in a space with no computer is told it can make one.
- **A query an Action runs knows who asks.** Named queries called from an Action or a transaction
  lost the actor for what they call themselves, so a query asking another Action could fail, or
  answer as though nobody asked.
- **A read's answer no longer overwrites something newer.** The owner answers a batch of reads once
  its slowest is ready, so a change could be pushed before the answer that didn't include it. The
  client then showed the older answer until the read next changed: on a page's first load (the push
  was dropped) and after a reconnect (the push was overwritten). What's pushed while a read is asked
  for now wins over its answer, and a connection that's been replaced is no longer listened to.

## 1.0.0-rc.12 — 2026-11-01

- **An agent can hand work to itself in another space.** "Itself" now means the same agent in the
  same chat: North in Personal and North in Project management are two pieces of work. Whoever a
  space says answers takes what's handed there, even the agent that sent it, instead of being
  skipped for someone else, so a space where only that agent answers can receive work too. It reads
  what it handed over, and the answer back, as input (`You (via delegated "Solo"): …`), not as
  something it said.
- **Delegated messages name the other space:** "Delegated: Personal" there, "Delegated: Project
  management" back, with an icon of their own.

## 1.0.0-rc.11 — 2026-10-31

- **A routine can run with nobody watching.** What its agent needs a yes for can now be allowed for
  that routine alone: "Allow for this routine" on the card, or "What it can do without asking" on
  its page (run commands, start jobs, change files, per computer), ahead of its first run. Allowing
  it answers every run already stopped on the same thing. What a run waits on shows on the routine's
  page, with the way to its chat. In the terminal: `/approve <n> routine`.
- **That yes covers only that routine's runs, as it was.** A run's work carries the routine as its
  `origin`, on the actor (`originOf`, chat's contract), which only code can set: a person's own
  message to the same agent still asks, even one claiming `via` a routine. Changing what a routine
  does (what it asks, whom, as whom) makes a new version (`routine.rev`), which the yes doesn't
  cover: its page says so and offers "Allow again". Name and schedule don't count. Where a
  computer's owner keeps the answers, only they can say it (`computer.allowOrigin`).
- **Plugins can add to a routine's page:** the `routinePanels` resource (`{ view, order? }`), a View
  given the routine.
- **Authorization is one model.** `personOf`, `forbidden`, `invalid`, `failure`, `people` and
  `inPerson` come from the runtime; `may`, `must` and `mustOwnOr` from the spaces contract,
  replacing seven `personOf` copies, about 25 hand-written checks and about 30 local error helpers.
  `reachOf` is the only answer to what someone may do, and respects every limit on them.
- **Fixed: taking over a space.** A thread named after a space could be used to become its manager.
  A document's memberships now live under its own name (`note:n1`), and only shared collections can
  be named.
- **Fixed: keys left their space.** Actions that checked reach, then wrote as the system, ignored a
  key's limit. Reach respects it now (`within`, which replaces `at` on a key's actor), and the API's
  own narrowing rules are gone. Keys can't answer approvals.
- **Fixed: agents asked by agents ran as the agent that asked.** A turn is always its own agent, for
  the person the work is for, including where a computer's owner answered.
- **Publishing is asked every time.** Nothing wider than once is offered or honored.
- **Approvals can be taken back,** from the Computer tab. What's allowed for a routine comes from
  the routine (`origins` resource), not from what the caller says.
- **Roles are given one way** (`seat`): a granted request can't name a role that doesn't exist or
  make an agent a manager, and custom roles count everywhere.
- **An archived space isn't written in,** which only views enforced before.
- **Replacing or rebuilding an app** takes its publisher or a manager. **Where a computer's owner
  answers,** only they change anything on it directly; others still read it.
- **Leaving ends what someone left behind,** however they left: desks, yeses and keys for that
  space, and out of the org, all of them and their own computers. Cloud computers stay for those who
  run the org. A preview's cookie asks whether its person is still a member on each request.
- **Agents can hand work to other spaces.** `send_message` takes `space`: any space the person can
  write in, listed in the agent's context with who answers there. A new chat opens there, visible to
  its members and marked as delegated, for the same person; the answer comes back to the chat it
  came from, and stopping that chat stops the work. An agent can't hand work to itself.

## 1.0.0-rc.10 — 2026-10-31

- **A routine made from a chat posts back in that chat.** `schedule_routine` keeps the chat it was
  called from (`routine.thread`), where before no setting could reach it: `same` meant a new chat
  made by the first run. `routine.create` takes `thread` (a chat in that space its maker can see),
  and `post` now defaults to `same`, in the web form too. Its confirmation says where it posts. If
  the chat is deleted or moved to another space, the run starts a new one and says why
  (`routineRun.note`).
- **A new chat each run is a first-class choice,** for runs to open later (a daily analysis):
  `post:
  "new"`. Each chat is named by `chatName`, with `{name}`, `{date}`, `{time}` (its
  timezone) and `{run}` filled in; by default its name and the day (and time, for `hours` and
  `cron`), so runs no longer all share one name. Its agent may then name it for what it found, with
  the new `name_chat` tool, offered only in those chats. The routine's page lists runs by their
  chats' names. The form and the agent's confirmation say how many chats a day it comes to, when it
  runs at least hourly.
- **A routine's messages say they're its.** `chat.send` takes `via` (`{ kind, name, path? }`): the
  message is still its sender's, but shows "Routine: Pricing", linked to the routine, and agents
  read `ana (via routine "Pricing"): …`, so they know nobody typed it just now. `chat.send` also
  takes `title` and `renamable` for a new thread, in the same commit as its first message.

## 1.0.0-rc.9 — 2026-10-31

- **A space's page has a few tabs, and their sections.** A `spaceTabs` entry `under` another tab is
  a section of it, listed in its menu, with an optional `group` heading; a tab with sections names
  its own View among them (`own`) and shows them in a menu beside (`menu: "side"`) or as tabs above
  (`top`, the default). A section's key opens its tab there (`?tab=memories`), so every address
  still works, and the palette lists sections too. The tabs now: Chats, Board and Documents (an
  app's), Computer (Computers, Environment, Apps), Routines and Settings (General, Members,
  Memories, Skills, Channels: WhatsApp, API). Where there's no room for a menu beside (a phone),
  Settings is a list to tap into, and a section says how to get back; in the side panel, sections
  are tabs under the panel's. Who's waiting to join shows on Settings and on Members.
- **On phones, an app's page.** The viewport spans the screen (`viewport-fit=cover`; the composer
  keeps clear of the home bar) and the keyboard resizes the page where browsers allow
  (`interactive-widget`); pinching still zooms. The page never scrolls sideways or bounces as a
  whole, and a tap is a tap (no double-tap zoom, no grey flash). On touch screens, text is 16px,
  fields too at least (so Safari never zooms in on one you type in), and buttons, icon buttons,
  fields and copy buttons are 44px targets (40px small).
- **A conversation scrolls up and down only.** What's wider (a table, code) scrolls in its own box;
  text wraps; a file's chip and a tool call being written no longer widen it.
- **What an agent asks you never covers the conversation.** The command or the file it shows scrolls
  within a few lines (a command can wrap into dozens), with a copy button, so the answers are always
  in sight; the cards keep to at most 60% of the chat's height and scroll there.

## 1.0.0-rc.8 — 2026-10-31

- **Agents' prompts only grow, so the prompt cache keeps them whole.** A turn context (the
  computers', the spaces elsewhere, memories, an app's) is sent after the conversation only when it
  says something new: when its text isn't what the agent was last told there. The turn's first
  message keeps what it was told (`told`, `[{ name, text }]`, a private field: people's reads come
  without it), and later turns are sent it there. So each model call starts with the whole call
  before it, tool steps and earlier contexts included, where before a turn's context, dropped the
  next turn, cut the cached prefix at the turn's start. `Prompt.turn` is now `{ name, text }[]`:
  what's new this turn.
- **OpenAI's newer models keep the prefix where told.** Since GPT-5.6, OpenAI caches only at
  breakpoints: its implicit one falls at the end of the latest user message, the turn's context,
  which the next turn didn't send, so a conversation reused only its system text. The Responses
  adapter now marks a message with `cache` (the end of the history) with an explicit
  `prompt_cache_breakpoint`, on the user's or tool's input at or before it. A model that refuses
  breakpoints (earlier ones, other servers) is asked again without, and never again. What OpenAI
  wrote to the cache is metered as `cacheWrite` (billed at a premium by models that report it).
- **Memory: the system text says how to remember; what's remembered is told.** The `memory` context
  (system) is the guide alone, the same in every conversation, so the system text is cached across
  all of an agent's conversations in a space. Core memories about who's here are the new
  `remembered` turn context: those learned before the conversation began, told at its start and kept
  there. Core memories learned since come up in `recall` when relevant (query `relevant` takes
  `since`; `core` takes `before`), so a memory learned mid-conversation never rewrites its prompt.
- **History summarizes a message when it leaves the tail**, not when it comes: only then is its line
  read (in the outline, or by `zoom`). A conversation that stays within the tail never calls the
  summarizer; a longer one builds the same tree, in batches, as its tail shrinks. The outline keeps
  the tail's message ids (`tailIds`); threads summarized before keep the lines they have.
- Measured on Compass's own plugins with real OpenAI calls (gpt-6.1-sol; a 12-turn conversation,
  then a 4-turn one with tool steps, the same agent in the same space): the agent's calls read 95.5%
  of their input from the prompt cache, up from 59.3%, and every model call in the run (memory
  extraction included) 92.4%, up from 44.4%, with no summarizer call (101 before). A 24-turn
  conversation that outgrew its tail: 92.4% for the agent, its one miss when the outline arrives
  (the prompt is new from there).

## 1.0.0-rc.7 — 2026-10-30

- **Agents choose among a space's computers.** Every computer tool (the terminal, jobs, files, the
  browser, web search, `preview`, and the apps' `publish`) takes `computer`: one of the space's
  computers by its name (any case, or part of it when only one has it) or its id; the space's
  default otherwise. An unknown or ambiguous name, or a computer that's offline, is told with the
  ones to choose from; naming a cloud computer that's asleep wakes it. Each turn, an agent's context
  lists the space's computers (whose, a cloud computer or a machine, how it is now, its system, what
  it asks first, the default marked) when there are several; one stays as it was. In a space with
  several, an answer says the computer it came from (`computer`), and the web's tool steps show it.
- **A job is found on whichever computer runs it:** `computer.preview` and `computer.scope` (and so
  `app.publish` and the agents' `preview` and `publish`) take a job without a computer and look for
  it on the space's computers that are online, the default first. `computer.preview`,
  `computer.scope`, `computer.allowed` and `app.publish` take `computer` (a name or an id).
- **The default computer** is named so on the web (a "Default" badge, "Make it the default") and in
  `/computers`.
- **Apps: what serves a preview serves the app.** A folder with no Dockerfile is built into an image
  made for it (no more buildpacks, which found nothing to build in a plain folder): the computer's
  system (Debian 12) with Node.js 24 and Python, the folder as it was sent, its dependencies
  installed again (npm, pnpm, yarn; `requirements.txt`) and its `build` script run, then its job's
  command behind a front that passes the platform's port on to the job's port on localhost,
  WebSockets included. A job bound to `127.0.0.1` (as previews allow) is served all the same; the
  job is given its own port as `PORT`. `AppHost.build` answers the port its image serves on. Without
  a Dockerfile, an app is published from its job (its command).
- **A space's environment: variables and secrets.** Each space has its own (collection `envVar`,
  `{ name, value, secret, computers, by, at }`, names like `API_URL`). Its managers change it
  (`env.set` `{ in, name, value?, secret?, computers? }`, `env.unset`); its members read names and
  the values of variables. A secret is sealed at rest (AES-GCM, with the new `computers: { key }`
  resource, else kept as given) and never read back by anyone: people see only that it's there (and
  a long one's last 4 characters), agents only its name. Every job and shell started in the space,
  from the web or by an agent, gets the variables with `computers` (true unless said), under its own
  `env` (`jobs.start` and `terminal` take `env`; the `start_job` tool too); a job kept running keeps
  its env on the computer's disk and starts again with it. A secret given to computers can be read
  by any process there, and the web says so where it's given. Agents' computer context lists the
  names they have (`$NAME`), never a value.
- **Apps get the space's environment.** An app is deployed with all of its space's variables and
  secrets, and its own over them (`envVar` with `app`; queries `here` and `apps`), passed to Cloud
  Run as its env. `app.configure` `{ app, env? }` (its publisher, or the space's managers) changes
  its own and deploys its image again with them, without a build (the port the image serves is kept
  as `served`). A change to the space's environment doesn't redeploy anything: it reaches an app
  when it's published again, or at once with "Apply to apps". Taking an app down removes its own
  environment (`env.unset` `{ in, app }`).
- **Web: Environment.** A space's Environment tab lists its variables (a secret masked, whether its
  computers get it, who set it and when); its managers add, change and remove them, with the honest
  limit shown beside a secret given to computers. Under it, its live apps and "Apply to apps"
  (through computers' new `envActions` resource). An app's row opens its environment: the space's
  shown, its own edited, saved with a redeploy. The job start form takes its own environment
  (`NAME=value` lines). The toolkit's `Time` also draws on a server.
- **People by name, everywhere:** agents' prompts, notes, the terminal and the web show a person's
  name where they showed their id (`google:1139…`). The spaces plugin keeps each person's profile
  (collection `profile`: their name as sign-in verified it, else their email's name, and picture;
  never their email), from the identity plugin's `person` as it changes, at `org.join`, and on
  `space.personal` (each page load), so people known before it get one the next time they come.
  Anyone in the org reads names through the query `profile.names` `{ ids }` (a browser reads
  profiles only through it); two people of one name stay apart ("Ana (2762)"). The new `names`
  resource says where names are (`{ collection: "profile" }`), and the spaces contract (and
  `copilotz/plugins/access`) gives `nameOf`, `namesOf`, `namesIn` (Views), `namesFor` (Actions,
  Processors, tools), `withNames`, `idsIn` and `PROFILE`. A sign-in's id is never shown as a name:
  without a profile, it's "someone".
- **Agents' prompts:** others' messages read "Ana Lima: …", "People here:" names people, a
  conversation's space is "Ana Lima's Personal space", the computers context says whose computer it
  is and who says yes by name, as do waiting asks, routines (who made one, whom it runs as), history
  summaries and zoom, and recall. Memory extraction writes names, and `remember`'s `about` takes a
  person by name.
- **Notes and summaries written before names:** a memory or a summary that says someone's id
  (`google:1139…'s cloud computer…`) reads with their name wherever it shows (prompts, recall, the
  Memories page, the terminal), substituted when it's shown: nothing stored is changed, and nothing
  needs migrating.
- **The web:** the Members tab (people, requests to join, invitations), the space header's faces,
  other people's Personal spaces ("Ana Lima's Personal"), invitations ("Ana Lima invited you"), chat
  messages and the conversation's people, memories (grouped, by whom, search), routines, skills
  ("Made by"), apps ("by"), computers (whose each is, who asks first, who started a job or made a
  preview), usage and the org's people show names. **The terminal:** `/computers`, `/approvals`,
  `/requests`, `/grant`, `/invitations`, memories and messages, likewise; `/remove` takes a person's
  id with a colon (`google:1139…`).
- **Share refusals** name the spaces a write would reveal ("Ana Lima's Personal space"), not their
  ids. An org invitation made by a space invitation says who invited them.

## 1.0.0-rc.6 — 2026-10-30

- **Computer program:** an app on another machine over plain `ws:` (an `http://` address that isn't
  localhost) fails at once, saying to use https, instead of waiting to connect forever: Oxian
  refuses plain `ws:` but to this machine.
- **Cloud pools:** a pool grown for a wake isn't shrunk while its VM boots. `pool.take` records what
  it waits for (`poolWant`), and `pool.tick` sizes each pool to its floor, the takes of the last 2
  minutes and the wakes still waiting. Before, the next minute's sizing set the pool back to its
  floor, deleting the VM a wake had grown it for before it connected.
- **Cloud computers:** `cloudComputer.sizes` also says whether the person asking may make one now
  (`create`, and `why` not: `admins`, `budget`), and the warm and view minutes; `cloud.may` says
  just that. The web's "Use a cloud computer" choice shows why it can't be picked, and the copy says
  the app's minutes.
- **Cloud computers shared into a space:** each computer's state is kept on it and its desks
  (`status`: `{ kind: "cloud", state, size }`, set with the new system Action `computer.mark`, as
  the cloud plugin sees it change), so the space's members see how anyone's is (asleep, waking,
  awake), not "offline".
- **Previews:** `preview.here` records carry their address (`url`); the web no longer works it out.
  `computer.preview` and `computer.scope` take a `desk` (one of the space's), and so does
  `app.publish`: the web makes previews and publishes apps from the computer it's on, not the
  space's default.
- **Apps:** an agent's `publish` asks its person with where the app will be ("wants to publish Shop
  at https://shop.copilotz.app").
- **`org.me`** isn't recorded (it only reads), so reads (queries, Views) ask it too.
- **The local cloud host** is one per app and account, whichever executor asks: with several
  executors, a VM one started was turned away by another.

## 1.0.0-rc.5 — 2026-10-30

- **Cloud computers** (plugin `cloud`, see design/cloud-computers.md): computers the app hosts for
  its people. A cloud computer is a disk; a VM from a pool serves it for one wake, then goes.
  `cloud.create` `{ size, in?, name? }` makes one (an org's owners and admins, or its members when
  the settings say, under the org's monthly `budgetUsd`); work for one that's asleep wakes it (a few
  seconds; about 30 from cold); unused for `warmMinutes` (10) it's released, and after `coldDays`
  (7) it goes cold, kept as a snapshot. A person with it open (`computer.view`, every few minutes
  from its panel) keeps it awake up to `viewMinutes` (120). Its agents ask their person nothing
  first (the `cloud` settings' `approve`, `[]` by default, in place of the computers plugin's;
  publishing an app is always asked). `cloud.destroy`, `cloud.org`, queries `cloudComputer.mine` and
  `cloudComputer.sizes` (each size priced an hour). Hosts are adapters: Compute Engine (`gceHost`:
  managed instance groups as pools, pd-balanced disks, VMs admitted by their Google identity tokens)
  and a local one for development and tests. Metered under `computer` as `cloud/<size>` (VM
  seconds), `cloud/disk` and `cloud/snapshot` (GB-hours).
- **Cloud pools** (plugin `cloudPool`): the pools' VMs, where they connect (the `pool` worker kind),
  and the Actions `cloud` reaches them through: `pool.take`, `pool.serve`, `pool.stop`, `pool.drop`,
  `pool.renew`, and `pool.tick` each minute (pools sized by the hour). Each VM given is leased:
  renewed each minute while its computer uses it, deleted once nobody does. A VM serving a computer
  connects again as itself when its socket drops, until it's told to stop; then, or gone, never
  again. One runtime has both plugins; an app of many orgs runs `cloudPool` once (its directory's
  runtime, needing nothing else) and gives each org's runtime `remotePool(call, org)`, the same
  Actions forwarded there, each org touching only its own VMs.
- **Computer program:** `computer pool --app <url>`, a free VM of an app's pool: it waits to serve a
  computer, mounts its disk, and runs it, connected at the address it's told (its org's). Given the
  app's socket (`wss://…`), its identity is still for the app's https origin. scripts/cloud has a
  Google Cloud project's setup and the pool VMs' startup script.
- **Previews:** what a job serves, at `https://<computer>-preview.<domain>`, carried to the computer
  over its own connection (no inbound network), streamed both ways (`computer.http`). For a space's
  members (a signed cookie, given by the app) or anyone with the link. `computer.preview`,
  `computer.previews`, `computer.unpreview`, and the agents' `preview` tool. Settings
  `computers.previews` `{ domain, key }`. WebSockets aren't carried yet.
- **Apps** (plugin `apps`): what a job serves, published to run on its own at
  `https://<label>.copilotz.app`. The space's folder is archived by its computer
  (`computer.archive`), built (its Dockerfile, else buildpacks) and deployed as a service that
  scales to zero. `app.publish` (and the agents' `publish` tool, always asked), `app.list`,
  `app.redeploy`, `app.remove`; builds and running metered under `app`. Hosts: Cloud Run
  (`cloudRun`) and a local one (`localApps`).
- **Apps' safety:** services and images are named `cz-app-<name>` (an app never replaces another
  service in its project); builds run as `cz-build@<project>` (`buildServiceAccount`), never the
  project's default service account, as they run the app's own Dockerfile. `app.publish`'s `port`
  wins over its job's.
- **Previews' safety:** a preview's `Set-Cookie` loses its `Domain` (no preview sets cookies for the
  domain's other hosts); a request with several `cz_preview` cookies gets in when any is its host's.
- **Jobs** can say their `port` (a preview's) and be kept (`keep`): a kept job runs again when its
  computer wakes.
- **A person's panel** (`computer.work`): `wake` wakes a computer that sleeps (its page opened);
  what only reads (`jobs.list`, `jobs.logs`, `files.list`, `files.read`, `search`) neither wakes it
  nor keeps it awake, so a page left open lets it sleep (`computer.view` keeps it awake while
  viewed, up to the limit). A computer the app makes says what its agents ask about
  (`computer.provision`'s `approve`, kept on it and its desks).
- **On the web** (`copilotz/plugins/compute/web`: `computersWeb`, `cloudWeb`, `appsWeb`):
  - adding a computer is one choice: a cloud computer (its sizes, priced an hour), your own machine,
    or one of yours;
  - a cloud computer shows its state, how long it's been awake and about what that came to; asleep,
    waking it, with honest progress; deleting it, asked first;
  - a job serving a port can be previewed (members, or anyone with the link), opened, copied and
    published as an app (live as it builds), and a space has an Apps tab;
  - jobs can be kept running.
- **Web host:** routes by host (`{ host }` beside `{ path }`); a trusted front (`front`: a secret
  header and the host it forwards) for apps behind a proxy; orgs claim hosts in the directory
  (`orgHost`), resolved at `/__copilotz/hosts/resolve`.
- **Runtime:** `runtime.workers.dispatch(kind, id, workload, body?)`, for host code (a route)
  streaming work to a connected worker.
- **Usage:** `usage.quote` prices quantities as a use would be, without recording one.

## 1.0.0-rc.4 — 2026-10-30

- **Usage: every use has a price.** It's the cost (a margin of 0) unless the app's price book says
  otherwise: rates of its own, or a gross `margin` on the cost (`{ margin: 0.9 }` is ten times the
  cost), from its `since` date on. `markup` is gone: a margin says it. Uses recorded before count at
  their cost, in totals and when re-rated.
- **Usage: by part.** Each record keeps its cost and price by part (input, cache reads, cache
  writes, output, reasoning…) and what caching saved; totals and rollups sum them.
- **Usage: people see prices.** `usage.totals`, `usage.org` and `usage.calls` give people prices
  only; costs (and so margins) only platform staff and the system. Each of `usage.org` and
  `usage.calls` says whether it shows costs (`costs`).
- **Usage page and `/usage`:** spend (the price) everywhere, with caching visible: hit rate, what
  reading and writing the cache was charged, and what it saved, overall and by model; cached tokens
  in the chart and in each call. Platform staff also see cost and gross margin, marked staff-only.
- **Models:** OpenAI-compatible providers' cache reads and writes are read as each reports them
  (DeepSeek's cache hits, Moonshot's cached tokens, OpenRouter's cache writes).

## 1.0.0-rc.3 — 2026-10-30

- **Computers:** connecting one more app (`computer install <app> --code`) no longer stops the
  computer running in the background: it enrolls beside it, then that one starts again with every
  app. Turned away, the background one runs on as it was (before, a code refused while it was
  stopping left it stopped). The state's lock waits a moment for one that's stopping.
- **Computers:** a new app's folder never takes the name of a space folder kept in the root by a
  computer from before apps had folders of their own.
- **Install script:** it always says, last, how the terminal it ran in gets `computer` (new ones
  have it).

## 1.0.0-rc.2 — 2026-10-30

- **Orgs:** an org's socket is in its own address (`/o/<org>/oxian`), beside the shared `/oxian`, so
  a browser that sends no cookies with a WebSocket (Safari) reaches its org. The web host's page
  says which socket to use (`socket`) and its base (`base`).
- **Web:** a person shows as their name, from their profile, not as their id: the viewer has a
  `label` beside its `name`, which the shell's account menu and the chat's greeting use.
- **Computers:** one machine serves many apps, or many orgs of one. Each is a computer of its own
  there, with its own id and secret, all in one program; a state kept before becomes its one
  connection. `computer list` says which and where; `computer disconnect <app-url>` leaves one. An
  org's spaces go in a folder named for the org (`~/Copilotz/acme-studio`, `~/Copilotz/personal`): a
  code made on an org says it (`folder`), and the install lines pass it on (`--folder`).
- **The computer program's release:** each release on GitHub has it, made by the publish workflow on
  a Mac. When the program is the same as the last release's (`source` in its manifest), the release
  has that one's binaries, version and all, so computers don't download what they have.
  `computerDownloads()` serves this Copilotz's own release by default.

## 1.0.0-rc.1 — 2026-10-30

Copilotz 1.0 is a new runtime, written from scratch: one runtime for agents and the apps around
them, on Node, Deno, Bun, Cloudflare Workers and the browser. It's published as `copilotz` on npm
(Node first) and as `@copilotz/copilotz` on JSR.

- **Primitives only:** the runtime knows plugins, collections (JSON Schema, with the MongoDB
  collection API), Actions, Processors, Views, resources and adapters, and never what a plugin is
  for. Everything durable is an event, a document (node), an edge, a vector or a blob, in one store
  with one writer (the owner); executors run plugin code beside it or elsewhere, over Oxian.
- **Plugins, by theme:** models (llm, embeddings, transcription, with the models.dev catalog),
  agents (chat, history, memory, team, skills, routines), access (spaces, identity, Google sign-in,
  connected accounts, the directory of orgs), billing (the usage ledger), compute (computers people
  connect, on macOS, Linux and Windows) and interfaces (the terminal and web shells, the developer
  API, WhatsApp).
- **Stores:** memory, SQLite and PostgreSQL (a server, or PGlite), with the same MongoDB semantics
  and one conformance suite; blobs in the store, in files or in a bucket over HTTP. On PostgreSQL,
  many orgs share a schema, each a tenant, over one pool of connections per process; a tenant's rows
  are copied, exported (as SQL) or dropped on their own.
- **Hosts:** the terminal (Ink) and the web (React 19 in the browser, signed in as a person under
  the access rules, with a design system an app rebrands by one theme resource), and orgs: many orgs
  behind one address, each a runtime of its own, opened when used, and reached by its own address
  too (`/o/<org>`) by what has no browser session: API keys, webhooks, computers. On Node,
  `copilotz/web/node` bundles the browser's code with esbuild and serves the web host, its sockets
  through Oxian's Node adapter, for one runtime or one per org.
- **Entry points:** `copilotz`, `copilotz/stores/*`, `copilotz/blobs/*`, `copilotz/plugins/<theme>`
  with its `web` and `terminal` front ends, `copilotz/web` (with `server`, `tickets`, `theme` and
  `node`), `copilotz/orgs`, `copilotz/terminal`, `copilotz/exporters` and `copilotz/testing`; the
  same names on JSR.
- **Metrics:** the runtime and plugins measure themselves the OpenTelemetry way, exported as OTLP or
  Prometheus text.

1.0 doesn't read 0.x data, and there's no migration: a 1.0 app starts with a new database. Copilotz
0.x lives on the [`v0`](https://github.com/copilotzhq/copilotz/tree/v0) branch, where its releases
and their changelog continue; its last release is 0.90.2.
