# STAGING: the plugins' behavior (not published)

> **Staging, not a page.** This is what's left of the old README's reference, copied verbatim from
> the README of 1.0.0-rc.31 (`git show v1.0.0-rc.31:README.md`). It's not in `docs/manifest.json`,
> and the website doesn't show it. Relative links are relative to the repository's root.
>
> Everything else moved: the entry points, the primitives, events, schedules, models and providers,
> and the web's look and words to `docs/reference.md`; the architecture to `docs/architecture.md`
> and `docs/architecture/`. Each plugin's page under `docs/reference/plugins/` is generated from the
> plugin itself (`scripts/describe.ts`), so it says what a plugin declares, but not how it behaves.
> That prose is below, still as rc.31 had it: chat's run-once tool calls, files and audio, history's
> summaries, usage's rating and rollups, webTools' limits, the sign-in flows, whatsapp, voice, mcp
> and openapi. Decide where it goes (the plugins' own docs, which the generator could carry, or a
> page per theme), check it against the code, then delete this file.

## Plugins

Plugins come in themes. Every plugin is a plain object, and its settings are a resource under its
own name, which the app patches like any resource:

```ts
plugins: [
  models,
  chat,
  history,
  memory,
  usage,
  definePlugin({
    name: "app",
    resources: { history: { summarizer: "cheap" }, memory: { embedder: "small" }, agents: { … } },
  }),
];
```

Inside a theme, each plugin is laid out by primitive: `collections/`, `actions/`, `events/`,
`processors/`, `views/`, `resources/`, `adapters/`, `routes/`, one file per declaration, with
`shared/` for what several use; its `mod.ts` only assembles them. Its front ends are its own
(`web.tsx`, `terminal.ts`), loaded only where they draw, and the theme gathers them
(`plugins/agents/web.tsx`). Tests sit next to their theme (`plugins/<theme>/tests/`).

**A plugin reaches another only through the runtime, by name**, in three ways:

- **ask it to do something:** its Actions (`ctx.call("llm.stream", …)`);
- **plug into it:** the resource kinds it reads (chat's `tools` and `context`, models' `modelUse`,
  the terminal's `commands`, the web shell's `palette`);
- **hear what it announces:** its declared events, with Processors (`message.created`,
  `turn.requested`).

A plugin that builds on another (memory and history on chat, chat on models, Google sign-in on
identity) says so (`requires: ["chat"]`), and imports from it only its `contract.ts`: the shapes of
its documents and resource kinds, its Actions' inputs and outputs, and declaration helpers such as
chat's `tool()`. Never its code. Plugins that would share code are one plugin (`models`).

**`models/`**: talking to models, one plugin (`models`) for four kinds. Other plugins call it by
name, never by importing its code.

- **`llm`**: `llm.stream` (chunks as they come, for a job in the same process: an agent's turn) or
  `llm.generate` (the whole answer; from outside, its `stream` names a channel for live text).
  Adapters, named by protocol: `openai` (Responses), `openai-compatible` (Chat Completions),
  `anthropic`, `gemini`, and `fake` for offline runs (`"fake/echo"`).
- **`embeddings`**: `embeddings.embed`, from jobs, queries and Views. Adapters: `openai`,
  `openai-compatible`, and `hash` (offline, word overlap: `"hash/words"`). One model per embedder:
  vectors from different models don't compare.
- **`transcription`**: `transcription.transcribe`, with base64 audio. Adapters: `openai`,
  `openai-compatible`.
- **`image`**: `image.generate`, images from a prompt and images to work from. Adapters: `gemini`
  (`generateContent` asking for images: `gemini-3-pro-image`, `gemini-3.1-flash-image`…), `openai`
  (`gpt-image-2`…), and `fake` for offline runs (`"fake/image"`).
  - **References** are an image made here (`{ id }`), a document the caller may read holding a file
    as `type` and `data` (`{ id, collection: "file" }`: chat's files; read as the caller, so the
    rules decide), or inline (`{ data, type }`, or a data URL).
  - **What it makes** is kept in the `image` collection, a document each (its content a blob, so the
    same image attached to a message is stored once), and answered by id, media type and size, with
    what the model said. Posting one in a conversation is the caller's: models knows nothing of
    chat.
  - **Metered like every model call:** the org's own key if it has one, `modelUse` listeners and the
    `spending` check before; its tokens told after, which the ledger prices from the catalog as it
    prices a chat's. A model that refuses (its safety rules) fails `image_refused`, and no other
    model is asked; one that makes nothing fails `no_image` once the list is spent.

  ```ts
  // In a tool or an Action: the images kept, by id; their content is read by id when needed.
  const { images, text } = await ctx.call<Images>("image.generate", {
    model: "google/gemini-3-pro-image", // or an alias, or a list tried in order
    prompt: "Our mascot on a beach, flat illustration",
    references: [{ id: fileId, collection: "file" }],
    aspectRatio: "4:5",
    size: "2K", // the provider's own: Gemini's 1K, 2K, 4K
    tags: { thread, space, purpose: "post" },
  });
  const image = await ctx.db.collection<Image>("image").findOne({ _id: images[0].id });
  ```
- **`models.check`** says what's wrong with a model for a port (other plugins' startup checks ask
  it); **`models.price`** says what the catalog says a model costs (the usage ledger asks it).
