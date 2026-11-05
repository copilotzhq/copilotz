# Copilotz

[![npm](https://img.shields.io/npm/v/copilotz?label=npm)](https://www.npmjs.com/package/copilotz)
[![JSR](https://jsr.io/badges/@copilotz/copilotz)](https://jsr.io/@copilotz/copilotz)

One runtime for agents and the apps around them, on Node, Deno, Bun, Cloudflare Workers and the
browser.

An app is plugins: agents that answer with tools and talk to each other and to people, conversations
in shared spaces, memory, skills and routines, a usage ledger, people's computers, sign-in and
connected accounts, a developer API, WhatsApp, phone calls. Each is a plain object built from the
same few primitives (collections, Actions, Processors, Views, resources and adapters), and the
runtime knows nothing else. Everything durable is an event, a document, an edge, a vector or a blob,
written by one owner to one store (memory, SQLite or PostgreSQL), so every change is on the record
and every screen follows it live: in a terminal, in a browser, or in an agent's prompt.

## Install

```sh
npm install copilotz                 # Node 24+ (npm, pnpm, yarn)
bun add copilotz                     # Bun
deno add jsr:@copilotz/copilotz      # Deno (or `deno add npm:copilotz`)
```

On Deno, name it `copilotz` in `deno.json` (`"copilotz": "jsr:@copilotz/copilotz@^1.0.0-rc.22"`),
and the imports below are the same everywhere. Some pieces need a package of their own, installed
beside it: `esbuild` to bundle the web host on Node, `@electric-sql/pglite` for PostgreSQL in the
process, and `@types/react` for the front ends' types.

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

| Import                                 | What it has                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `copilotz`                             | the runtime: `createRuntime`, `definePlugin`, `defineCollection`, `defineAction`…                                |
| `copilotz/stores/memory`               | `memoryStore()`: in memory, the reference                                                                        |
| `copilotz/stores/sqlite`               | `sqliteStore({ path })`: `node:sqlite` or `bun:sqlite`, one file                                                 |
| `copilotz/stores/postgres`             | `postgresStore({ url, schema, tenant })` (a server, or PGlite in the process), `postgresPool`, `copyTenant`…     |
| `copilotz/stores/latency`              | `withLatency(store, ms)`: a store with round trips, to measure                                                   |
| `copilotz/blobs/files`                 | `fileBlobs({ dir })`: blobs as files                                                                             |
| `copilotz/blobs/http`                  | `httpBlobs({ url, headers })`: blobs in a bucket (S3, GCS, R2…)                                                  |
| `copilotz/blobs/gcs`                   | `gcsBlobs({ bucket, prefix })`: blobs in a Google Cloud Storage bucket, as the instance's service account        |
| `copilotz/plugins/models`              | `models`: llm, embeddings, transcription, the models.dev catalog                                                 |
| `copilotz/plugins/agents`              | `chat`, `history`, `memory`, `memoryExtraction`, `team`, `skills`, `routines`, `tiers`, `openapi`, `tool`        |
| `copilotz/plugins/agents/web`          | their web front ends: `chatWeb`, `teamWeb`, `memoryWeb`, `skillsWeb`, `routinesWeb`, `tiersWeb`                  |
| `copilotz/plugins/agents/terminal`     | their terminal front ends: `chatTerminal`, `memoryTerminal`                                                      |
| `copilotz/plugins/access`              | `access` (`spaces`, `identity`, `contacts`), `accounts`, `directory`, `googleSignIn`                             |
| `copilotz/plugins/access/web`          | `spacesWeb`, `accountsWeb`, `contactsWeb`                                                                        |
| `copilotz/plugins/access/terminal`     | `accessTerminal`                                                                                                 |
| `copilotz/plugins/billing`             | `usage`: the ledger                                                                                              |
| `copilotz/plugins/billing/web`         | `usageWeb`                                                                                                       |
| `copilotz/plugins/billing/terminal`    | `usageTerminal`                                                                                                  |
| `copilotz/plugins/compute`             | `computers`: people's computers, where agents work                                                               |
| `copilotz/plugins/compute/web`         | `computersWeb`                                                                                                   |
| `copilotz/plugins/compute/terminal`    | `computersTerminal`                                                                                              |
| `copilotz/plugins/compute/downloads`   | `computerDownloads`: the computer program's release, served by the app (Node)                                    |
| `copilotz/plugins/interfaces`          | `terminalPlugin` (the terminal's data), `api`, `whatsapp`, `voice`, `mcp`, `maintenance`                         |
| `copilotz/plugins/interfaces/web`      | `webShell` (the web's root View), `apiWeb`, `whatsappWeb`                                                        |
| `copilotz/plugins/interfaces/terminal` | `terminalShell`: the terminal's root View                                                                        |
| `copilotz/web`                         | the web host in the browser (`web`), its toolkit (`Button`, `Markdown`…), what a widget asks (`display`…)        |
| `copilotz/web/server`                  | its server half: `webServer`, `socket`, `widgetsOf`; the `Entrance`, `SignIn` and `Route` shapes plugins declare |
| `copilotz/web/widget`                  | the widget host: an app's web Views inside an outside assistant (`widget`, MCP Apps, ChatGPT)                    |
| `copilotz/web/tickets`                 | `createTickets`: sessions traded for one-time tickets                                                            |
| `copilotz/web/theme`                   | `themeOf(plugins)`: the app's theme, for the page's first paint                                                  |
| `copilotz/web/node`                    | `bundle` (the browser's code, with esbuild), `serve` (the one host), `listen` (HTTP, sockets)                    |
| `copilotz/orgs`                        | `orgsHost`: many orgs behind one address, each a runtime of its own                                              |
| `copilotz/terminal`                    | the terminal host: `terminal({ runtime, me })`, and its toolkit                                                  |
| `copilotz/exporters`                   | `otlp`, `exposition`: metrics out, the OpenTelemetry way                                                         |
| `copilotz/testing`                     | one test API for Deno, Node and Bun (`test`, `tempDir`, `serve`…)                                                |

The browser loads only `copilotz/web`, the `…/web` front ends and what they import; every other
entry point is for the process that runs the runtime (or the terminal). The npm package is
JavaScript with its types beside it, so an app's bundler takes the front ends as they are.

## Serve it on the web

One host serves every app: `serve` (on Node, Bun and Deno; `webServer` beneath it is a fetch handler
for any runtime). What it does comes from the app's plugins, so the same call serves a signed-in
workspace, a public site where visitors chat with an agent, or a WhatsApp app with no page at all:

| Part                                         | Comes from                                                                               | Without it                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------- |
| Routes: webhooks, APIs, sockets of their own | the `routes` resource                                                                    | —                                  |
| The page and its code                        | `code`: the app's front ends, its shell among them, bundled                              | no page: the routes, and `/health` |
| Who a browser is                             | the `entrances` resource: identity's session (a person), web lines (a visitor)           | nobody                             |
| Browsers connecting                          | `tickets`, for whoever an entrance says a request is                                     | no browser connects                |
| Signing in (`POST /signin/<name>`)           | the `signIn` resource: `googleSignIn` (`google`), `devSignIn` (`dev`, this machine only) | none                               |

The host keeps every cookie: httpOnly, so the page's code never sees a session's secret, and
`Secure` anywhere but over plain http to this machine or one on its network (a private address, a
`.local` name), the session's named `__Host-session` there, so no other host under the domain (a
preview's) can set one. A page connects by trading its cookie for a one-time ticket (`/connect`,
which answers only the app's own page: its `Origin`), then talks to the owner over Oxian as an
untrusted worker bound to that actor, under the access rules. Signing in by name (`devSignIn`) is
for this machine only: the socket's address and the host must both be this machine's, with no header
a proxy adds, and an app whose `links` origin is public doesn't start with it. Signing out ends the
browsers connected as whoever it was. On Node:

```ts
// server.ts
import { createRuntime } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { devSignIn } from "copilotz/plugins/access";
import { socket } from "copilotz/web/server";
import { createTickets } from "copilotz/web/tickets";
import { themeOf } from "copilotz/web/theme";
import { bundle, serve } from "copilotz/web/node";
import { plugins } from "./app.ts"; // models, chat, access, … and the app's own

// This machine alone, unless HOST says (0.0.0.0: everyone's).
const hostname = process.env.HOST ?? "127.0.0.1";
const tickets = createTickets();
const runtime = await createRuntime({
  store: memoryStore(),
  // Sign in by name: only while it listens on this machine alone.
  plugins: [...plugins, ...(hostname === "127.0.0.1" ? [devSignIn] : [])],
  transports: [socket], // browsers connect to the owner here
  admit: tickets.admit,
});
const server = await serve({
  runtime,
  tickets,
  code: await bundle(new URL("./browser.tsx", import.meta.url)),
  theme: themeOf([]), // Copilotz's look; a brand passes its theme plugins
  hostname,
  port: 8080,
});
console.log(`${server.url}`);
// A deploy's SIGTERM: stop listening, give running turns a while, close the runtime.
process.once("SIGTERM", () => server.close({ drain: 8_000 }));
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
sockets through Oxian's Node adapter, and says where each request came from; Bun and Deno run it
too. On Deno, `Deno.serve` serves `webServer({ …, upgrade: handler(runtime.hypervisor) })` with
Oxian's Deno adapter, each request given the address it came from first
(`setClientAddress(request, info.remoteAddr.hostname)`: without it, no request is this machine's),
and `deno bundle` makes the code (`examples/terminal-agent/web.ts`). The whole example is in
`examples/web-node/` (`node examples/web-node/server.ts`). Google sign-in is `googleSignIn` with the
`google` resource's `clientId`: the page shows its button.

Many orgs behind one address (`copilotz/orgs`, see [design/tenancy.md](design/tenancy.md)): a
directory signs people in (its plugins declare how, as above) and knows their orgs, and each org is
a runtime of its own, opened when first used. Node takes a socket before any handler runs, so
`listen` serves the orgs host and hands each socket to the runtime of the org its request is for:
`listen({ fetch: host.serve, hypervisor: (request) => host.openRuntime(request)?.hypervisor })`
(`examples/web-node/orgs.ts`).

### Visitors

A public site where anyone chats with the app's agent, signed in or not: the contacts plugin's web
lines (`resources.web.lines.<name>`), with the app's secret (`links`), which visitors' cookies are
signed with. A page that asks to come in by one (`web({ arrive: { line } })`) and isn't anyone yet
becomes a visitor, its browser keeping a signed secret in an httpOnly, `SameSite=Strict` cookie
(`__Host-visitor` wherever it's Secure) that is the same visitor for the line's `days` (30). Coming
in makes and keeps nothing: the visitor's first message (`chat.send`, naming no chat) makes it a
contact in the line's space, with a chat of its own, answered by the line's agent. Someone signed in
comes in as themselves. A visitor reaches what any contact does: their chat, what's said and filed
there (`/files/<id>` too), never the agent's private steps (its tools' calls, with what each
returned, nor a step's words before it's known to be an answer), and nothing else. Its page reads
what it names of its own (its chat's messages by `thread`; its chats by its memberships, `member`
`{ member: "contact:<id>" }`): a read that names none is refused, never watched.

Its limits, each refused plainly (429) and only for that caller. Those by address hold for each
network the address is in, as many callers' worth as it counts: an IPv4 address and its /24 (8); an
IPv6 /64, its /56 (4) and its /48 (8), so one routed /48 is one site, not 65,536 callers:

| Limit                     | Default  | Counted                                                               |
| ------------------------- | -------- | --------------------------------------------------------------------- |
| `ipVisitorsPerHour`       | 20       | new visitors from one address, and as many first messages             |
| `perMinute`, `perDay`     | 10, 200  | one visitor's messages                                                |
| `ipPerMinute`, `ipPerDay` | 30, 1000 | messages from the visitors one address brought                        |
| `linePerMinute`           | 300      | the line's messages, all its visitors                                 |
| `newcomersPerMinute`      | 200      | of those, newcomers' (not spoken before the minute): the rest is kept |
| `visitorsPerHour`         | 600      | new visitors who speak (contacts made), on the line                   |

The caller's address is the one the app's front says (`caller`, as MCP's lines take it), else the
one its socket came from (`serve` and `listen` know it; a listener of your own says it with
`setClientAddress`); with neither, nobody's let in, and when every visitor comes from one private
address (a proxy's) the host says so. A line may also have a `budget`: what its visitors' turns may
be charged a day, in the usage ledger's prices (with the usage plugin); past it, they wait for
tomorrow. And a `challenge`: an Action of the app's that checks what the page answered coming in (a
CAPTCHA's token: `web({ arrive: { line: "site", challenge: token } })`), asked before a newcomer's
let in. A message says 4,096 characters at most; files only on a line that takes them
(`files: { count, bytes }`, 1 of 5 MB unless said), and audio is transcribed (a model's call) only
with `transcribe: true`. A visitor holds two connections, 32 reads on each, and is told a failure's
words only when they're for anyone. Erasing the contact (`contact.forget`) ends its cookie and its
connections at once, and so does removing its line; what's past (counters, records, a contact whose
first message never went in) is collected every ten minutes. To change the app's secret, give the
old one as `links.previous` for a while: visitors and links it signed are still good. With the orgs
host, a line names its org (`org`), and its page is the org's, at `/o/<org>/`.

```ts
resources: {
  agents: { guide: { instructions: "Answer questions about the timetable.", model: "main" } },
  spaces: { visitors: { name: "Website", agents: ["guide"] } },
  web: {
    caller: { header: "cf-connecting-ip", front: env.FRONT_SECRET },
    lines: { site: { in: "visitors", agent: "guide" } },
  },
  links: { origin: "https://example.com", secret: env.LINKS_SECRET },
}
```

```tsx
// The app's own shell for visitors (a chat window): it sends with `chat.send`, naming no chat at
// first, and reads its chat's messages (by `thread`).
await web({ root, plugins: [siteShell, chatWeb], arrive: { line: "site" } });
```

### Without the web app

An app people use on WhatsApp or on the phone needs no page: `serve` without `code` (or `tickets`)
serves its plugins' routes alone (`routes` resources: Meta's webhook, Twilio's), `GET /health` for
whatever watches it, and 404 for anything else, whatever else its plugins declare. Nobody signs in
there: a route's Action is called as a visitor, and its `allow` decides (a webhook checks the
request's signature, then acts for the person it's from with `ctx.as`). Deno and Bun run it too.

```ts
import { createRuntime } from "copilotz";
import { serve } from "copilotz/web/node";

const runtime = await createRuntime({ store, plugins });
const server = await serve({ runtime, hostname: "0.0.0.0", port: 8080 });
process.once("SIGTERM", () => server.close({ drain: 8_000 }));
```

A `serve` route may take a WebSocket of its own (a voice call's relay): `host.upgrade()` accepts the
request's upgrade, and the route answers with the response it gives. It can refuse first (`403`,
before any handshake). The socket is a browser's `WebSocket` as far as `onmessage`, `send` and
`close` go; the listener (`serve`) takes it.

```ts
routes: {
  relay: {
    path: "/voice/relay",
    serve: (request, host) => {
      if (!signed(request)) return new Response("Forbidden", { status: 403 });
      const { socket, response } = host.upgrade();
      socket.onmessage = async (event) => socket.send(await answer(host.runtime, event.data));
      return response;
    },
  },
},
```

A runtime that declares the `socket` transport (remote executors) still takes its sockets at
`/oxian`. `webServer({ runtime })` (`copilotz/web/server`) is the same as a fetch handler, for
another listener; a route's socket needs Oxian's (`copilotz/web/node`'s). The example is
`examples/web-node/routes.ts`.

## Installing a computer

People's computers run the computer program (`plugins/compute/computers/program/`), a single
executable for macOS, Linux and Windows. Each Copilotz release on GitHub has it (`v<version>`: a
binary per platform, `install.sh`, `install.ps1`, and `manifest.json` with their sizes and SHA-256),
and an app serves it from there by default:

```ts
import { computerDownloads } from "copilotz/plugins/compute/downloads";

plugins: [...plugins, await computerDownloads()], // this Copilotz's release
plugins: [...plugins, await computerDownloads({ dir: "dist/computer/1.0.0-rc.22" })], // its own: /computer/download/
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
  (`{ instructions, model, effort?, maxTokens?, temperature?, tools?, history? }`) that answer with
  tools, calling models through `llm`. A reasoning model's thinking (its provider state) is kept on
  the agent's tool steps and goes back to that model while its turn goes on.
  - **Several agents** take turns in parallel. With `send_message` an agent messages another agent
    or a person, and waits for the replies before it continues.
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
    document whose data the owner keeps as a blob. Agents read a text file's content, are shown
    images and PDFs when their model reads them (the latest 8; the catalog says which models do, or
    the model choice's `input: ["image"]`, and the others are told what they can't see), and see
    anything else by name.
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
  - **After an answer:** a medium that can (WhatsApp) shows features' additions
    (`resources.additions.<name> = { order?, agents? }` and an `addition:<name>` View there), each
    once per chat per key, recorded in `shown`; the model is told what went (`[then shown: …]`). A
    message tapped from a button carries `tap: { id, title, key }`, and agents read the id.
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

**`access/`**: who can see and do what (see [design/access.md](design/access.md)).

- **`spaces`**: shared spaces, Personal spaces and single shared documents, with members (people,
  agents, other spaces) and roles; collections named in the `shared` resource keep to what each
  actor reaches. People join by accepting an invitation to the email they signed in with; sending
  one never says whether the address has an account. Agents are members too, each working only where
  it's one; a new space has the app's default agents. An answer drawn from a space not everyone in
  the conversation can see shows only to those who see both, marked, until someone shares it.
- **`identity`**: people, sessions and keys, and who a secret proves.
- **`contacts`**: people outside the org who talk to its agents (a WhatsApp customer). A contact is
  its own kind of actor (`{ kind: "contact", id }`), never a person: every Action and query stays
  shut to it unless it says otherwise (`peopleOrContacts`, as `chat.send` does). Its chat lives in
  the line's space and is shared with it on its own: it reaches that chat, what's said and filed
  there, and nothing else; the space's people reach it as any chat there, and the agent working for
  the contact reaches exactly that chat, never its agents' private steps. Agents are told whom
  they're talking with. Its web lines (`web.lines`) let a browser that isn't anyone in as a visitor,
  a contact once it speaks (see "Visitors").
- **`googleSignIn`**: sign-in with a Google ID token (the `google` resource names your client); the
  web host's page shows its button.
- **`devSignIn`**: sign-in by name or email, from this machine only, for trying an app out.
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
  - **Categories:** each meter is one (`llm`, `embeddings` and `transcription` are agents',
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

**`interfaces/`**: how people reach the runtime. The terminal's data (`terminalPlugin`: where each
person is, what their commands printed) and its shell (`terminalShell`), and the web shell
(`webShell`: the sidebar, the main area by address, the side panel and the command palette, each
filled by the front ends through resources).

- **`api`**: the developer API. A person makes a key in a space, for the Actions, queries and Views
  it may use there; code then calls them over HTTP under `/api/`, and follows what happens as
  server-sent events, as that person, in that space only.
- **`whatsapp`**: people talk to their agents from WhatsApp, through Meta's Cloud API. A space's
  managers connect a number; a person links their phone with a code; what they send becomes their
  messages, and what agents say to them goes back, a long answer in several messages. It's a medium
  for Views (medium `whatsapp`, parts built with its toolkit: text, buttons, a list, a carousel, an
  image, a document, each checked against Meta's limits): after an answer, features show more
  (`additions`: a carousel of trips, buttons to pay), once per chat per key, the answer's text in
  the same message when there's room, a fallback when Meta refuses one; taps come back with their
  ids. Pictures and files go as public links, signed links to the app's routes or files (the `links`
  resource, `{ origin, secret }`; the runtime's `signLink`, `verifyLink`), or uploads. Opened to
  anyone (`whatsapp.set`, or declared in the app's settings: `whatsapp.lines`), a number is a
  customer line: a stranger who writes is a contact, in a chat of their own in the number's space,
  answered by its agent, and a chat quiet for the number's `gap` (12 hours) is over: their next
  message starts a new one.
- **`voice`**: people call the app's phone number and talk to its agents, through Twilio's
  ConversationRelay (Twilio hears them and speaks; the app gets and sends text). The app declares
  its lines (`voice.lines`: the space, Twilio's account and auth token, the app's public address,
  the agent, language, voice, greeting and limits); Twilio's webhook is checked against its
  signature, a call is taken within its caller's limits and the line's (calls at once, a day: else
  busy, nothing spent) and opens the line's socket with a one-time ticket. A caller is a contact in
  a chat of their own, the same one when they call back only if Twilio verified their number; what
  the agent writes for them is said as it writes it (a medium for Views: `voice`), a caller speaking
  over it cuts it there (the agent is told what was heard), a failed or slow answer says a short
  line in the line's language, and silence, a call too long or too many prompts, or the agent's
  `end_call` end it. Managers block a caller (`voice.block`). Its socket needs a host that takes a
  route's socket (`serve`).
- **`mcp`**: models outside the app (ChatGPT, Claude, any MCP client) call its tools. A line the app
  declares (`mcp.lines.<name>`: its space, the tools it lists, each with its `tool:<name>` View, how
  each is shown, who calls, its limits) is an MCP server at `POST /mcp/<name>`: Streamable HTTP,
  JSON-RPC 2.0, no session, MCP 2026-07-28 and the versions with a handshake. Each conversation
  (ChatGPT's `openai/session`, or a `chat` handle the app gives a client that names none) is a
  contact in a chat of its own in the line's space, its ids an HMAC with the `links` secret. A call
  runs the tool through chat's runner as that contact, is written there as a step, and answers what
  the app's agents read of it (only public errors say their words); a request sent again to a tool
  that changes things is answered from the first, and the line's limits (calls at once, a minute,
  new conversations an hour, by conversation, user, caller's address and in all) refuse the rest.
  **Widgets** (MCP Apps, ChatGPT's Apps SDK): a tool's calls shown through a web View of the app's
  (`tools.<name>.widget`), drawn inside the assistant by the widget host (`copilotz/web/widget`) in
  a template the web host makes (`webServer({ widgets: widgetsOf({ code, plugins }) })`), seeded
  with what the View reads, answered on the server as the conversation's contact (its first paint
  asks nothing). What only widgets call (`visibility: ["app"]`, or an Action: `{ action }`, a
  person's tap or form) is refused without the widget's grant, which only results' `_meta` carry
  (never what the model reads); the widget's reads go through the line's `copilotz_read`, queries
  only. One View serves the web and the widget: `surface()`, `display(mode)`, `remind(text)`… from
  `copilotz/web` are no-ops on the page, and the display mode is the View's `hints.mode`.
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
live in the store by default, or as files (`fileBlobs`), in a bucket (`httpBlobs`), or in Google
Cloud Storage (`gcsBlobs`).

## Maintenance

When an app's operators can't reach its database (a client's network that keeps their database user
out), the `maintenance` plugin (`copilotz/plugins/interfaces`) answers for it over HTTP, under
`/maintenance/`, with a key the app gives it:
`resources: { maintenance: { key: process.env.MAINTENANCE_KEY } }`. It's the one place an app runs
SQL of its own: plugin code never does.

```sh
curl https://app.example.com/maintenance/sql -H "authorization: Bearer $KEY" \
  -d '{"sql": "SELECT _id, text FROM message WHERE thread = $1", "params": ["t1"]}'
```

| Endpoint                                          | What it does                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /maintenance/`                               | What's here: whether the store runs SQL, the collections, the limits                                   |
| `POST /maintenance/sql`                           | `{ sql, params?, limit?, timeout? }`: one read-only statement: `{ rows, count, truncated, ms }`        |
| `POST /maintenance/sql/write`                     | `{ sql, params?, limit?, timeout? }`: one that writes, in the owner: `{ changed, rows, event }`        |
| `POST /maintenance/collections/<collection>/<op>` | `insertOne` `{ doc }`… `deleteMany` `{ filter }`, and `find`, `findOne`, `countDocuments`, `aggregate` |
| `POST /maintenance/queries/<collection>.<name>`   | A collection's named query (`booking.stats`), the body its params: `{ result, ms }`                    |
| `GET /maintenance/blobs/<sha256-…>`               | A blob's bytes and type, as a download                                                                 |

- **Keys:** `key`, or several in `keys` while one rotates (add the new, move clients, drop the old).
  Each is at least 32 random characters: a short one, or one plainly not random, stops the app from
  starting. Every request shows one (`Authorization: Bearer <key>`), compared in constant time;
  without a key configured, every request is unauthorized, the same answer as a wrong key.
- **Who:** a request acts as the maintenance actor
  (`{ kind: "maintenance", id: "maintenance", by }`, `by` from `X-Maintenance-By`, as said). Its
  Actions let only it call them, and run as the system on the record (`ctx.as()`): no rule keeps it
  from a document, and every event says `via` it. Writes take an `Idempotency-Key`: sent again, one
  answers what it did the first time.
- **On record twice:** before it runs, each request writes a line (`log`, by default JSON on
  standard output, which Cloud Run keeps): who, what (a statement's SHA-256, its params' count; an
  operation, a query, a blob), which key, when. A SQL write also records a `maintenance.sql` event
  in the same commit. The line is the record the key's holder can't rewrite.
- **Limits:** `limit` rows (1,000), `timeout` ms (30 s) and `bytes` of rows in an answer (8 MB; past
  it the rows are cut, and `truncated` says so). A request may ask for less. A pipeline stops at the
  limit too.
- **Operations go through the owner's write path:** checked against the collection's schema,
  recorded as its events, cached and heard by Processors like any write. Prefer them. Named queries
  run as the system does them (`runtime.query` with no actor), and check their own params.
- **Read SQL** is one statement (a `;` outside its strings and comments ends it; PostgreSQL's line
  comments end at a CR too, and maintenance reads strings with `standard_conforming_strings` on) in
  a read-only transaction, always rolled back, stopped at its limit and cut off at its timeout.
- **Raw SQL writes run inside the owner** (`runtime.maintenance.write`, see `runtime/maintain.ts`),
  for what operations can't do: alone among its writes (those running end first, the next wait for
  it), in a transaction fenced by its epoch, so an owner that lost the store can't run one, with its
  `maintenance.sql` event in the same commit (the statement, its params, the rows it changed in any
  table, who). It bypasses schemas and per-document events, so the owner then forgets what it
  derived from documents: its cache empties, observed Views run again, and the clock reads the
  timers again. A statement that ends or nests its transaction (`COMMIT`, `SAVEPOINT`…) or changes
  its connection (`SET`, `PREPARE`, `LISTEN`, SQLite's `ATTACH`, `PRAGMA`…) doesn't run, and in
  PostgreSQL neither does one that reaches past the statement: `ALTER ROLE` (a role may set its own
  password and settings, which outlive the key), `DO` (a block runs statements nothing reads first)
  and `LOCK` (it would hold the store's tables against the app's own writes). A write still holds
  the row locks it takes (the rows an `UPDATE` changes) until it commits: app writes to those rows
  wait, at most its `timeout`, and with at most 2 maintenance statements at once. One that changes
  the store's own state (`meta`: the fencing epoch, Processors' positions), or what the role holds
  (a large object, a setting), or, in SQLite, leaves a temporary object, is rolled back. The record
  keeps a password literal as `PASSWORD '***'`.
- **Nothing outlives its statement:** on a PostgreSQL server each statement runs on a connection of
  its own, closed after, so what it sets on its session (a setting, a session lock, a prepared
  statement) goes with it; and it goes over the extended protocol, where the server refuses a second
  statement whatever the check said. PGlite has one session: it forgets what maintenance left there
  (`DISCARD ALL`). A SQLite read runs apart, in a process of this runtime of its own on a read-only
  connection, killed at its timeout: a statement that never ends doesn't hold the app, a core or the
  WAL. The process is `deno`, `node` or `bun` itself (never a compiled app, which would be the app
  again), with an empty environment, and on Deno and Node allowed to read the database's files and
  nothing else; on Deno it's started only with permission to run already granted, so nothing ever
  asks mid-request. Where none can start (a database opened another way, `:memory:`, a compiled app,
  no permission), reads run on the store's reading connection, one at a time, with no timeout, a
  pragma only from those that only read: the store says so once, with why, and each such answer says
  `inline: true`. SQLite writes name the store's tables in `main`, so nothing temporary stands in
  for them. Each store runs at most 2 maintenance statements at once
  (`maintenance: { connections }`): another answers busy (503).
- **Where:** SQL needs a SQL store. On a PostgreSQL server only as a role of its own (below) or,
  told so, as the store's own role (below that), never in a schema other tenants share; PGlite, in
  the app's process, runs it as its one session where it reaches no other schema. An orgs host's
  orgs don't get the plugin at all (one key would reach every org). Operations, named queries and
  blobs work everywhere, the memory store too, and need no role.

### A role of its own

On a PostgreSQL server, raw SQL runs only as a role of its own, named by the store:
`postgresStore({ url, schema, maintenance: { url: process.env.MAINTENANCE_DATABASE_URL } })`.
Without one it's refused, unless the store is told to run it as its own role (below). The store's
role owns the tables, may stop the app's connections and is whatever the deployment made it (a
superuser, even): nothing that runs at a key's word should be it.

Before each statement, on the connection that runs it, and again after a write in its transaction,
maintenance checks that the role holds exactly what the SQL below grants, and refuses it otherwise
(rolling a write back), saying what's more: an attribute beyond `LOGIN` (superuser, `CREATEROLE`…);
membership in any role at all, predefined (`pg_*`) or not, and whatever its `INHERIT` or `SET`
options (a member could `SET ROLE` to it); settings of its own (`ALTER ROLE … SET`); anything it
owns, a large object too (what it makes for its own session, a temporary table, goes with its
connection); anything granted to it outside the store's schema and database; `CREATE` on any schema
(`public` too) or on the database; any privilege on a table or a column of another schema; on the
store's own tables, anything beyond the grants below (no `TRIGGER`, `TRUNCATE` or `REFERENCES`; on
`events` only `INSERT`); a large object it may read (`lo_compat_privileges`, or one granted to
`PUBLIC`); a `SECURITY DEFINER` function it may run (one runs as its owner); `dblink` or
`postgres_fdw` in the database; and a trigger on the store's tables, which the store never makes.
The checks name every catalog they read as `pg_catalog`'s, after setting the search path back to it,
so nothing a statement made stands in for them.

Prefer a role with no password at all, signed in by the platform: Cloud SQL's IAM database
authentication, or a client certificate. A password is a second key, valid for as long as nobody
changes it. On Cloud SQL, with a service account of its own for maintenance:

```sh
gcloud sql users create maintenance@PROJECT.iam --instance=INSTANCE --type=cloud_iam_service_account
gcloud projects add-iam-policy-binding PROJECT \
  --member=serviceAccount:maintenance@PROJECT.iam.gserviceaccount.com \
  --role=roles/cloudsql.instanceUser   # and roles/cloudsql.client, to connect
# The app reaches it through the Cloud SQL Auth Proxy, which signs it in (no password):
#   cloud-sql-proxy --auto-iam-authn --impersonate-service-account=maintenance@PROJECT.iam.gserviceaccount.com \
#     --port 5433 PROJECT:REGION:INSTANCE
# MAINTENANCE_DATABASE_URL=postgres://maintenance%40PROJECT.iam@127.0.0.1:5433/DATABASE
```

Cloud SQL makes such a role a member of its own marker role (`cloudsqliamserviceaccount`, or
`cloudsqliamuser` for a person): that one membership is allowed, without ADMIN OPTION. Every IAM
user is a member of the marker too, so the marker may hold nothing at all: grant it nothing, not
even the grants below (maintenance refuses a marker that holds anything). Then the grants below,
naming `"maintenance@PROJECT.iam"`.

Elsewhere, as the store's role (the schema's owner), with the schema made (the app has started
once), and as a role that may create roles for the first line:

```sql
-- LOGIN and nothing else; never grant it a role. (On Cloud SQL with IAM, gcloud makes it.)
CREATE ROLE copilotz_maintenance LOGIN PASSWORD '…' NOINHERIT;
GRANT USAGE ON SCHEMA copilotz TO copilotz_maintenance;
-- Reading everything there, the collections' views too, now and later.
GRANT SELECT ON ALL TABLES IN SCHEMA copilotz TO copilotz_maintenance;
ALTER DEFAULT PRIVILEGES IN SCHEMA copilotz GRANT SELECT ON TABLES TO copilotz_maintenance;
-- Changing documents, edges, vectors and blobs.
GRANT INSERT, UPDATE, DELETE ON copilotz.nodes, copilotz.edges, copilotz.vectors, copilotz.blobs
  TO copilotz_maintenance;
-- Appending to the log (its own audit events), never changing it.
GRANT INSERT ON copilotz.events TO copilotz_maintenance;
-- Holding the fence while it writes (FOR SHARE needs it); a statement that changes meta is rolled back.
GRANT UPDATE (value) ON copilotz.meta TO copilotz_maintenance;
-- PostgreSQL 14 and earlier let everyone create in public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Replace `copilotz` with the store's schema. `PUBLIC` keeps `CONNECT` on the database, `TEMPORARY`,
and `USAGE` on `public`; those are allowed. A `SECURITY DEFINER` function can be run by everyone
(`PUBLIC`) unless revoked: find them, and revoke it from each (or maintenance refuses, naming them):

```sql
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.prosecdef
  AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace);
REVOKE EXECUTE ON FUNCTION some_schema.some_function(…) FROM PUBLIC;
```

### Or the store's own role

Where a role of its own is more than a deployment wants, raw SQL can run as the store's own role
instead, said in so many words: `postgresStore({ url, schema, maintenance: { storeRole: true } })`
(`connections` as above). Each statement then connects as the role in the store's `url` (or its
pool's). Naming `url` and `storeRole` together stops the store from opening.

**What it costs:** anyone holding the maintenance key can do whatever the store's role can. It owns
the store's tables, so a statement can drop or truncate them, delete from the log, or rewrite any
document without an event; it can read every schema the role reaches (another app's on the same
database too, if it may), stop the app's own connections, and create roles or databases if the role
may. A leaked key is then almost the app's own database login. Only the check above is skipped,
which the store's role couldn't pass. Everything else holds: the statement filter (no `COMMIT`,
`SET`, `ALTER ROLE`, `DO`, `LOCK`…); the extended protocol and a connection of its own for each
statement, closed after; timeouts, the row and byte caps, and at most `connections` at once; writes
inside the owner, fenced, with their `maintenance.sql` event; a statement that changes `meta` or
makes a trigger rolled back; the owner's cache emptied after a write; the key and the log line.

Still refused, before each statement and again after a write in its transaction, saying why: a role
that could turn SQL into commands on the database server or access to its files. That is a
superuser; a member, by any path, of a superuser role (it could switch to it within a statement), or
of `pg_execute_server_program`, `pg_read_server_files` or `pg_write_server_files`; before PostgreSQL
16, one with `CREATEROLE` (enough to grant itself any of those); and one that may run
`pg_read_file`, `pg_read_binary_file`, `lo_import`, `lo_export` or adminpack's file functions. Cloud
SQL's `postgres` user isn't a superuser (it's a member of `cloudsqlsuperuser`, which isn't one
either): from PostgreSQL 16 it passes; on 15 or earlier its `CREATEROLE` is refused, so use a role
of its own there.

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
`/prompt [agent]`, `/fork`, `/retry`, `/events [n]`, `/stats`, `/sql <query>` (a SQL store),
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
  - **Private fields** (`private: ["buyer", "passengers"]` on an Action, dot paths as a
    collection's): its calls are recorded without them, in `started`'s input and `completed`'s
    result alike, so personal data a call is given stays out of the log while the call is still
    recorded and retried. Its `inputHash` (and a nested call's id) still covers the whole input: a
    retry with the same input finds the call, and a changed one is a new call. That hash is in the
    log: whoever knows the rest of an input could check a guess of a field easy to guess alone (a
    CPF) against it. A result that had any is kept whole in `sys.results`, with the completion
    (`private: true` there), so a retry answers with all of it.
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
  - **Closing:** `runtime.close()` starts no more deliveries or timer occurrences, and gives the
    running ones `drain` ms to finish (`close({ drain })`, 5 s by default); what's still running
    then stops where it is. A delivery that didn't finish keeps its Processor's cursor before its
    event, so the next owner delivers it again, with `retry`: a deploy never drops one.
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
  values out on write and back in on read, so plugin code never sees a reference. Only the owner
  makes them: a `$blob` key anywhere in what plugin code writes, or in what an Action is called
  with, is refused (`invalid`), and so is any part of an update's field path that starts with `$` or
  is `__proto__` (an aggregate's `$group` names no `$…` field either). A path ends at a reference as
  at a string. On read, only an exact reference (those three keys, a `sha256-<64 hex>` id) loads a
  blob; any other object is data. Blob stores take no other id.

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
- **Maintenance SQL** (see [Maintenance](#maintenance)) changes what the cache can't follow: the
  owner empties it after one commits, and a read in flight across that fills nothing.

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
  page's cookie (a person's session, a web line's visitor: the `entrances` plugins declare) trades
  for a one-time ticket (`/connect`), and it connects to the owner over Oxian as an untrusted worker
  bound to that actor (`web({ plugins, root })` in the browser,
  `webServer({ runtime, tickets, code,
  upgrade })` beside the runtime, which declares the `socket`
  transport). A browser reads a collection directly only when a rule speaks for it; anything else,
  through queries that let its person. Writes are Actions. Plugins answer their own HTTP through the
  `routes` resource (a webhook, an OAuth callback, an API, a download, a socket of their own), and
  files people sent are served at `/files/<id>` to whoever may read them, with ranges.
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
    read comes without them; Actions and Processors acting for them still read them. No event holds
    them, on any store, and none holds an Action's (`private: ["buyer"]`) either.
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
                (blobs/files, blobs/http, blobs/gcs); tests/ (conformance)
exporters/      where measurements go: the Exporter port's implementations (OTLP, Prometheus)
plugins/        the features, by theme
  models/       one plugin: llm, embeddings, transcription; shared/ (providers, model choice,
                models.dev catalog)
  agents/       chat, history, memory, team, skills, routines, tiers
  billing/      usage (the ledger)
  access/       spaces (members, reach, rules), identity, Google sign-in, connected accounts, the
                directory of orgs
  compute/      computers: desks per space, agents' tools, approvals; program/, the computer program
  interfaces/   terminal (where each person is, the shell View), web (the web shell), the developer
                API, WhatsApp, voice (phone calls), MCP and maintenance; features'
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
