## Unreleased

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