- These are unrecorded Actions: called from a job they run inline (no events, no commit of their
  own), and queries, Views and startup checks may call them too, read-only. `image.generate` is
  recorded: it writes what it made and costs, so a job that runs again finds it done.

**`agents/`**: conversations and the agents in them.

- **`chat`**: threads, messages, and agents
  (`{ instructions, model, effort?, maxTokens?, temperature?, tools?, history? }`) that answer with
  tools, calling models through `llm`. A reasoning model's thinking (its provider state) is kept on
  the agent's tool steps and goes back to that model while its turn goes on.
  - **Several agents** take turns in parallel. With `send_message` an agent messages another agent
    or a person, and waits for the replies before it continues.
  - **`@name` mentions** choose who a message goes to, but only when the name is someone: an agent,
    or a person in the conversation. Any other `@word` (a social handle, say) is plain text, and the
    message goes where it would without it: the conversation's agents, or the space's default.
  - **History by age:** an agent with `history: { maxAge: 4 * 3_600_000 }` (ms) is sent only the
    last four hours of a conversation, back from its newest message (summaries too, with `history`);
    what's older stays in the chat. The start moves in steps of a tenth of `maxAge`, so prompts keep
    hitting the provider's cache ([design](design/views.md#history-as-views)).
  - **A tool call runs once:** before a step's tools run, the step's calls are written (an
    `intent`), and what each returns as soon as it does. A retried turn (it failed after its tools
    ran, its executor died, the runtime restarted) goes on with those calls instead of asking its
    model again: a call that returned isn't run again, and one cut short runs again as itself, with
    the same `ctx.callId` and `ctx.retry` true. Pass `callId` to an outside API as the idempotency
    key, or call recorded Actions (they answer from the log), and a payment behind a tool is made
    once. A turn that ends without its step (failed for good, stopped) keeps it, saying which calls
    never returned, so people and its later turns know what happened.
  - **Subthreads are forks:** whoever works in one sees the conversation up to the message it hangs
    from, through every level, without anything being copied. A new thread starts from its first
    message and records the thread it came from.
  - **The prompt is a View:** the thread's `llm` View returns the agent's tools, its system text
    (instructions, who's in the conversation, `system` contexts) and the conversation, then `turn`
    contexts. Plugins add context with `resources.context.<name> = { place }` and a `context:<name>`
    View, and change how anything reads to a model with Views (`views: { "tool:<name>": { llm } }`).
    `runtime.query("thread.prompt", { thread, agent })` and `/prompt` show exactly what an agent
    gets.
  - **Files:** a message's files ride on it by name, type and size; their content is a `file`
    document whose data (plain base64) the owner keeps as a blob. Each is uploaded on its own first
    (`chat.attach`, one file a call, about 10 MB at most), as its sender's draft, which nobody else
    reads; `chat.send` then names them (`files: [{ id }]`) and they join its conversation in its
    commit. The web composer uploads each file as it's chosen. A sender holds 20 drafts at most, and
    those not sent within a day go (`chat.prune`, every hour). A contact's upload is let in by the
    `contactSend` hooks as a message to nobody carrying it. `file.about` says what a file is, as its
    reader reaches it, without its content; `/files/<id>` streams the content, of any size, in
    parts, with ranges. Agents read a text file's content, are shown images and PDFs when their
    model reads them (the latest 8; the catalog says which models do, or the model choice's
    `input: ["image"]`, and the others are told what they can't see), and see anything else by name.
  - **Audio:** `chat.send` transcribes audio before anything is sent (`chat.transcriber`, by default
    the `transcribe` model alias), and agents read the transcript. If it fails nothing is sent
    (`transcription_failed`); `transcribe: false` sends audio as it is. A voice message may say
    nothing else; its file carries `voice` (duration, peaks) for its player.
  - **In spaces:** chat declares its own `shared` entries (threads, messages with labels, files,
    what's being written), so an app with the access plugin needn't. A chat's messages, files and
    live writing are part of it (`part: "thread"`): shared on its own (with a contact), its parts
    come with it. `chat.open` opens an empty chat in a space; `chat.say` has an agent say a fixed
    message there without a turn (trusted code only: a payment confirmed), which goes out like any
    of its answers.
  - **An agent's message with files:** `chat.say` takes `files`, so a tool posts what it made (a
    picture) without writing chat's collections. Each is a document the caller reads that holds a
    file as `type` and `data`: one of chat's own (`{ id }`) or another plugin's
    (`{ id, collection: "image" }`, the models plugin's pictures). Or it's given as it is
    (`{ name, type, data }`). Each becomes a file of the chat, under people's limits (ten, about 10
    MB each, a media type). Its content is the same blob, so it isn't stored again. The message may
    then say nothing else, and the agent is told next time what it sent (`[sent: logo.png]`).

    ```ts
    const { images } = await ctx.call<Images>("image.generate", { model, prompt });
    await ctx.call("chat.say", {
      id: `image:${images[0].id}`, // said once
      thread,
      from: "designer",
      files: images.map(({ id }) => ({ id, collection: "image" })),
    }); // → { message, files: [ids of the chat's files] }
    ```
  - **A turn that fails** still answers, so whoever waits on it resumes. People read a short line
    (`<agent> failed: something went wrong…`), and what went wrong stays in the `processor.failed`
    event. A refusal written for people answers in its own words: any failure made public, such as
    the `spending` check's refusal (its `message`, whatever its `why`) or a web line's budget.
  - **After an answer:** a place that can (WhatsApp) shows features' additions
    (`resources.additions.<name> = { order?, agents? }` and an `addition:<name>` View there), each
    once per chat per key, recorded in `shown`; the model is told what went (`[then shown: …]`). A
    message tapped from a button carries `tap: { id, title, key }`, and agents read the id.
  - **Moving in:** `chat.import` (the system's: a migration) brings a conversation from another app
    as it was: its thread in a space with its title, and its messages, each with who said it, to
    whom, what, its files (their `data`, or the `id` of a document holding one) and when (ISO 8601
    with its zone). Nothing runs: no turn, no transcript. Ids are the importer's, so importing again
    replaces what it made, and a long conversation comes in several calls; the thread's count, first
    and latest are worked out from what it has. Processors that follow messages (history's
    summaries) take imported ones as any.
- **`history`** keeps chat history from outgrowing the prompt
  (`resources: { history: { summarizer: "openai/gpt-5.4-mini" } }`): every message stays whole, a
  cheap model writes a line for each and merges pairs up a binary tree, and an agent gets recent
  messages whole after one line per older part (fine when recent, coarse when old). The `zoom` tool,
  offered once a thread is summarized, opens any line back down to the message. The tail and the
  lines grow at their end and shrink in batches, so prompts keep hitting the provider's cache. Chat
  knows nothing of it: it replaces chat's `history` View and tells chat where whole messages start
  (a `history.since` View).
- **`memory`** gives agents memory across conversations (`resources: { memory: { embedder } }`; with
  `memoryExtraction` beside it and an `extractor`, memories also arrive on their own).
  - **Memories** are statements about a person, the agent itself, a thread, or everyone, stored with
    an embedding, so recall works by meaning and by words.
  - **Always in mind:** core memories about whoever is in the conversation go in the stable system
    text; the other memories most relevant to what was just said come after the conversation, each
    turn. If finding them fails (the embedder's provider refuses, or times out), the turn goes on
    without them: the failure is logged and counted (`copilotz.memory.recall_failures`).
  - **Tools for every agent:** `remember` (which updates what it repeats instead of duplicating it),
    `recall` and `forget`.
  - **On its own:** with an `extractor` model, every few messages it writes down what's worth
    keeping (who people are, preferences, decisions), updating what it already knew.
  - **Moving in:** `memory.import` (the system's) brings memories from another app as they were, in
    a space: what each says, whom it's about, who wrote it and when, under the importer's ids
    (importing again replaces them). Each is embedded as it's kept, so recall finds it by meaning.
- **`team`**: agents people make in a space, beside the app's, each a member of the spaces it works
  in, with a page of its own on the web.
- **`skills`**: know-how an agent reads only when a task calls for it (a SKILL.md: a name, when it's
  for, instructions, files beside). The app's are a `skills` resource; a space's managers make their
  own. Each turn lists the names and purposes of the skills an agent has there, and `read_skill`
  reads one. Built on chat's `context` and tools, so chat pays nothing without it.
- **`routines`**: a message sent to an agent on a schedule, in a space ("every weekday at 9:00, ask
  @researcher for the news"), as whoever made it, reaching only what they reach; each run's chat and
  outcome are kept. Agents make them from a conversation too (`schedule_routine`).
- **`tiers`**: which models the app's agents think with, named by what the work needs (Everyday,
  Expert…): the app declares each tier's model for each agent; an org chooses one, a space can
  choose another, and either can pick a model for one agent, the tier's list kept behind it. Kept by
  name, so retuning a tier moves everyone on it; while an org hasn't chosen, its plan's tier
  applies. Each tier shows what a typical reply comes to at the org's prices.
- **`openapi`**: an HTTP API's operations, from its OpenAPI 3 spec, as Actions and tools:
  `openapi({ name: "trips", spec })` is a plugin with, for each operation, a recorded Action
  (`trips.getTrip`: a turn tried again gets the call it already made back, not a second one) and a
  tool calling it (`trips_getTrip`), which agents get by listing it in their `tools`. A tool's input
  is one object: the path, query, header and cookie parameters beside the JSON body's properties
  (refs followed; 3.0's `nullable` converted; read-only properties left out; two inputs of one name
  fail). Its settings are a resource (`resources.openapi.trips`: `baseUrl`, `headers` static or a
  hook per call, `query`, `timeout`, `maxBytes`), so a deployment says where and as whom. A failed
  call says `HTTP <status>: <what the API said>` and carries its status. Files in a response (an
  image as base64 or a data URL, in the fields `files` names, or a response that is one) become
  files of the conversation, and the agent gets a reference instead (`maxFileBytes`, `fileTypes`). A
  tool of your own is `{ ...trips.tools.getTrip, run }`.
- **`webTools`**: agents that search the web and read a page, without a computer. Two tools, which
  agents get by listing them: `web_search` `{ query, count?, language?, country? }` (results
  `{ title, url, snippet }`) and `read_page` `{ url, start? }` (the final URL, title, main text
  without scripts, styles or navigation, and links; long pages come in parts, `start` reads on; the
  text is marked as data, never instructions). Search is the `search` adapter port
  (`resources.webTools.search`: `adapter`, `apiKey`): `duckduckgo` by default (its HTML page: no
  key, no cost; a bot challenge or an empty page is a public "search is unavailable" error the agent
  reads; `language` with `country` set its region), `serper` optional, `fake` offline, and Brave or
  Google are one more adapter. Reading is safe by design: http(s) only, through `ctx.fetch`, no
  cookies, an honest user agent; the host is resolved and loopback, private, link-local (the
  metadata address) and reserved addresses refused, again on every redirect (4 at most); ports other
  than 80 and 443 only if `ports` lists them; 15 s, 2 MB, HTML or text (no PDF); 8 pages per turn. A
  search is a `search` use in the usage ledger, priced from resources (DuckDuckGo's is 0), and asks
  `modelUse` listeners and the `spending` check first, like a model call; reading is free.

  ```ts
  plugins: [
    models,
    chat,
    usage,
    webTools,
    definePlugin({
      name: "app",
      resources: {
        webTools: { search: { adapter: "serper", apiKey: env.SERPER_KEY } }, // none for DuckDuckGo
        cost: { serper: { queries: 0.001, per: 1 } }, // what a search costs the app
        agents: { scout: { instructions, model, tools: ["web_search", "read_page"] } },
      },
    }),
  ];
  ```

**`access/`**: who can see and do what (see [design/access.md](design/access.md)).

- **`spaces`**: shared spaces, Personal spaces and single shared documents, with members (people,
  agents, other spaces) and roles; collections named in the `shared` resource keep to what each
  actor reaches. People join by accepting an invitation to the email they signed in with; sending
  one never says whether the address has an account. Agents are members too, each working only where
  it's one; a new space has the app's default agents. An answer drawn from a space not everyone in
  the conversation can see shows only to those who see both, marked, until someone shares it.
- **`identity`**: people and their sessions, and who a session's secret proves: its `who` reads the
  session cookie (`credential.actor`); `POST /signout` ends the session, and `GET /me` says whom the
  page shows. Sign-in plugins set the cookie with its contract's `signedIn`.
- **`contacts`**: people outside the org who talk to its agents (a WhatsApp customer). A contact is
  its own kind of actor (`{ kind: "contact", id }`), never a person: every Action and query stays
  shut to it unless it says otherwise (`peopleOrContacts`, as `chat.send` does). Its chat lives in
  the line's space and is shared with it on its own: it reaches that chat, what's said and filed
  there, and nothing else; the space's people reach it as any chat there, and the agent working for
  the contact reaches exactly that chat, never its agents' private steps. Agents are told whom
  they're talking with. The web interface's site chats (`webLines`, `web.<name>`) let a browser that
  isn't anyone in as a visitor, a contact once it speaks (see "Visitors").
- **`googleSignIn`**: sign-in with a Google ID token (the `google` resource names your client). Its
  routes: `POST /signin/google`, which Google's button posts its token to, sets the session's
  cookie; `GET /google` gives the page the client id for its button.
- **`emailSignIn`**: sign-in with an email and a password (with identity and `email`, the app's
  email port). Its routes are `GET /signin/email` (it's here, and whether people make accounts) and
  `POST /signin/email` with its steps under it, each that ends signed in setting the session's
  cookie.
  - **Making an account:** `email.sign-up` sends a six-digit code, the password hashed and waiting
    for it; `email.verify` with the code makes the person and signs in. An address that has an
    account gets a word saying so instead, with the same answer; a stranger signing up first with
    someone's address can't choose their password (each code confirms the password it came with).
    `emailSignIn.signUp: false` leaves only invitations.
  - **Signing in:** `email.sign-in`, refused with `unverified` (a new code sent) until the address
    is confirmed. A wrong password and an address nobody has are one refusal, as slow.
  - **A new password:** `email.forgot` sends a code (the same answer for any address); `email.reset`
    with it sets the password, ends the person's other sessions and signs in.
  - **Invitations:** trusted code (a webhook, once someone bought) calls `email.invite`: the person,
    answered at once, and a link working once for a day (`/#email-invite=<token>`, in the fragment,
    so no server logs it) where they choose a password and arrive signed in.
  - **Moving in:** `email.import` brings a person with the hash another app kept, as it is (legacy
    `salt:hash` hex, PBKDF2-SHA256 at 100,000), hashed again, stronger, at their first sign-in.
  - **Passwords** are PBKDF2-SHA256 on WebCrypto in six stages of 100,000 (workerd takes no more in
    one call): `pbkdf2-sha256$6x100000$<salt>$<hash>`, compared in constant time, a private field no
    event or actor's read holds. Codes and tokens are kept only as HMACs under the `links` secret,
    used once, codes for 15 minutes and five wrong tries. Messages to an address (5 an hour), tries
    at it (10 in 15 minutes) and one caller's asks (30) are limited (`emailSignIn.limits`).
  - **Its words** are the `emailSignIn` resource's `messages` (`verify`, `reset`, `invite`,
    `exists`: a subject, text and HTML with blanks such as `{code}`, `{link}`, `{app}`), English
    unless the app gives its own.
- **`email`**: the app's email port: `email.send` `{ to, subject, text, html? }` (trusted code's,
  unrecorded) sends through the adapter the `email` resource names: `resend` (Resend's API, its
  `apiKey`), or `console`, which writes each message to the log for a laptop (refused where the
  `links` origin is public). An adapter of your own is an `email` adapter (`EmailAdapter`).
- **`devSignIn`**: sign-in by name or email, from this machine only, for trying an app out
  (`/signin/dev`).
- **`accounts`**: outside accounts a person connects once, for their agents to use: first their
  ChatGPT plan, as a model provider, instead of the app's API key. Tokens are a private field only
  the plugin's Actions read, renewed before they run out. The provider sends the person back to its
  route (`GET /accounts/callback/<provider>`), which calls `account.callback` with plain data
  (`{ provider, code, state }`) as the session's person.
- **`directory`**: for an app serving many orgs (see "Many orgs behind one address" and
  [design/tenancy.md](design/tenancy.md)): who signs in, which orgs each belongs to, invitations to
  orgs, where each org lives, and platform staff. It runs in a runtime of its own, whose routes
  forward each request to its org's runtime; `directory.member(dir, org)` is what each org's runtime
  gets of it.

**`billing/`**: what was used, what it cost, what to charge.

- **`usage`** keeps a ledger of what was used, what it cost and what to charge for it.
  - **Every model call is recorded:** the models plugin tells whoever plugs into its `modelUse`
    resource what each call used, in the job that made it, and the ledger plugs in: it records the
    use (`ctx.record`, so no round trip of its own, kept even if the job fails), tagged with what it
    was for (thread, agent, turn, purpose) and the person it was for. Models know nothing of
    billing; billing builds on models. An app records its own uses with `usage.record`.
  - **Rated as recorded,** so a record keeps what applied. Cost comes from `resources.cost` (the
    app's rates: negotiated, a subscription at 0, compute by the second), else from the catalog's
    prices (each kind of token at its own: input, cache reads and writes, output, reasoning). The
    price is the cost, a margin of 0, unless `resources.price` says otherwise: rates of its own, or
    a gross margin on the cost (`{ "*": { margin: 0.2 }, "cloud/*": { margin: 0.9 } }`: 0.9 is ten
    times the cost). Rates are keyed by subject, then `provider/*`, then the catalog, then `*`, and
    dated lists apply each rate from its `since`, so a new margin applies from its date on. Each
    record keeps its cost and price by part too, and what caching saved. A use nothing prices is
    kept and flagged `unpriced`.
  - **People see prices** (what they're charged); costs, and so margins, only platform staff and the
    system.
  - **Totals** by any field or tag, summed by the store (`aggregate`) over indexed fields (time,
    meter, subject, thread; more from the app:
    `collections: { usage: { indexes: [["tags.tenant", "at"]] } }`):
    `runtime.query("usage.totals", { filter, by: ["day", "tags.agent"] })`. A person asking gets
    their own usage only; the system, everyone's.
  - **Rollups:** a schedule closes each UTC day at 00:10 (`usage.close`), rolling its records up
    into one document per group of meter, subject and the dimensions (`tags.agent`, `tags.purpose`;
    more with `resources: { usage: { rollups: { dimensions } } }`). Totals then read whole closed
    days from the rollups and only the rest from the records. Each close counts the last 7 closed
    days again and closes again any whose records came late; `usage.close { from }` closes again
    from an older day. `schedules: { "usage.close": null }` turns them off.
  - **Re-rating** (`usage.rerate`) never changes a record: it appends adjustments, dated when made,
    and totals follow.
  - **Categories:** each meter is one (`llm`, `embeddings`, `transcription` and `image` are agents',
    `computer` computers', `app` apps'; any other its own); totals group and filter by `category`,
    and rollups serve it. Rollups keep `tags.space` too; days rolled up in another shape are closed
    again, and read from records until then.
  - **Across an org:** `usage.org` (totals, naming what they're grouped by as the caller reaches it)
    and `usage.activity` (agents' turns, computers' sessions, apps' days and conversations' upkeep,
    newest first): owners and admins see everyone's, anyone else their own. What a tag points to is
    named by the plugin that owns it, in the `usageNames` resource kind
    (`{ tag: "tags.app", collection: "app", field: "name" }`); a tag nobody names shows as its id.
  - **On the web** (`usageWeb`): an org's Usage page: the billing month's spend against the budget
    and credits left (from the credits plugin, when it's there) and the same point last month; a
    daily chart and a ranked list by kind, space, person, agent or model, whose rows filter the
    page; and activity. Staff see cost and margin in place.

**`compute/`**: **`computers`**, machines people connect (the computer program in
`computers/program/`, a worker of the plugin's `computer` kind) and their desks, one per space
they're in, shared with its members. Agents there get a terminal, background jobs, files, a browser
(hidden, or shown on its screen for you to watch or step in) and web search, each agent with its own
shell, jobs and browser, in a folder of the space under `~/Copilotz`. A computer is its owner's;
shared into another space, every member's agents use it too (it runs their commands as its owner, on
that machine: share one you mean to). Commands, jobs and writes wait for a yes, from the person the
agent works for (or, if its owner says so, from the owner).

**`work/`**: **`boards`** and **`documents`**, what a space's people and agents make together. Both
live in spaces (read where the space is read, changed where it's written), change only through their
Actions, and give agents tools wherever a conversation is in a space. Boards are kanban: columns in
order (a new one starts with Backlog, To do, Doing, Blocked, In review and Done), cards dragged
within and across them, owners, labels and due dates; the tools are `list_boards`, `read_board`,
`create_board`, `create_card`, `update_card` and `move_card`. Documents are Markdown where every
save is a version (who, what, when), a save that started from an old version is merged line by line
or refused as a `conflict` for the person to settle, an old version comes back as a new one, and who
has one open is live; the tools are `list_documents`, `read_document`, `write_document`,
`append_document` and `edit_document`. Their front ends (`boardsWeb`, `documentsWeb`) add a Board
and a Documents tab to a space, a page for each, palette entries and cards for the tools' calls in a
chat. The app words the one line about agents on an empty Board tab
(`boardsText: { agentHint: "…" }`, a resource).

**`interfaces/`**: how people reach the runtime. The terminal's data (`terminalPlugin`: where each
person is, what their commands printed) and its shell (`terminalShell`), and the web shell
(`webShell`: the sidebar, the main area by address, the side panel and the command palette, each
filled by the front ends through resources).

- **`api`**: developer keys. A person makes a key in a space, for the Actions, queries, Views and
  collections it may use there (its scope; every key has one); code then calls the runtime's REST
  API (`/api/`) or its socket with it (`Authorization: Bearer <key>`, which the plugin's `who`
  reads), as that person, in that space only. A key is a member of its space (`key:<id>`), where its
  managers see and revoke it.
- **`whatsapp`**: people talk to their agents from WhatsApp, through Meta's Cloud API. A space's
  managers connect a number; a person links their phone with a code; what they send becomes their
  messages, and what agents say to them goes back, a long answer in several messages. Meta's webhook
  is its route, `/hooks/whatsapp/<name>`: it checks the signature, then hands the delivery to
  `whatsapp.receive` as plain data. It has Views of its own (`whatsapp.message`, parts built with
  its toolkit: text, buttons, a list, a carousel, an image, a document, each checked against Meta's
  limits): after an answer, features show more (`additions`: a carousel of trips, buttons to pay),
  once per chat per key, the answer's text in the same message when there's room, a fallback when
  Meta refuses one; taps come back with their ids. Pictures and files go as public links, signed
  links to the app's routes or files (the `links` resource, `{ origin, secret }`; the runtime's
  `signLink`, `verifyLink`), or uploads. Opened to anyone (`whatsapp.set`, or declared in the app's
  settings: `whatsapp.<name>`), a number is open to customers: a stranger who writes is a contact,
  in a chat of their own in the number's space, answered by its agent, and a chat quiet for the
  number's `gap` (12 hours) is over: their next message starts a new one.
- **`voice`**: people call the app's phone number and talk to its agents, through Twilio's
  ConversationRelay (Twilio hears them and speaks; the app gets and sends text). The app declares
  its numbers (`voice.<name>`: the space, Twilio's account and auth token, the app's public address,
  the agent, language, voice, greeting and limits); Twilio's webhook is checked against its
  signature, a call is taken within its caller's limits and the number's (calls at once, a day: else
  busy, nothing spent) and opens the number's socket with a one-time ticket. A caller is a contact
  in a chat of their own, the same one when they call back only if Twilio verified their number;
  what the agent writes for them is said as it writes it (`voice.message`, a View), a caller
  speaking over it cuts it there (the agent is told what was heard), a failed or slow answer says a
  short sentence in the number's language, and silence, a call too long or too many prompts, or the
  agent's `end_call` end it. Managers block a caller (`voice.block`). Its routes are Twilio's
  webhook (`/hooks/voice/<name>`) and the call's socket (`/hooks/voice/<name>/relay`), which
  `listen` and `Deno.serve(runtime.fetch)` carry.
- **`mcp`**: models outside the app (ChatGPT, Claude, any MCP client) call its tools. A server the
  app declares (`mcp.<name>`: its space, the tools it lists, each with its `tool:<name>` View, how
  each is shown, who calls, its limits) is an MCP server at `POST /mcp/<name>`: Streamable HTTP,
  JSON-RPC 2.0, no session, MCP 2026-07-28 and the versions with a handshake. Each conversation
  (ChatGPT's `openai/session`, or a `chat` handle the app gives a client that names none) is a
  contact in a chat of its own in the server's space, its ids an HMAC with the `links` secret. A
  call runs the tool through chat's runner as that contact, is written there as a step, and answers
  what the app's agents read of it (only public errors say their words); a request sent again to a
  tool that changes things is answered from the first, and the server's limits (calls at once, a
  minute, new conversations an hour, by conversation, user, caller's address and in all) refuse the
  rest. **Widgets** (MCP Apps, ChatGPT's Apps SDK): a tool's calls shown through a web View of the
  app's (`tools.<name>.widget`), drawn inside the assistant by the widget host
  (`copilotz/web/widget`) in a template made from the app's `widgets` resource
  (`widgets: widgetsOf({ code, plugins })`, from `copilotz/web/server`), seeded with what the View
  reads, answered on the server as the conversation's contact (its first paint asks nothing). What
  only widgets call (`visibility: ["app"]`, or an Action: `{ action }`, a person's tap or form) is
  refused without the widget's grant, which only results' `_meta` carry (never what the model
  reads); the widget's reads go through the line's `copilotz_read`, queries only. One View serves
  the web and the widget: `surface()`, `display(mode)`, `remind(text)`… from `copilotz/web` are
  no-ops on the page, and the display mode is the View's `hints.mode`.
- **`maintenance`**: HTTP for an app's operators when they can't reach its database, with one key:
  read SQL, the collections' operations through the owner, raw SQL writes inside it, blobs by id
  (see [Maintenance](#maintenance)).

**Metrics** (`copilotz/exporters`): what the runtime and plugins do, measured. There's no plugin to
add: each plugin instruments itself.

- In OpenTelemetry's model: counters, histograms and gauges, aggregated in the process
  (`createMetrics`, web standards only) and exported as OTLP/HTTP JSON (`otlp({ url })`) or
  Prometheus text (serve `exposition(meter)` at `/metrics`). The host makes the meter and passes it
  to `createRuntime({ metrics })` (and to remote executors); plugin code records with `ctx.metrics`.
  Recorded:
  - the runtime: `copilotz.job.duration` (by kind, name, outcome), `copilotz.op.duration` and
    `copilotz.op.roundtrip`, `copilotz.commit.duration`, `copilotz.transaction.duration` (how long
    each transaction held open kept the writer, by outcome), `copilotz.events`,
    `copilotz.processor.lag`, `copilotz.executors`, `copilotz.cache.reads`;
  - model calls, by OpenTelemetry's GenAI conventions: `gen_ai.client.operation.duration`,
    `gen_ai.client.token.usage`, and `copilotz.llm.time_to_first_token`;
  - the ledger: `copilotz.usage.cost` and `copilotz.usage.price`.
- Metrics are for dashboards and alerts; the ledger stays the record for billing. A collector that's
  down is logged and never fails the runtime.
