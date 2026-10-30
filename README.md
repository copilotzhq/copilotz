# Copilotz

[![npm](https://img.shields.io/npm/v/copilotz?label=npm)](https://www.npmjs.com/package/copilotz)
[![JSR](https://jsr.io/badges/@copilotz/copilotz)](https://jsr.io/@copilotz/copilotz)

One runtime for agents and the apps around them, on Node, Deno, Bun, Cloudflare Workers and the
browser.

An app is plugins: agents that answer with tools and talk to each other and to people, conversations
in shared spaces, memory, skills and routines, a usage ledger, people's computers, sign-in and
connected accounts, a developer API, WhatsApp. Each is a plain object built from the same few
primitives (collections, Actions, Processors, Views, resources and adapters), and the runtime knows
nothing else. Everything durable is an event, a document, an edge, a vector or a blob, written by
one owner to one store (memory, SQLite or PostgreSQL), so every change is on the record and every
screen follows it live: in a terminal, in a browser, or in an agent's prompt.

## Install

```sh
npm install copilotz                 # Node 24+ (npm, pnpm, yarn)
bun add copilotz                     # Bun
deno add jsr:@copilotz/copilotz      # Deno (or `deno add npm:copilotz`)
```

On Deno, name it `copilotz` in `deno.json` (`"copilotz": "jsr:@copilotz/copilotz@^1.0.0-rc.3"`), and
the imports below are the same everywhere. Some pieces need a package of their own, installed beside
it: `esbuild` to bundle the web host on Node, `@electric-sql/pglite` for PostgreSQL in the process,
and `@types/react` for the front ends' types.

## A first app

```ts
import { createRuntime, definePlugin } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { models } from "copilotz/plugins/models";
import { chat, type Message, tool } from "copilotz/plugins/agents";

// An app's own plugin is plain objects: a provider, an agent, a tool.
const app = definePlugin({
  name: "app",
  resources: {
    provider: { openai: { apiKey: process.env.OPENAI_API_KEY } },
    // "fake/echo" runs offline (it calls a tool you name); "openai/gpt-5.4-mini" with the key.
    agents: { assistant: { instructions: "Be brief.", model: "fake/echo", tools: ["clock"] } },
    tools: { clock: tool({ description: "The time now.", run: () => new Date().toString() }) },
  },
});

const runtime = await createRuntime({ store: memoryStore(), plugins: [models, chat, app] });
const { thread } = await runtime.call<{ thread: string }>("chat.send", {
  text: "What does the clock say?",
});
await runtime.idle();
for (const { from, text } of await runtime.query<Message[]>("message.history", { thread })) {
  if (text) console.log(`${from}: ${text}`);
}
await runtime.close();
```

`node app.ts` (or `bun app.ts`, `deno run -A app.ts`) prints the question and the agent's answer.
Swap `memoryStore()` for `sqliteStore({ path })` or `postgresStore({ url })` to keep it, add
`history` and `memory` to the plugins for long conversations and recall across them, `access` for
people and spaces, and serve it to browsers with the web host (below).

## The primitives

The runtime knows only these, and plugins are made of them:

- **Collections:** documents with a JSON Schema, read and written with the MongoDB collection API
  (`ctx.db.collection("note").insertOne(…)`, `find`, `updateOne` with `$set`…), with named queries,
  vector fields and indexes. Every write records an event in the same commit.
- **Actions:** what can be done, with a JSON Schema input and an `allow(actor, input)` saying who
  may call them. Every call is on the record (`action.started`, `action.completed`), retryable by
  id, and everything it causes is its caller's.
- **Processors:** what happens when events happen: ordered per key, at least once, from a durable
  cursor, idempotent by deterministic ids.
- **Views:** a plugin's front end, per medium: text for `llm` (the agents' prompt is a View), Ink
  elements for `terminal`, React for `web`. Observed Views run again when what they read changes.
- **Resources:** configuration as named plain objects, by kind (`agents`, `tools`, `provider`,
  `theme`…): a later plugin patches an earlier one's (JSON Merge Patch), so an app changes one
  agent's `effort` without redefining it.
- **Adapters:** implementations of a port, by name: a model provider's protocol (`openai`,
  `anthropic`…), an embeddings or transcription service.

Plugins reach each other only through the runtime, by name: Actions, resource kinds and declared
events. Time is a caller too: schedules call Actions (see Schedules).

## Using it

The package's entry points, the same names on npm (`copilotz/…`) and JSR (`@copilotz/copilotz/…`):

| Import                                 | What it has                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `copilotz`                             | the runtime: `createRuntime`, `definePlugin`, `defineCollection`, `defineAction`…                            |
| `copilotz/stores/memory`               | `memoryStore()`: in memory, the reference                                                                    |
| `copilotz/stores/sqlite`               | `sqliteStore({ path })`: `node:sqlite` or `bun:sqlite`, one file                                             |
| `copilotz/stores/postgres`             | `postgresStore({ url, schema, tenant })` (a server, or PGlite in the process), `postgresPool`, `copyTenant`… |
| `copilotz/stores/latency`              | `withLatency(store, ms)`: a store with round trips, to measure                                               |
| `copilotz/blobs/files`                 | `fileBlobs({ dir })`: blobs as files                                                                         |
| `copilotz/blobs/http`                  | `httpBlobs({ url, headers })`: blobs in a bucket (S3, GCS, R2…)                                              |
| `copilotz/plugins/models`              | `models`: llm, embeddings, transcription, the models.dev catalog                                             |
| `copilotz/plugins/agents`              | `chat`, `history`, `memory`, `memoryExtraction`, `team`, `skills`, `routines`, `tool`                        |
| `copilotz/plugins/agents/web`          | their web front ends: `chatWeb`, `teamWeb`, `memoryWeb`, `skillsWeb`, `routinesWeb`                          |
| `copilotz/plugins/agents/terminal`     | their terminal front ends: `chatTerminal`, `memoryTerminal`                                                  |
| `copilotz/plugins/access`              | `access` (`spaces`, `identity`), `accounts`, `directory`, `googleSignIn`                                     |
| `copilotz/plugins/access/web`          | `spacesWeb`, `accountsWeb`                                                                                   |
| `copilotz/plugins/access/terminal`     | `accessTerminal`                                                                                             |
| `copilotz/plugins/billing`             | `usage`: the ledger                                                                                          |
| `copilotz/plugins/billing/web`         | `usageWeb`                                                                                                   |
| `copilotz/plugins/billing/terminal`    | `usageTerminal`                                                                                              |
| `copilotz/plugins/compute`             | `computers`: people's computers, where agents work                                                           |
| `copilotz/plugins/compute/web`         | `computersWeb`                                                                                               |
| `copilotz/plugins/compute/terminal`    | `computersTerminal`                                                                                          |
| `copilotz/plugins/compute/downloads`   | `computerDownloads`: the computer program's release, served by the app (Node)                                |
| `copilotz/plugins/interfaces`          | `terminalPlugin` (the terminal's data), `api`, `whatsapp`                                                    |
| `copilotz/plugins/interfaces/web`      | `webShell` (the web's root View), `apiWeb`, `whatsappWeb`                                                    |
| `copilotz/plugins/interfaces/terminal` | `terminalShell`: the terminal's root View                                                                    |
| `copilotz/web`                         | the web host in the browser (`web`), and its toolkit (`Button`, `Markdown`…)                                 |
| `copilotz/web/server`                  | its server half: `webServer`, `socket`                                                                       |
| `copilotz/web/tickets`                 | `createTickets`: sessions traded for one-time tickets                                                        |
| `copilotz/web/theme`                   | `themeOf(plugins)`: the app's theme, for the page's first paint                                              |
| `copilotz/web/node`                    | `bundle` (the browser's code, with esbuild), `serve`, `listen` (HTTP, sockets)                               |
| `copilotz/orgs`                        | `orgsHost`: many orgs behind one address, each a runtime of its own                                          |
| `copilotz/terminal`                    | the terminal host: `terminal({ runtime, me })`, and its toolkit                                              |
| `copilotz/exporters`                   | `otlp`, `exposition`: metrics out, the OpenTelemetry way                                                     |
| `copilotz/testing`                     | one test API for Deno, Node and Bun (`test`, `tempDir`, `serve`…)                                            |

The browser loads only `copilotz/web`, the `…/web` front ends and what they import; every other
entry point is for the process that runs the runtime (or the terminal). The npm package is
JavaScript with its types beside it, so an app's bundler takes the front ends as they are.

## Serve it on the web

The web host runs the app's front ends in the browser, as the person signed in: their reads go to
the owner under the access rules, and every change is pushed to them as it commits. The server half
answers `Request`s with `Response`s and nothing else, so it runs on any runtime; the page's code is
the app's own (its front ends), bundled. On Node:

```ts
// server.ts
import { createRuntime } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { socket } from "copilotz/web/server";
import { createTickets } from "copilotz/web/tickets";
import { themeOf } from "copilotz/web/theme";
import { bundle, serve } from "copilotz/web/node";
import { plugins } from "./app.ts"; // models, chat, access, … and the app's own

const tickets = createTickets();
const runtime = await createRuntime({
  store: memoryStore(),
  plugins,
  transports: [socket], // browsers connect to the owner here
  admit: tickets.admit,
});
const server = await serve({
  runtime,
  tickets,
  code: await bundle(new URL("./browser.tsx", import.meta.url)),
  theme: themeOf([]), // Copilotz's look; a brand passes its theme plugins
  port: 8080,
  dev: true, // sign in by name, from this machine only
});
console.log(`${server.url}`);
```

```tsx
// browser.tsx
import { web } from "copilotz/web";
import { webShell } from "copilotz/plugins/interfaces/web";
import { chatWeb, memoryWeb, teamWeb } from "copilotz/plugins/agents/web";
import { spacesWeb } from "copilotz/plugins/access/web";

await web({
  root: document.getElementById("app")!,
  plugins: [webShell, chatWeb, spacesWeb, teamWeb, memoryWeb],
  start: async (client) => ({
    space: (await client.call<{ space: string }>("space.personal", {})).space,
  }),
});
```

`bundle` splits the code where it imports lazily (math, a terminal), and `serve` takes browsers'
sockets through Oxian's Node adapter; Bun and Deno run it too. On Deno,
`Deno.serve(webServer({ …, upgrade: handler(runtime.hypervisor) }))` with Oxian's Deno adapter, and
`deno bundle` for the code (`examples/terminal-agent/web.ts`). The whole example is in
`examples/web-node/` (`node examples/web-node/server.ts`).

Many orgs behind one address (`copilotz/orgs`, see [design/tenancy.md](design/tenancy.md)): a
directory signs people in and knows their orgs, and each org is a runtime of its own, opened when
first used. Node takes a socket before any handler runs, so `listen` serves the orgs host and hands
each socket to the runtime of the org its request is for:
`listen({ fetch: host.serve, hypervisor: (request) => host.openRuntime(request)?.hypervisor })`
(`examples/web-node/orgs.ts`).

## Installing a computer

People's computers run the computer program (`plugins/compute/computers/program/`), a single
executable for macOS, Linux and Windows. Each Copilotz release on GitHub has it (`v<version>`: a
binary per platform, `install.sh`, `install.ps1`, and `manifest.json` with their sizes and SHA-256),
and an app serves it from there by default:

```ts
import { computerDownloads } from "copilotz/plugins/compute/downloads";

plugins: [...plugins, await computerDownloads()], // this Copilotz's release
plugins: [...plugins, await computerDownloads({ dir: "dist/computer/1.0.0-rc.3" })], // its own: /computer/download/
plugins: [...plugins, await computerDownloads({ url: "https://downloads.example.com/computer/" })], // or elsewhere
```

The publish workflow makes it when a `v1.*` tag is pushed, on a Mac (the macOS binaries are signed
there). A release whose program is the same as the last one's (`source` in the manifest: a hash of
its code, without its version, its install scripts and the Bun that builds it) has that release's
binaries, version and all, so computers don't update to what they have. To build one yourself:

```sh
node scripts/computer/build.ts                 # dist/computer/<version>/
node scripts/computer/build.ts --reuse <url>   # that release's, when it's the same program
```

A space's Computer tab (or `/computer connect`) then gives the one line to run on the machine, for
its system, with a one-time code in it (and the binaries, to download instead):

```sh
curl -fsSL https://app.example.com/computer/download/install.sh | sh -s -- https://app.example.com --code K7Q-4MZ
```

```powershell
& ([scriptblock]::Create((irm https://app.example.com/computer/download/install.ps1))) https://app.example.com -Code K7Q-4MZ
```

It downloads that machine's binary, checks its SHA-256 against the release's manifest, puts it in
`~/.copilotz/bin` (`%LOCALAPPDATA%\Copilotz\bin`) on the PATH, connects it with the code, and keeps
it running from login on: a launchd agent on macOS, a systemd user unit on Linux, a scheduled task
on Windows. On that machine, `computer uninstall` stops it (`computer install` starts it again),
`computer forget` forgets it, and `computer run` runs it in the foreground instead. Its commands run
in bash, or on Windows in PowerShell (7 when it's there, else 5.1); agents are told which. A
computer older than the app's release updates itself as it connects: the app tells it the version,
and its binary's URL, size and SHA-256; it checks them, and that the new one runs, swaps it in and
starts again. The binaries aren't signed yet, so macOS and Windows warn about one downloaded with a
browser; the line doesn't need that.

One machine can serve several apps, or several orgs of one: run the line from each, and each is a
computer of its own there, in one program. Each one's spaces go in a folder of its own under
`~/Copilotz`, named for the org (the line from an org says it: `--folder acme`), else for the app's
host. `computer list` says which and where; `computer disconnect <app-url>` leaves one.

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
`processors/`, `views/`, `resources/`, `adapters/`, one file per declaration, with `shared/` for
what several use; its `mod.ts` only assembles them. Its front ends are its own (`web.tsx`,
`terminal.ts`), loaded only where they draw, and the theme gathers them (`plugins/agents/web.tsx`).
Tests sit next to their theme (`plugins/<theme>/tests/`).

**A plugin reaches another only through the runtime, by name**, in three ways:

- **ask it to do something:** its Actions (`ctx.call("llm.stream", …)`);
- **plug into it:** the resource kinds it reads (chat's `tools` and `context`, models' `modelUse`,
  the terminal's `commands`, the web host's `routes`);
- **hear what it announces:** its declared events, with Processors (`message.created`,
  `turn.requested`).

A plugin that builds on another (memory and history on chat, chat on models, Google sign-in on
identity) says so (`requires: ["chat"]`), and imports from it only its `contract.ts`: the shapes of
its documents and resource kinds, its Actions' inputs and outputs, and declaration helpers such as
chat's `tool()`. Never its code. Plugins that would share code are one plugin (`models`).

**`models/`**: talking to models, one plugin (`models`) for three kinds. Other plugins call it by
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
- **`models.check`** says what's wrong with a model for a port (other plugins' startup checks ask
  it); **`models.price`** says what the catalog says a model costs (the usage ledger asks it).
- These are unrecorded Actions: called from a job they run inline (no events, no commit of their
  own), and queries, Views and startup checks may call them too, read-only.

**`agents/`**: conversations and the agents in them.

- **`chat`**: threads, messages, and agents
  (`{ instructions, model, effort?, maxTokens?, temperature?, tools? }`) that answer with tools,
  calling models through `llm`. A reasoning model's thinking (its provider state) is kept on the
  agent's tool steps and goes back to that model while its turn goes on.
  - **Several agents** take turns in parallel. With `send_message` an agent messages another agent
    or a person, and waits for the replies before it continues.
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
    document whose data the owner keeps as a blob. Agents read a text file's content, are shown
    images and PDFs when their model reads them (the latest 8; the catalog says which models do, or
    the model choice's `input: ["image"]`, and the others are told what they can't see), and see
    anything else by name.
  - **Audio:** `chat.send` transcribes audio before anything is sent (`chat.transcriber`, by default
    the `transcribe` model alias), and agents read the transcript. If it fails nothing is sent
    (`transcription_failed`); `transcribe: false` sends audio as it is. A voice message may say
    nothing else; its file carries `voice` (duration, peaks) for its player.
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
    turn.
  - **Tools for every agent:** `remember` (which updates what it repeats instead of duplicating it),
    `recall` and `forget`.
  - **On its own:** with an `extractor` model, every few messages it writes down what's worth
    keeping (who people are, preferences, decisions), updating what it already knew.
- **`team`**: agents people make in a space, beside the app's, each a member of the spaces it works
  in, with a page of its own on the web.
- **`skills`**: know-how an agent reads only when a task calls for it (a SKILL.md: a name, when it's
  for, instructions, files beside). The app's are a `skills` resource; a space's managers make their
  own. Each turn lists the names and purposes of the skills an agent has there, and `read_skill`
  reads one. Built on chat's `context` and tools, so chat pays nothing without it.
- **`routines`**: a message sent to an agent on a schedule, in a space ("every weekday at 9:00, ask
  @researcher for the news"), as whoever made it, reaching only what they reach; each run's chat and
  outcome are kept. Agents make them from a conversation too (`schedule_routine`).

**`access/`**: who can see and do what (see [design/access.md](design/access.md)).

- **`spaces`**: shared spaces, Personal spaces and single shared documents, with members (people,
  agents, other spaces) and roles; collections named in the `shared` resource keep to what each
  actor reaches. People join by accepting an invitation to the email they signed in with; sending
  one never says whether the address has an account. Agents are members too, each working only where
  it's one; a new space has the app's default agents. An answer drawn from a space not everyone in
  the conversation can see shows only to those who see both, marked, until someone shares it.
- **`identity`**: people, sessions and keys, and who a secret proves.
- **`googleSignIn`**: sign-in with a Google ID token (the `google` resource names your client).
- **`accounts`**: outside accounts a person connects once, for their agents to use: first their
  ChatGPT plan, as a model provider, instead of the app's API key. Tokens are a private field only
  the plugin's Actions read, renewed before they run out.
- **`directory`**: for an app serving many orgs (`copilotz/orgs`, see
  [design/tenancy.md](design/tenancy.md)): who signs in, which orgs each belongs to, invitations to
  orgs, where each org lives, and platform staff. It runs in a runtime of its own.

**`billing/`**: what was used, what it cost, what to charge.

- **`usage`** keeps a ledger of what was used, what it cost and what to charge for it.
  - **Every model call is recorded:** the models plugin tells whoever plugs into its `modelUse`
    resource what each call used, in the job that made it, and the ledger plugs in: it records the
    use (`ctx.record`, so no round trip of its own, kept even if the job fails), tagged with what it
    was for (thread, agent, turn, purpose) and the person it was for. Models know nothing of
    billing; billing builds on models. An app records its own uses with `usage.record`.
  - **Rated as recorded,** so a record keeps what applied. Cost comes from `resources.cost` (the
    app's rates: negotiated, a subscription at 0, compute by the second), else from the catalog's
    prices; price comes from `resources.price` only (rates of its own, or a `markup` on cost). Rates
    are keyed by subject, then `provider/*`, then the catalog, then `*`, and dated lists apply each
    rate from its `since`. A use nothing prices is kept and flagged `unpriced`.
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
  - **On the web** (`usageWeb`): an org's Usage page, day by day and against the period before, by
    person, agent and model; owners and admins see everyone's, anyone else their own.

**`compute/`**: **`computers`**, machines people connect (the computer program in
`computers/program/`, a worker of the plugin's `computer` kind) and their desks, one per space
they're in, shared with its members. Agents there get a terminal, background jobs, files, a browser
(hidden, or shown on its screen for you to watch or step in) and web search, each agent with its own
shell, jobs and browser, in a folder of the space under `~/Copilotz`. A computer is its owner's;
shared into another space, every member's agents use it too (it runs their commands as its owner, on
that machine: share one you mean to). Commands, jobs and writes wait for a yes, from the person the
agent works for (or, if its owner says so, from the owner).

**`interfaces/`**: how people reach the runtime. The terminal's data (`terminalPlugin`: where each
person is, what their commands printed) and its shell (`terminalShell`), and the web shell
(`webShell`: the sidebar, the main area by address, the side panel and the command palette, each
filled by the front ends through resources).

- **`api`**: the developer API. A person makes a key in a space, for the Actions, queries and Views
  it may use there; code then calls them over HTTP under `/api/`, and follows what happens as
  server-sent events, as that person, in that space only.
- **`whatsapp`**: people talk to their agents from WhatsApp, through Meta's Cloud API. A space's
  managers connect a number; a person links their phone with a code; what they send becomes their
  messages, and what agents say to them goes back, a long answer in several messages.

**Metrics** (`copilotz/exporters`): what the runtime and plugins do, measured. There's no plugin to
add: each plugin instruments itself.

- In OpenTelemetry's model: counters, histograms and gauges, aggregated in the process
  (`createMetrics`, web standards only) and exported as OTLP/HTTP JSON (`otlp({ url })`) or
  Prometheus text (serve `exposition(meter)` at `/metrics`). The host makes the meter and passes it
  to `createRuntime({ metrics })` (and to remote executors); plugin code records with `ctx.metrics`.
  Recorded:
  - the runtime: `copilotz.job.duration` (by kind, name, outcome), `copilotz.op.duration` and
    `copilotz.op.roundtrip`, `copilotz.commit.duration`, `copilotz.events`,
    `copilotz.processor.lag`, `copilotz.executors`, `copilotz.cache.reads`;
  - model calls, by OpenTelemetry's GenAI conventions: `gen_ai.client.operation.duration`,
    `gen_ai.client.token.usage`, and `copilotz.llm.time_to_first_token`;
  - the ledger: `copilotz.usage.cost` and `copilotz.usage.price`.
- Metrics are for dashboards and alerts; the ledger stays the record for billing. A collector that's
  down is logged and never fails the runtime.

### Models and providers

A model is `"provider/model"`, with the settings to call it with next to it:

```ts
resources: {
  provider: {
    openai: { apiKey },                       // the catalog knows its protocol and URL
    deepseek: { apiKey },                     // OpenAI-compatible, at api.deepseek.com
    local: { adapter: "openai-compatible", baseURL: "http://localhost:11434/v1" },
    chatgpt: { adapter: "openai", catalog: "openai", headers: () => oauthHeaders() },
  },
  model: { cheap: { model: "openai/gpt-5.4-mini", effort: "low" } },   // optional aliases
  agents: {
    lead: { instructions, model: "openai/gpt-6.1-sol", effort: "low" },
    // A list is tried in order when a model fails before writing anything.
    north: { instructions, model: ["chatgpt/gpt-6.1-sol", "anthropic/claude-opus-5-5"], effort: "low" },
  },
  history: { summarizer: "cheap" },
  memory: { embedder: { model: "openai/text-embedding-3-small", dimensions: 512 }, extractor: "cheap" },
}
```

- **A `provider` resource** is an account or an endpoint: `baseURL` (where), `apiKey` (the
  provider's usual auth header), `headers` (added last, so they can replace the auth; a function
  computes them per request, for OAuth), `adapter` (the protocol) and `catalog` (whose catalog
  entries its models use; its own name by default, `false` for none).
- **The catalog** (`plugins/models/shared/catalog.json`, from [models.dev](https://models.dev),
  refreshed weekly) fills in what a provider leaves out: its protocol and URL for 232 providers, and
  for 8,947 models their prices, how their reasoning is controlled and their limits.
- **Settings** sit next to a model, per port: `effort`, `maxTokens`, `temperature` for llm,
  `dimensions` for embeddings, and `options` (into the request as they are) for all. Settings where
  a model is used win over an alias's; a list entry's win over its list's.
- **`effort`** is one scale for every provider (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
  `max`), mapped to OpenAI's `reasoning.effort`, Anthropic's adaptive thinking or thinking budget,
  Gemini's thinking level or budget. A level a model doesn't take stops the runtime from starting,
  with the levels it does take; a model the catalog doesn't know is left to its provider.
- **Checked at startup:** chat checks every agent's model, memory its embedder and extractor, so a
  missing provider, an unknown protocol or a wrong effort fails `createRuntime`, not a turn.

Action inputs name models and never carry keys, because Action inputs are recorded in events. Any
plugin can add its own adapter under `adapters.llm`, `adapters.embeddings` or
`adapters.transcription`, named by the protocol it speaks.

`plugins/models/tests/providers.test.ts` checks each adapter against a local server speaking that
provider's API; `plugins/models/tests/live.test.ts` runs against the real APIs when
`COPILOTZ_LIVE=1` and the provider's key are set.

## Stores

`memory` (the reference), `sqlite` and `postgres`, with the same MongoDB semantics in all three and
one conformance suite (`stores/tests/`). [`stores/README.md`](stores/README.md) describes each one
and lists exactly which parts of the MongoDB collection API they support, and how. A PostgreSQL
store holds one tenant (an org): many share a schema, each kept apart by the store itself, and an
org's rows copy elsewhere unchanged (`copyTenant`). Blobs (strings over 16 KiB, files people send)
live in the store by default, or as files (`fileBlobs`) or in a bucket (`httpBlobs`).

## The example app

`examples/terminal-agent` is an app on all of it: an assistant and a researcher, notes in spaces,
computers, in the terminal or in a browser. From a clone of this repository:

```sh
deno task chat                                # fake model, in-memory store
deno task chat --screen                       # the whole screen; same Views
OPENAI_API_KEY=… deno task chat               # real model (MODEL=… to pick one)
deno task chat --rtt=1.74                     # simulate production DB round trips (ms)
deno task chat --sqlite                       # persist to .data/copilotz.sqlite (or --sqlite=path)
deno task chat --postgres=postgres://…        # persist to PostgreSQL (schema "copilotz")
deno task chat --executors=4                  # more executors in this process

deno task chat --listen=8787 --executors=0    # owner only; executors connect remotely…
deno task executor --port=8787                # …from other terminals (as many as you like)

deno task bench [--rtt=1.74] [--remote] [--sqlite | --postgres=URL]   # overhead per turn

deno task web [--sqlite]                      # the same app in a browser: http://localhost:8790
BRAND=harbor deno task web                    # …rebranded by one theme resource (/gallery: the toolkit)
node examples/web-node/server.ts              # a web app on Node: http://localhost:8080
```

You are a person to the runtime (`--as=ana`; `/as bob` hands the terminal to someone else): your
conversations live in your Personal space; `/space <name>` makes a shared space (new conversations
go there), `/invite <email> [role]` invites someone (`/invite agent:researcher viewer` lets an agent
in at once), `/spaces` and `/work <n>` move between them. `/agents` lists who works in a space (●
answers new chats), `/agent Maya: writes launch copy` makes one there (`@maya`), `/default maya` has
it answer new chats, `/remove agent:maya` takes it out. People join by accepting an invitation
(`/invitations`, `/accept <n>`; `--as=bob@example.com` is a person with that email).
`/file <path>
[message]` sends a file. `/computer connect` in a space gives the command that
connects a computer to it; `/approve once|thread|always|no` answers what agents wait on.

Inside the chat: `/new`, `/threads`, `/open <n>`, `/history`, `/memories`, `/usage [all]`,
`/metrics [name]` (with `OTEL_EXPORTER_OTLP_ENDPOINT` set, metrics also go to that collector),
`/prompt [agent]`, `/fork`, `/retry`, `/events [n]`, `/stats`, `/sql <query>` (SQLite only),
`/quit`. Every turn prints its time, its database round trips, the jobs sent to executors and the
calls they made back to the owner.

In the browser, you sign in by name or email (this machine only), or with Google when
`GOOGLE_CLIENT_ID` is set. Where you are is the address (`/thread/<id>`, `?in=<space>`), so links,
back and forward, and two tabs work. ⌘K (Ctrl+K) opens the command palette: go to any space, chat or
agent, make a space, a chat or an agent, invite someone, move this chat (or a memory, a note, a
computer) to another space, rename, archive or leave a space, each from the plugin it belongs to.
The composer also records voice messages.

### Developing Copilotz

```sh
deno task check                               # types, everywhere
deno task test                                # the suite (COPILOTZ_TEST_POSTGRES_URL adds PostgreSQL)
npm install && npm test                       # the same on Node 24 (the TypeScript as it is, not .tsx)
bun test --timeout 60000                      # and on Bun
npm run build                                 # the npm package, in dist/npm/
node scripts/npm/smoke.ts                     # …packed, installed in a new project, and used
deno publish --dry-run                        # the JSR package
```

Releases are tags: `v1.2.3` publishes to JSR and npm once the suite passes on every runtime
(`.github/workflows/publish.yml`). [CHANGELOG.md](CHANGELOG.md) says what each one changed.

## Events

The log records what happened, with no bookkeeping tables beside it:

- **Collection writes.** Every change to a declared collection records `<collection>.created`,
  `.updated` or `.deleted` in the same commit, with `{ _id, doc }` (the document after the write;
  the last version for a delete); updates also list the `changed` and `removed` fields. A write that
  changes nothing records nothing. A collection opts out with `events: false`; `sys.*` collections
  never record.
- **Action calls.** Each call records `action.started` `{ action, input }`, then `action.completed`
  `{ action, result }` or `action.failed` `{ action, error }`.
  - `started` costs no commit of its own: every write carries it until one commits, and the store
    keeps the first copy, so it lands in the action's earliest commit, ahead of all its effects. The
    completion is the only extra commit.
  - `started` records the call's own `startedAt`; `completed` and `failed` record its duration in
    `ms`. An event's `at` is its commit time. An action opts out with `record: false`.
- **Retries.** The log is the receipt store; no other table holds them.
  - `runtime.call(action, input, { id })` makes a call retryable. If that id already completed, the
    call returns its recorded result without running; if it's still running, the call joins it;
    otherwise it runs again as the next attempt, recording `action.retried`
    `{ attempt, after: "failed" | "lost" }`. Every action event carries its `attempt`.
  - **Id conflicts:** an id reused for a different action or input is refused with `id_conflict`.
    Calls are compared by `inputHash` (action + input with keys sorted), recorded in
    `action.started`. A call with an id reads the log once before running, to find its receipt.
  - **Executor loss:** if an executor dies mid-call, the owner records `action.failed`
    `{ code: "executor_lost" }`, with the call's start if that never committed.
  - **Nested calls:** a nested call's id comes from its cause, its place among the calls made under
    it, and its `inputHash`. When a delivery or call is retried, the calls it already completed
    answer from the log instead of running again; if the code now calls something different, that
    makes a new call.
  - **Processor deliveries:** every failed attempt records `processor.retried`
    `{ attempt, after, error }` before the next one. After the last attempt, `processor.failed`
    `{ attempts, error }` is the dead letter.
  - **Outside effects (payments, emails, outside APIs):** write the intent first, call out with its
    id as the idempotency key, then write the result. The intent's commit carries the call's start,
    so the attempt is on record before anything leaves the system.
- **Timers.** An occurrence is a call like any other, with an id of its own: `<timer>@<due time>`
  (see Schedules). A failed one runs again as that same call, recording `action.retried`.
- **Causes.** Every event names its cause: an action's writes, its `action.started`; a nested call,
  the outer call; a processor's writes, the event it handles. The log is a tree you can walk from
  any event back to the request that started it.
- **Blobs.** Strings over 16 KiB (configurable) are stored once, named by the hash of their content
  (`sha256-…`). Documents and events hold `{ $blob, size, type }` in their place. The owner moves
  values out on write and back in on read, so plugin code never sees a reference.

## Schedules

Time is a caller of Actions. There is no scheduler plugin and no job table: a timer is a document in
`sys.timers` naming an Action, its input and when to call it.

- **Declared:** a plugin declares recurring timers by name, by a cron expression (in a timezone, UTC
  by default) or every so long:

  ```ts
  schedules: {
    "usage.close": { cron: "10 0 * * *", call: "usage.close", input: {} },
    heartbeat: { every: "5m", call: "health.check" },
  }
  ```

  They merge like resources: a later plugin patches an entry (`{ every: null, cron: "0 * * * *" }`)
  or removes it with `null`. At start the owner makes the timers what the plugins declare: a changed
  one is reset, a removed one goes, and an unchanged one keeps its next time. A schedule calling an
  unknown Action, with input its Action refuses or a bad cron expression stops the runtime from
  starting.
- **From code:** `ctx.schedule(action, input, { at | cron | every, id?, retries? })` sets a timer
  with the call's writes (in a transaction, `tx.schedule` commits with the rest) and returns its id;
  `ctx.unschedule(id)` removes it. Scheduling an id again replaces its timer. Without an `id`, one
  comes from the call and its place among the timers it sets, so a retried call sets the same timers
  again rather than more. A declared timer can't be taken over from code.
- **One clock:** the owner keeps one wake armed for the earliest timer, re-armed as timer writes
  commit. When it rings, the owner claims what's due in one commit (a recurring timer moves to its
  next time, a one-off loses its time) and calls each occurrence's Action as the call
  `<timer>@<due time>`, so an occurrence called twice runs once.
- **Late, not twice:** a recurring timer that missed several times while nothing ran fires once,
  then keeps its beat (`every`) or its next match (`cron`).
- **Retries:** a failed occurrence comes back as a timer of its own, calling as the same occurrence
  after 10 s, 30 s, 90 s… up to `retries` (2) further attempts. A one-off goes once it succeeds or
  runs out of attempts; `action.failed` stays on record for Processors to answer.
- **Restarts:** occurrences a stop cut short run again as themselves when the owner starts (a
  finished one answers from the log), unless a retry is already waiting for them.
- **The clock is a port:** `createRuntime({ clock })`. The default uses the process's timers;
  `manualClock(start)` moves only when a test says so (`advance`, `set`); a host whose clock only
  rings, like a Durable Object's alarm, sets the alarm in `wake(at)` and calls `runtime.wake()` when
  it rings. `copilotz.timer.lateness` measures how late occurrences were called.

## Owner cache

The owner is the only writer, so every change passes through it, and what it caches is never stale:
documents by `_id` (filled by reads and by every committed write) and query results (`find` with
filter, sort and limit, and `count`). Each committed change updates the cached results with the
reference semantics, the same ones the store conformance suite holds every store to. When a change
can't be applied exactly, the query is dropped and the next read fetches it again: a sort key
changed, a limited result lost a member, or an existing document newly matched among ties.

- **Not cached:** queries with `skip`; queries that compare whole objects or arrays (key order
  differs between stores); reads inside a transaction, which see the transaction's own writes.
- **Freshness:** a read that raced a commit to its collection doesn't fill the cache, and a
  transaction's changes reach the cache only once committed, before its events go out.

`runtime/tests/cache.test.ts` checks every cached query against a direct store read after each of
900 random writes, on every store. `createRuntime({ cache: false })` turns the cache off; `stats()`
reports `hits` and `misses`.

## Topology

A runtime is one **owner** and its **executors**, composed with Oxian:

- **The owner** is the only holder of its store: it commits every write and sequences events,
  publishes events and live frames to subscribers, and schedules Processors (per-key lanes, cursors,
  retries).
- **Executors** run plugin code (Actions, Processor deliveries and queries) as Oxian work. They hold
  no store: each storage call is one op they send to the owner, and live frames ride the job's
  output stream back to it.
- **Same code, any placement.** By default both share one process over Oxian's in-process transport.
  Executors in other processes or machines connect over Oxian's WebSocket transport and present the
  owner's executor key.
- **Workers of a plugin's kind:** a plugin declares a kind of worker, a program that does its work
  but isn't plugin code (a computer running commands), as
  `workers: { computer: { admit, ready, gone, workloads } }`. It connects to the owner as executors
  do, presenting `<kind>:<secret>`; `admit` says who it is, and `ready` and `gone` hear it come and
  go. Plugin code sends it jobs with `ctx.workers.dispatch(kind, id, workload, input)` and reads its
  output as it comes (`ctx.workers.call` for one JSON answer); one that isn't connected fails with
  `offline`.
- **Browsers** connect the same way, as untrusted workers bound to the person signed in: they ask
  the owner for reads under the rules, and Actions.

Per turn with an instant model (`deno task bench`), a plain turn costs 4 database round trips, 2
jobs and 7 calls. Each in-process hop costs about 0.2 ms, and a loopback WebSocket hop about 0.4 ms.

## Runtimes

Copilotz runs on Node (first), Deno and Bun, and is built for Cloudflare Workers and the browser:

- **Library code uses web standards only:** fetch, streams, Web Crypto, `URL`, `AbortSignal`. What
  differs by runtime sits behind the runtime's ports: stores (`stores/`), blobs (`stores/blobs/`),
  and the transport and listener (Oxian, whose apps are fetch handlers and whose Hypervisor takes
  fetch-style upgrades; `copilotz/web/node` is the listener on Node).
- **Stores pick what the runtime has:** SQLite opens `node:sqlite` on Node and Deno, `bun:sqlite` on
  Bun, or any database with the same small API (`sqliteStore({ path, open })`, such as a Durable
  Object's); Postgres runs on Ominipg (a server, or PGlite); file blobs use `node:fs`.
- **Nothing reads the environment:** a host passes configuration in (`postgresStore({ trace })`).
- **One suite, three runners:** tests use `testing/mod.ts` (test, temp files, a local server, child
  processes, serving a Hypervisor) instead of a runtime's own APIs, and CI runs them on Deno, Node
  and Bun against PostgreSQL, and on Node on macOS and Windows. Front ends are `.tsx` (Ink, React):
  Deno and Bun run them as they are, Node from the npm package's JavaScript.
- **Published twice, from the same sources:** JSR takes the TypeScript; npm takes JavaScript with
  `.d.ts` beside it (`scripts/npm/build.ts`), with relative imports as `.js` and JSX compiled.

## Shape

- **The runtime knows only primitives:** plugins (`definePlugin`); Collections (JSON Schema, with
  named queries), Actions, Processors and Views; opaque Resources (named declarations by kind) and
  Adapters (port implementations). It never knows what a plugin is for.
- **Plugins merge in order.** Collections, Actions and Processors are unique. Resources are
  configuration: a later plugin patches an earlier one's entries (JSON Merge Patch: objects merge,
  `null` removes, the rest replaces). A later View or adapter replaces an earlier one of its name.
  Then each plugin's `check` validates what it understands of the result.
- **Five things persist:** events, nodes (documents), edges, vectors and blobs. That's the storage
  port (`runtime/store.ts`).
- **Collections speak MongoDB:** `ctx.db.collection("x").insertOne/find/updateOne(...)`, with the
  usual filter and update operators. The runtime translates each call into one store operation,
  which the memory store runs in JavaScript and the SQL stores translate to SQL.
- **Queries** are named reads declared on a collection
  (`queries: { history: (messages, params,
  ctx) => … }`). Clients call
  `runtime.query("message.history", params)`; plugin code calls
  `ctx.db.collection("message").query("history", params)`. They never write. An actor calling from
  outside runs only those that let them (`{ allow, run }`, as Actions); a bare function is the
  system's.
- **Views** are each plugin's front end, per medium (see [design/views.md](design/views.md)): text
  for `llm`, Ink elements for `terminal`, React for `web`. A View for kind `"*"` is a medium's
  default for kinds without one. `runtime.render(medium, kind, item)` renders one once (an agent's
  prompt); `runtime.observe(medium, kind, item, { part })` keeps one live: it runs again when a
  commit changes a document it read, and each View it shows (`ctx.show`) is a part that runs again
  on its own. Views call Actions from their handlers (`ctx.call`, `ctx.emit`).
- **A feature's front end is its own:** chat, memory and usage each have a `terminal.ts`
  (`chatTerminal`…) with their terminal Views and commands, added only where the terminal draws;
  chat, team, memory, spaces and computers a `web.tsx` (`chatWeb`…), loaded only by the browser. The
  features themselves (in every process) stay free of UI code.
- **The terminal** (`plugins/interfaces/terminal`) is built from the same primitives. Its data
  (`terminalPlugin`, every process): where each person is (`shell`, changed by `shell.set`) and what
  their commands printed (`output`, kept in memory). Its front end (`terminalShell`): the root
  `shell` View composes what's open, the scrollback (what's done prints once, in order, into the
  terminal's own history) and where you type (commands complete as you type). The host
  (`hosts/terminal`: `terminal({ runtime, me })`) draws it with Ink: a reply being written grows in
  place, as its own part.
- **The web** (see [design/views.md](design/views.md), "The web") runs Views in the browser. The
  page signs in (an httpOnly session cookie), trades the cookie for a one-time ticket (`/connect`),
  and connects to the owner over Oxian as an untrusted worker bound to that person
  (`web({ plugins,
  root })` in the browser, `webServer({ runtime, tickets, code, upgrade })`
  beside the runtime, which declares the `socket` transport). A browser reads a collection directly
  only when a rule speaks for it; anything else, through queries that let its person. Writes are
  Actions. Plugins answer their own HTTP through the `routes` resource (a webhook, an OAuth
  callback, an API, a download), and files people sent are served at `/files/<id>` to whoever may
  read them, with ranges.
- **The design system** (`design/views.md`, "The design system"): the web host owns a token
  vocabulary (shadcn's names) and its defaults, which are Copilotz's look (navy, the logo's cyan and
  blue, Manrope and Space Grotesk, its logo and icon), and an app rebrands with a `theme` resource
  (`{ radius, font, logo, light: { primary }, dark }`), merged like any resource and applied from
  the first paint on (`webServer({ theme })` puts it in the page). Front ends compose the host's
  toolkit (`Button`, `Menu`, `Dialog`, `Markdown`, `Logo`, `Page`, `DetailList`…), and their own CSS
  is only layout, on the theme's variables (`testing/styles.test.ts` fails otherwise). The default
  fonts are the host's own, served under `/assets/copilotz/` with no configuration; a theme's own
  come from Google Fonts (convenient, but every visitor's browser tells Google its IP address: a
  GDPR concern) or from the app itself
  (`webServer({ assets: { "/assets/fonts/brand.css": bytes,
  … } })`, served under `/assets/` only,
  by exact path, with known types, `nosniff` and caching).
- **Live state is data:** a collection declared `durable: false` lives in the owner's memory, not
  the store, with no events. Chat's `live` collection is what agents are writing right now; it goes
  in the commit that writes the step or reply it became, so a screen never shows both, or neither.
- **Vectors:** a collection declares vector fields (`vectors: ["embedding"]`), written like any
  field and searched with `collection.nearest(vector, { filter, limit })` (pgvector on Postgres).
- **Aggregates and indexes:** `collection.aggregate([{ $match }, { $group }, { $sort }, …])` groups
  and totals in the store (SQL `GROUP BY`), and `indexes: [["at"], ["tags.tenant", "at"]]` on a
  collection makes filters on those fields use an index.
- **Records:** a collection declared `records: true` is a ledger: documents are appended, never
  changed or deleted, and are their own record. `ctx.record(collection, doc)` appends one from any
  job, a read included; it goes first in the job's next write that commits on its own, or when the
  job ends, so it costs no round trip, and it is kept even when the job fails. An `_id` sent again
  is the record already kept, so sending twice is safe.
- **One writer per store:** each write auto-commits as one short transaction, and
  `ctx.transaction(tx => …)` makes several writes and their events atomic. Slow I/O, such as model
  calls, never holds the writer.
- **Stream-first:** committed events and live frames go to subscribers immediately, and observed
  Views run again as soon as what they read commits.
- **Who acts:** an outside call may bind an actor (`runtime.call(action, input, { actor })`, and
  `query`, `emit`, `observe` likewise). Everything it causes is theirs: nested calls, writes, the
  events they record (`event.actor`: the log is the audit trail), Processors handling those events,
  and timers it sets. Without one, the system acts.
  - **Actions say whom they let call them** (`allow(actor, input)`); without `allow`, actors can't.
  - **Rules are filters** (a plugin's `guard(actor, { collection, filter }, ctx)`): reads, updates
    and deletes reach only what matches; inserts, and what updates leave, must match. The owner
    applies them to every op an actor's work makes; the access plugin declares them for the
    collections it shares.
  - **Trusted code acts as someone else, on the record:** `ctx.as(person)`, or `ctx.as()` for the
    system, which no rule restricts; its events say `via` whom.
  - Remote executors prove the deployment key, compared in constant time.
  - **Private fields** (`private: ["token"]` on a collection): what an actor's queries and Views
    read comes without them; Actions and Processors acting for them still read them.
- **Processors:** per-key ordering, a durable cursor, at-least-once delivery, made idempotent by
  deterministic ids. A `where` MongoDB filter on event data keeps unwanted events from being
  dispatched at all.
- **Style:** factories and plain data, no classes.

## Invariants (the only spec)

1. A fenced owner cannot commit.
2. An event commits atomically with the writes that caused it (`ctx.transaction`).
3. External effects run outside the writer, and their results are written with ids derived from
   their cause, so retries rewrite instead of duplicating.
4. Everything durable can be replayed from the log; Processors resume from their cursors.

## Layout

```
runtime/        the engine and its ports (Store, Blobs, Exporter, Transport, Clock): define, owner,
                executor, ops, wire, collection, mongo, the in-memory store; tests/
stores/         where the runtime keeps things: the Store port's implementations (memory, sql/
                sqlite and postgres with a shared translation, the latency wrapper) and Blobs'
                (blobs/files, blobs/http); tests/ (conformance)
exporters/      where measurements go: the Exporter port's implementations (OTLP, Prometheus)
plugins/        the features, by theme
  models/       one plugin: llm, embeddings, transcription; shared/ (providers, model choice,
                models.dev catalog)
  agents/       chat, history, memory, team, skills, routines
  billing/      usage (the ledger)
  access/       spaces (members, reach, rules), identity, Google sign-in, connected accounts, the
                directory of orgs
  compute/      computers: desks per space, agents' tools, approvals; program/, the computer program
  interfaces/   terminal (where each person is, the shell View), web (the web shell), the developer
                API and WhatsApp; features'
                own front ends live with them (chat/terminal.ts, chat/web.tsx…), gathered by theme
hosts/          the media the app is used through: terminal (the Ink host and its toolkit); web
                (the React host in the browser: theme/, the tokens and their defaults, Copilotz's
                look and logo, and its fonts and icon, as data the server serves; toolkit/, the
                components; its server half: sign-in, tickets, the socket, the app's assets; and
                node/, serving it on Node); orgs (many orgs behind one address, a runtime each)
testing/        one test API for Deno, Node and Bun; the layers' import rules (boundaries.test.ts);
                plugins' CSS keeps to the theme (styles.test.ts)
design/         agreed designs
scripts/        catalog (refreshes the models.dev snapshot); npm/ (builds the npm package, and
                smoke-tests it installed)
examples/       terminal-agent (an app: its plugins and resources, run in the terminal host, or in a
                browser: web.ts serves it on Deno, harbor.tsx and brands.ts the same app as another
                brand, gallery.tsx the logo, type and toolkit); web-node (a web app on Node, and
                orgs.ts, many orgs behind one address)
```

Each layer imports only what it may (`testing/boundaries.test.ts` fails otherwise): the runtime
nothing outside it; stores, exporters and hosts the runtime; a plugin the runtime, the hosts'
toolkits (the web's through `hosts/web/mod.ts` only), its own files and other plugins'
`contract.ts`. A **host** runs the app in a medium and uses the runtime's public API only; a
**shell** is the medium's root View, a plugin; a feature's **front end** for a medium is its own
Views and commands there.

## Designs

The decisions behind the pieces, as agreed:

- [design/views.md](design/views.md): queries and Views, the web, the design system, fonts;
- [design/access.md](design/access.md): spaces, members, reach and rules;
- [design/memory.md](design/memory.md): memory and chat history;
- [design/tenancy.md](design/tenancy.md): orgs, the directory, and running many of them;
- [stores/README.md](stores/README.md): the stores, and the MongoDB API they speak.

## Copilotz 0.x

1.0 is a new runtime, and doesn't read 0.x data. Copilotz 0.x lives on the
[`v0`](https://github.com/copilotzhq/copilotz/tree/v0) branch.

## License

MIT
