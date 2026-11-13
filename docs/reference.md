---
title: Reference
description: What you import and what you declare, exactly. The entry points, the primitives a plugin is made of, who calls what for whom and where, the events the log keeps, schedules, and a page for every plugin.
section: Reference
order: 1
---

# Reference

This page lists what Copilotz gives you to import, and what a plugin may declare. It says what each
piece is, not why it's built that way: [the architecture](architecture.md) says how it runs. Every
plugin Copilotz ships has [a page of its own](reference/plugins.md), read from the plugin itself.

## Install

```sh
npm install copilotz@next                      # Node 24+ (npm, pnpm, yarn)
bun add copilotz@next                          # Bun
deno add jsr:@copilotz/copilotz@^1.0.0-rc.48   # Deno 2.9+ (or `deno add npm:copilotz@next`)
```

Until 1.0, the release candidates are on npm's `next` tag, and a plain `npm install copilotz` or
`deno add jsr:@copilotz/copilotz` gets an older version. At 1.0, stable installs drop `@next` and
the version.

On Deno, map the name in `deno.json` (`"copilotz": "jsr:@copilotz/copilotz@^1.0.0-rc.48"`), and the
imports read the same everywhere. 3 pieces need a package of their own, installed beside it:
`esbuild` to bundle the page's code on Node (`bundle`), `@electric-sql/pglite` for PostgreSQL in the
process, and `@types/react` for the front ends' types. A product's plugins are packages of their own
too, at Copilotz's version (`npm install @copilotz/work@next`,
`deno add jsr:@copilotz/work@^1.0.0-rc.48`): see [Product packages](#product-packages).

## Entry points

The same names on npm (`copilotz/…`) and JSR (`@copilotz/copilotz/…`).

| Import                                 | What it has                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copilotz`                             | the runtime: `createRuntime`, `definePlugin`, `defineAction`, the access helpers (`people`, `inPerson`, `grant`…), `connect` (the client)…                |
| `copilotz/stores/memory`               | `memoryStore()`: in memory, the reference every store is held to                                                                                          |
| `copilotz/stores/sqlite`               | `sqliteStore({ path })`: one file, on `node:sqlite` or `bun:sqlite`                                                                                       |
| `copilotz/stores/postgres`             | `postgresStore({ url, schema, tenant })` (a server, or PGlite in the process), `postgresPool`, `copyTenant`, `exportTenant`, `dropTenant`                 |
| `copilotz/stores/latency`              | `withLatency(store, ms)`: a store with round trips, to measure                                                                                            |
| `copilotz/blobs/files`                 | `fileBlobs({ dir })`: large values as files                                                                                                               |
| `copilotz/blobs/http`                  | `httpBlobs({ url, headers })`: large values in a bucket (S3, GCS, R2…)                                                                                    |
| `copilotz/blobs/gcs`                   | `gcsBlobs({ bucket, prefix })`: large values in Google Cloud Storage, as the instance's service account                                                   |
| `copilotz/plugins/models`              | `models`: language models, embeddings, transcription and images, with the models.dev catalog                                                              |
| `copilotz/plugins/agents`              | `chat` and its `tool`, `history`, `memory`, `memoryExtraction`, `skills`, `routines`, `openapi`, `webTools`                                               |
| `copilotz/plugins/agents/web`          | their web front ends: `chatWeb`, `memoryWeb`, `skillsWeb`, `routinesWeb`                                                                                  |
| `copilotz/plugins/agents/terminal`     | their terminal front ends: `chatTerminal`, `memoryTerminal`                                                                                               |
| `copilotz/plugins/agents/<name>`       | one of them alone, `<name>` being `chat`, `history`, `memory`, `skills`, `routines`, `openapi`, `webtools`                                                |
| `copilotz/plugins/access`              | `access` (`spaces`, `identity`, `contacts`), `googleSignIn`, `emailSignIn`, `email`, `devSignIn`, `accounts`                                              |
| `copilotz/plugins/access/web`          | `spacesWeb`, `contactsWeb`, `accountsWeb`                                                                                                                 |
| `copilotz/plugins/access/terminal`     | `accessTerminal`                                                                                                                                          |
| `copilotz/plugins/access/<name>`       | one of them alone, `<name>` being `spaces`, `identity`, `contacts`, `google`, `email`, `dev`, `accounts`                                                  |
| `copilotz/plugins/billing`             | `usage`: the ledger, and the port an app's pricing plugs into (`spending`)                                                                                |
| `copilotz/plugins/billing/web`         | `usageWeb`                                                                                                                                                |
| `copilotz/plugins/billing/terminal`    | `usageTerminal`                                                                                                                                           |
| `copilotz/plugins/compute`             | `computers` (people's machines, where agents work), `cloud`, `apps`, and their hosts                                                                      |
| `copilotz/plugins/compute/web`         | `computersWeb`, `cloudWeb`, `appsWeb`                                                                                                                     |
| `copilotz/plugins/compute/terminal`    | `computersTerminal`                                                                                                                                       |
| `copilotz/plugins/compute/downloads`   | `computerDownloads`: the computer program's release, served by the app (Node)                                                                             |
| `copilotz/plugins/interfaces`          | `terminalPlugin` (the terminal's data), `api`, `whatsapp`, `voice`, `mcp`, `webLines` (site chats), `maintenance`                                         |
| `copilotz/plugins/interfaces/web`      | `webShell` (the web's root View), `apiWeb`, `whatsappWeb`                                                                                                 |
| `copilotz/plugins/interfaces/terminal` | `terminalShell`: the terminal's root View                                                                                                                 |
| `copilotz/plugins/interfaces/<name>`   | one of them alone, `<name>` being `mcp`, `api`, `whatsapp`, `voice`                                                                                       |
| `copilotz/plugins/<theme>/contract`    | each theme's plugins' contracts (`access`, `agents`, `models`, `interfaces`, `compute`): shapes, and the little code with them, for plugins built on them |
| `copilotz/web`                         | the web host in the browser (`web`), its toolkit (`Button`, `Markdown`…), what a widget asks (`display`, `surface`, `remind`)                             |
| `copilotz/web/words`                   | the words alone, without the toolkit: `defineWords`, `wordsOf`, `formatDate`…                                                                             |
| `copilotz/web/server`                  | the page's server half: `webPage` (the page, as a plugin), `widgetsOf`                                                                                    |
| `copilotz/web/widget`                  | the widget host: an app's web Views inside an outside assistant (MCP Apps, ChatGPT)                                                                       |
| `copilotz/web/theme`                   | `themeOf(plugins)`: the app's theme, for the page's first paint                                                                                           |
| `copilotz/web/node`                    | `listen` (serves `runtime.fetch` on Node and Bun, sockets included), `bundle` (the browser's code, with esbuild)                                          |
| `copilotz/terminal`                    | the terminal host, `terminal({ runtime, me })`, and its toolkit                                                                                           |
| `copilotz/exporters`                   | `otlp`, `exposition`: metrics out, the OpenTelemetry way                                                                                                  |
| `copilotz/testing`                     | one test API for Deno, Node and Bun: `test`, `tempDir`, `serve`, `spawn`, `testWho`, `ticketFor`, `openTo`…                                               |
| `copilotz/testing/words`               | testing a front end's words (`pseudoWords`, `englishLeft`), and listing them (`wordsList`)                                                                |
| `copilotz/describe`                    | `describe(plugin)`: what a plugin declares, as JSON                                                                                                       |

The browser loads only `copilotz/web`, the front ends under `…/web`, and what they import. Every
other entry point is for the process that runs the runtime, or the terminal.

A theme's entry point (`copilotz/plugins/interfaces`) loads every plugin in it. A plugin's own
(`copilotz/plugins/interfaces/mcp`) loads that plugin and what it imports, and nothing else: the
same plugin, with less code in the server's memory.

## Product packages

What a product does its own way, rather than what every app needs, is a package of its own, released
with Copilotz at its version: `@copilotz/work@1.0.0-rc.48` goes with `copilotz@1.0.0-rc.48`. Each
has the same entry points, its plugins (`@copilotz/work`), their front ends (`@copilotz/work/web`)
and their shapes, for plugins built on them (`@copilotz/work/contract`), with the same names on npm
and JSR.

| Package               | What it has                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@copilotz/work`      | `boards` (kanban) and `documents` (shared Markdown with versions and merges); `boardsWeb`, `documentsWeb`    |
| `@copilotz/directory` | `directory`: many orgs behind one address; `directoryWeb`, the org switcher, the org's page, staff's console |
| `@copilotz/billing`   | `credits` (plans, credits, budgets), `stripe`, `stripeWebhook`; `creditsWeb`                                 |
| `@copilotz/team`      | `team` (agents people make), `tiers` (the models an org's agents think with); `teamWeb`, `tiersWeb`          |

They import Copilotz by its entry points alone, as an app's own plugins would. Their collections,
Actions, events, Views and resources keep the names they had inside Copilotz, so an app's data stays
as it is.

## Who, for whom, where

Every call runs as an actor. The actor says who acts, for whom an agent works, and where the work
is. The runtime carries it into everything the call causes: nested calls, tools, the Processors its
events wake, its timers, and the Views observed for it. Every event records it.

```ts
{ kind: "agent", id: "north", for: { kind: "person", id: "ana" }, in: "launch" }
```

| Field          | What it says                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `kind`, `id`   | who acts                                                                                                    |
| `for`          | whom an agent works for: a person or a contact                                                              |
| `in`           | where the work is: an opaque id, as `id` is. To the access plugin it's a space. None: nowhere in particular |
| `via`          | whose work trusted code was doing when it acted as someone else (`ctx.as`)                                  |
| `key`, `scope` | a person acting through a developer key, and what the key may use                                           |
| `origin`       | what set a person's work going, such as a routine                                                           |

The kinds the runtime makes or checks:

| Kind          | Who                                                                 | Made by                                    |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| `person`      | someone with an account, signed in or through their key             | `identity`; a key's by `api`               |
| `agent`       | an agent, working for someone (`for`)                               | `chat`, for each turn                      |
| `contact`     | someone outside the org: a WhatsApp customer, a caller, an MCP chat | `contacts`                                 |
| `system`      | trusted code, which no rule restricts; a named grant is one too     | the runtime: no actor, `ctx.as()`, `grant` |
| `maintenance` | the maintenance key, for support's SQL                              | the maintenance plugin's routes            |
| `anonymous`   | an HTTP request nobody is signed in to (`id: ""`)                   | `runtime.fetch`, when no `who` answers     |

Each way in says where its work is:

| Way in                  | Who, for whom                                | Where (`in`)                                |
| ----------------------- | -------------------------------------------- | ------------------------------------------- |
| The web                 | the person                                   | the page's space: a call says it            |
| A chat's turn           | its agent, for whoever started it            | the chat's space                            |
| WhatsApp                | the customer (a contact), or a linked person | the number's space, or the space they're in |
| Voice                   | the caller (a contact), and its agent for it | the line's space                            |
| A web line, an MCP line | the visitor or conversation (a contact)      | the line's space; a tool, where its chat is |
| A developer key         | its person, through it                       | the key's space                             |
| The terminal            | its person                                   | where they work (`/space`, `/work`)         |
| A routine               | whoever made it, set going by it (`origin`)  | the routine's space                         |
| Handing work to a space | the same person                              | the new space                               |

A host calling for someone says where too: `runtime.call(action, input, { actor: { ...ana, in } })`,
or a client's `call(action, input, { in })`. What a page says is recorded, never proved, and a
person's own reach isn't narrowed by it. An agent's reach is: its person's reach, within the spaces
the agent is a member of, within `in` and what `in` draws on. In the person's own Personal space,
their agents reach all they do, and what they write elsewhere for them there is theirs (no labels
from there). Tools that take a space (`in`) work there: check it with `workIn` from the agents'
contract. The access plugin keeps that rule ([design](../design/work.md)).

From `copilotz`:

- **`personOf(actor)`:** the person whose work this is, the one acting or the one found along `for`,
  then `via`. Read it instead of `ctx.actor.id`, which for an agent is the agent's.
- **`principalOf(actor)`:** the person or contact the work is for.
- **`whereOf(actor)`:** its `in`, if it has one.
- **`onBehalf(actor)`:** whether a person's work is done for them rather than by them: through a
  key, set going by a routine, or by code acting as them for an agent.

## Who may call: `allow`

An Action's `allow(actor, input)` says who may call it. The runtime asks it wherever an actor calls.

| Where the call comes from                                                         | `allow` asked | Without an `allow`           |
| --------------------------------------------------------------------------------- | ------------- | ---------------------------- |
| outside: `runtime.call` with an actor, the REST API, the socket, a View's handler | yes           | refused                      |
| code acting for an actor: `ctx.call` in an Action, a Processor or a tool          | yes           | runs: the Action is internal |
| a timer an actor set                                                              | yes           | runs                         |
| a read calling an unrecorded Action (`ReadContext.call`)                          | yes           | runs                         |
| the system, a grant, or code with no actor                                        | no            | runs                         |

For an agent, it's asked twice: of the agent, then of whom it works for (`allows`). So a tool never
calls what its agent's person couldn't. A key also calls only what its scope lists, from outside
(`inScope`). Which documents a call then reaches is the rules' business, not `allow`'s.

The helpers say what they mean for an agent:

| Helper             | Lets in                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| `people`           | a person, their key, their routines, and an agent working for a person                 |
| `inPerson`         | the person themselves: never a key, an agent, a routine's run, or code acting for them |
| `contacts`         | a contact, and an agent working for one                                                |
| `peopleOrContacts` | both                                                                                   |

Say `inPerson` for what only the person decides: consent, keys, who's in a space, money, publishing.
Say `people` for the rest. Copilotz's own Actions do the same, and each plugin's page shows who may
call each of its Actions. `chat.send` and `chat.attach` have a rule of their own: people and
contacts writing as themselves, never an agent.

```ts
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  inPerson,
  people,
  personOf,
} from "copilotz";
import { memoryStore } from "copilotz/stores/memory";

const notes = definePlugin({
  name: "notes",
  collections: { note: { schema: { type: "object", properties: { text: { type: "string" } } } } },
  actions: {
    "note.add": defineAction({
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      allow: people, // a person, their key, or an agent working for one
      run: (ctx, { text }) =>
        ctx.db.collection("note").insertOne({ text, by: personOf(ctx.actor) }),
    }),
    "note.clear": defineAction({
      input: { type: "object" },
      allow: inPerson, // the person themselves, never on their behalf
      run: (ctx) => ctx.db.collection("note").deleteMany({}),
    }),
  },
});

const runtime = await createRuntime({ store: memoryStore(), plugins: [notes] });
const ana: Actor = { kind: "person", id: "ana", in: "launch" };
const north: Actor = { kind: "agent", id: "north", for: ana, in: "launch" };

for (const [who, actor] of [["ana", ana], ["north for ana", north]] as const) {
  for (const action of ["note.add", "note.clear"]) {
    const outcome = await runtime.call(action, { text: "Call Bruno" }, { actor })
      .then(() => "ok", (error) => error.code);
    console.log(`${who}, ${action}: ${outcome}`);
  }
}
await runtime.close();
```

It prints:

```
ana, note.add: ok
ana, note.clear: ok
north for ana, note.add: ok
north for ana, note.clear: forbidden
```

**Going beyond is a named grant.** Trusted code that must do what its actor couldn't acts as the
system, for one reason: `ctx.as(grant("availability"))`. What it does is recorded as the grant,
`via` whose work it was and `in` where. The owner counts its ops in `copilotz.elevated.ops`, by
grant. A model never holds one: your code decides what leaves it. Copilotz's own are
`chat.hand-over`, `chat.hand-back` and `web.budget`.

```ts
run: async (input, ctx) => await ctx.as(grant("availability")).call("slots.all", { in: ctx.in }),
```

Queries and events have an `allow` too, asked only from outside. A query declared as a bare function
is the system's. No actor emits an event without `allow` from outside, and a key emits none.

## A plugin

A plugin is a plain object. `definePlugin` only types it.

| Field         | What it declares                                                                             |
| ------------- | -------------------------------------------------------------------------------------------- |
| `name`        | its name                                                                                     |
| `requires`    | the plugins it builds on, by name: the runtime doesn't start without them                    |
| `collections` | its collections, and indexes it adds to another's (`{ usage: { indexes: [["tags.app"]] } }`) |
| `actions`     | what can be done                                                                             |
| `events`      | the events it emits, beyond its collections' changes and its Actions' lifecycle              |
| `processors`  | what happens when events happen                                                              |
| `views`       | how its data shows, by name; `null` removes an earlier plugin's View                         |
| `resources`   | configuration, by kind and name                                                              |
| `adapters`    | implementations of a port, by port and name                                                  |
| `schedules`   | Actions time calls (see [Schedules](#schedules))                                             |
| `check`       | a startup check of the merged configuration it understands                                   |
| `guard`       | the rules: who reaches which documents                                                       |
| `labels`      | what reads reveal, carried to what the same job writes                                       |
| `workers`     | kinds of worker: programs that do its work but aren't plugin code (a computer)               |
| `routes`      | its HTTP, by `URLPattern` pathname                                                           |
| `who`         | who a request is, by a credential it knows                                                   |

Plugins merge in order. Collections, Actions, events, Processors and kinds of worker are unique: a
second of one name stops the runtime from starting. Resources and schedules patch: a later plugin's
entry merges into an earlier one's (JSON Merge Patch: objects merge, `null` removes, the rest
replaces). A later View, adapter or route replaces an earlier one of its name. Every plugin's
`guard` restricts together, the first `who` that answers wins, and the last `labels` is the one.

### Collections

Documents with a JSON Schema, read and written with MongoDB's collection API. `defineCollection`
types its documents and queries from the schema.

| Field     | What it does                                                                                |
| --------- | ------------------------------------------------------------------------------------------- |
| `schema`  | the JSON Schema every write is checked against                                              |
| `queries` | named reads: a function, or `{ allow, run }` to let actors run it from outside              |
| `vectors` | fields holding embeddings, kept as the store's vectors and searched with `nearest`          |
| `indexes` | lists of fields (`[["at"], ["tags.tenant", "at"]]`), each a scalar its schema types         |
| `private` | fields only trusted code reads: an actor's queries and Views get the documents without them |
| `records` | `true`: a ledger, appended to and never changed, whose documents are their own record       |
| `durable` | `false`: kept in the owner's memory, never in the store, with no events                     |
| `events`  | `false`: its writes record no events                                                        |

`ctx.db.collection(name)` has `insertOne`, `insertMany`, `find` (a cursor), `findOne`,
`countDocuments`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`, `aggregate`,
`nearest(vector, { filter, limit })` and `query(name, params)`.

- **Filters:** `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$elemMatch`,
  `$and`, `$or`, `$nor`, `$not`.
- **Updates:** `$set`, `$unset`, `$inc`, `$push` (with `$each`), `$addToSet`, `$pull`; `upsert`.
- **Finds:** `sort`, `limit`, `skip`, and `projection` (`{ name: 1 }` keeps fields, `{ data: 0 }`
  leaves them out), applied before any large value is loaded.
- **Aggregates:** `$match`, `$group` (with `$sum`, `$count`, `$avg`, `$min`, `$max`), `$sort`,
  `$skip`, `$limit`, run in the store.
- **Unanswered writes:** `{ writeConcern: { w: 0 } }` sends a write with the next op or the commit,
  so it costs no round trip of its own.

Plugin code runs any named query, as whoever it acts for, under the rules. From outside,
`runtime.query("message.history", params, { actor })` runs only a query whose `allow` lets them in.

### Actions

What can be done, by name. `defineAction` types `run`'s input from the schema.

| Field         | What it does                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `input`       | the JSON Schema a call's input must match                                                        |
| `allow`       | who may call it (see [Who may call](#who-may-call-allow)); none: it's internal                   |
| `run`         | `(ctx, input) => result`: what it does                                                           |
| `description` | what it does, for people and for tools that list Actions                                         |
| `record`      | `false`: unrecorded. It runs inline in its caller's job, with no events and no commit of its own |
| `private`     | fields its calls are recorded without, as dot paths, in its input and its result                 |

Every recorded call is on the record (`action.started`, then `action.completed` or `action.failed`),
retryable by id, and everything it causes is its caller's, where its caller is. Queries, Views and
startup checks may call unrecorded Actions, read-only.

### Processors

What happens when events happen: ordered per key, at least once, from a durable cursor.

| Field   | What it does                                                                         |
| ------- | ------------------------------------------------------------------------------------ |
| `on`    | the event types it handles                                                           |
| `where` | a MongoDB filter on the event's data: the owner never dispatches the events it skips |
| `key`   | `(event) => key`: events of one key run in order, and different keys run at once     |
| `run`   | `(ctx, event) => …`, as the event's actor, where the event was                       |

### Events a plugin declares

`events: { "booking.confirmed": { schema, description?, allow? } }`. Code emits one with
`ctx.emit(type, data)`, in the job's commit. Emitting a type nobody declared fails, so every event
is in some plugin's contract. `allow` says who may emit it from outside (`runtime.emit`, a View's
handler). The runtime's own events (`<collection>.created`, `action.…`, `processor.…`) can't be
declared.

### Views

How data shows in one place, found by name: `(item, ctx) => what it shows`. Text for a model, Ink
elements in the terminal, React in the browser. A name says what it shows (`booking`, `tool:book`,
`context:today`), and a place prefixes it where the same thing shows in several (`llm.message`,
`web.message`, `terminal.message`). The shells ask for their own default when a name has no View
(`web.default`, `terminal.default`).

- **Reads** inside a View return at once, as `{ status: "loading" }` or
  `{ status: "ready", value }`. The runtime runs the View again until a pass reads nothing new.
- **`ctx.show(name, item, hints?)`** shows exactly the View it names. Observed, the shown View is a
  part that runs again on its own.
- **`ctx.call`** and **`ctx.emit`** act from a handler, as the actor looking.
- **`runtime.render(name, item, { viewer?, hints? })`** renders once, as the system. Code renders
  with `ctx.render`, as its actor: a turn renders its agent's prompt, the `llm.thread` View, that
  way.
- **`runtime.observe(name, item, { actor?, viewer?, hints?, part? })`** keeps one live: it runs
  again when a commit changes a document it read. Its `ready` is the first output, and `close()`
  stops it.

[How Views run](architecture/views.md) is in the architecture.

### Resources and adapters

- **Resources** are configuration as named plain objects, by kind: `agents`, `tools`, `provider`,
  `shared`, `theme`. The runtime gives them no meaning. A plugin reads the kinds it understands, and
  a later plugin patches an earlier one's entries, so an app changes one agent's `effort` without
  redefining it.
- **Adapters** are implementations of a port, by port and name: `llm.openai`, `embeddings.hash`,
  `email.resend`. A later plugin's adapter of a name replaces an earlier one's.

### Routes and `who`

`runtime.fetch(request)` answers HTTP: its own paths (`POST /connect`, the socket at `/oxian`, the
REST API at `/api/`) and plugins' routes. Hosts only listen: `Deno.serve(runtime.fetch)`, or
`listen(runtime.fetch)` from `copilotz/web/node`.

- **A route** is `(request, ctx) => Response`, keyed by a `URLPattern` pathname
  (`/hooks/whatsapp/:name`). Its `ctx` has `runtime` (trusted code), `actor` (who the request is),
  `params` and `cookies`. Routes deal with HTTP, and Actions do the work. A thrown `failure`'s code
  answers as its status: 400, 401, 403, 404, 429, else 500.
- **`who`** is `(request, ctx) => actor`, from a credential its plugin knows (a session's cookie, a
  key in `Authorization`). The runtime asks each plugin's in order, and the first that answers wins.
  A request nobody's `who` answers is `{ kind: "anonymous", id: "" }`.
- **Cookies** are set and read by plain name through `ctx.cookies`, and the runtime names them
  (`__Host-<name>` wherever they're Secure).

### Rules: `guard` and `labels`

- **`guard(actor, { collection, access, filter, direct? }, ctx)`** returns the filter an actor's
  documents must match. Reads and deletes reach only what matches it. Inserts, and what updates
  leave, must match it. `true` restricts nothing, and `undefined` means the collection has no rule.
  The owner asks it on every op an actor's work makes. A collection no rule speaks for never reaches
  an outsider's own reads and writes (REST, the socket).
- **`labels`** carries what a job read (a document's space) to what it then writes, so an answer
  drawn from a space not everyone sees is marked. Work done for someone from their own Personal
  space carries nothing: it's theirs.

The access plugin declares both, for the collections its `shared` resource names.

### Workers

`workers: { computer: { admit, ready?, gone?, workloads } }` declares a kind of worker that connects
to the owner as executors do, presenting `<kind>:<secret>`. `admit`, `ready` and `gone` name
Actions. Plugin code sends one jobs with `ctx.workers.dispatch(kind, id, workload, input)`, or
`ctx.workers.call` for one JSON answer. One that isn't connected fails with `offline`.

### Startup checks

`check(merged)` gets the merged `resources`, `adapters`, `views` (their names) and `actions`, and
`call` for other plugins' unrecorded Actions (`models.check`). What it throws stops `createRuntime`,
so a wrong model fails at start, not on the first turn.

## Contexts

What plugin code gets. `Context` is an Action's, a Processor's and a tool's.

| Field                                   | What it is                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `actor`                                 | who this runs for, carried into everything it causes. None: the system                                      |
| `in`                                    | where the work is: its actor's `in`. None: nowhere in particular                                            |
| `db.collection(name)`                   | the collection API. Each write commits on its own                                                           |
| `call(action, input)`                   | calls an Action as `actor`, asking its `allow`                                                              |
| `as(actor?)`                            | this context acting as someone else, or as the system (`as()`), or as a grant. Trusted code only            |
| `transaction(tx => …)`                  | several writes, events and timers, atomic                                                                   |
| `emit(type, data, { id? })`             | commits a declared event                                                                                    |
| `schedule(action, input, when)`         | has time call an Action, and returns the timer's id; `unschedule(id)` removes it                            |
| `record(collection, doc)`               | appends to a ledger with the job's next write, kept even if the job fails                                   |
| `stream(channel)`                       | live frames for subscribers, never stored (tokens being written)                                            |
| `render(name, item)`                    | renders a View                                                                                              |
| `graph`                                 | `link`, `unlink` and `edges` between documents                                                              |
| `branch(key)`                           | this context with its calls numbered apart, for work run at once (a step's tool calls)                      |
| `cancel(target)`, `disconnect(actor)`   | stops a running call or delivery; ends an actor's browsers                                                  |
| `workers`, `fetch`, `metrics`           | workers by kind and id; the outside `fetch` (a test's fake, if given); counters, histograms and gauges      |
| `resources`, `adapters`                 | the merged configuration                                                                                    |
| `kept(key, work)`                       | what a rule works out, kept until a commit changes what it read. Only the owner keeps it; here it just runs |
| `event`, `scheduled`, `retry`, `signal` | the event a Processor handles; the timer that called; whether this ran before; when to stop                 |

`ctx.as(other)` records what it does as `other`, `via` the actor it acted for, and stays where the
work is unless `other` says where (`in`, or `in: undefined` for nowhere). `ctx.transaction` holds
the store's writer: an op in it that fails, a write the rules refuse included, ends it and rolls it
back, and one with no op for 5 seconds rolls back too ([one writer](architecture/the-owner.md)).

The others are narrower:

- **`ReadContext`** (a query's, a rule's): reads, never writes, with `actor`, `in`, `record`,
  `kept`, and `call` for unrecorded Actions.
- **`ViewContext`:** reads that answer at once, `show`, and from handlers `call` and `emit`, with
  `actor`, `in`, `viewer` and `hints`.
- **`ToolContext`** (chat's, in `copilotz/plugins/agents`): a `Context`, so its `in` is where its
  chat is, plus `agent`, `thread`, `trigger`, `callId` (the idempotency key for what it does
  outside), and `ask` and `answer` to wait for a person's reply.

## The runtime

```ts
const runtime = await createRuntime({ store, plugins });
```

| Option      | What it sets                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `store`     | where it keeps everything: memory, SQLite or PostgreSQL                                        |
| `plugins`   | the app: a list of plugins, which may nest                                                     |
| `blobs`     | where large values live (the store, by default); `blobThreshold`: past how many bytes (16 KiB) |
| `cache`     | the owner's read cache (`{ documents, queries }`), or `false`                                  |
| `executors` | executors in this process (1); `transports` and `key` for others to connect                    |
| `metrics`   | where it records metrics (`createMetrics`)                                                     |
| `clock`     | what timers run on: the system's, or `manualClock(start)` in tests                             |
| `fetch`     | what `ctx.fetch` calls outside services with                                                   |
| `browsers`  | how much browsers may hold: sockets, tickets a minute, contacts' together                      |

| Method                                              | What it does                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `call(action, input, { id?, actor? })`              | runs an Action; with `id`, a retry answers from the log                           |
| `query(name, params, { actor? })`                   | runs a collection's named query                                                   |
| `emit(type, data, { id?, actor? })`                 | commits a declared event                                                          |
| `observe(name, item, options)`                      | keeps a View live                                                                 |
| `render(name, item, { viewer?, hints? })`           | renders a View once, as the system                                                |
| `subscribe(listener)`                               | hears committed events and live frames as they happen                             |
| `fetch(request)`                                    | answers HTTP                                                                      |
| `bytes(collection, filter, field, { actor? })`      | a large value's `size` and `read(start, end)`, for host code serving a file       |
| `idle()`                                            | resolves when no delivery or timer is pending and observed Views caught up        |
| `close({ drain? })`                                 | stops, giving running work `drain` ms (5 s) to finish                             |
| `cancel`, `disconnect`, `wake`, `stats`, `describe` | stops a call; ends an actor's browsers; fires due timers; counts; what's declared |

Without `actor`, a call runs as the system. An actor's `in` says where.

The rest of `copilotz`:

- **Running many:** `runtimes(open)`, a pool of runtimes by id, each opened on first use and closed
  when idle ([many orgs](guides/many-orgs.md)). `createOwner` and `createExecutor` place the owner
  and its executors apart ([topology](architecture/topology.md)).
- **The client:** `connect(url, { key?, over?, plugins? })` reaches an app over its socket or its
  REST API ([the REST API and the client](guides/rest-and-the-client.md)).
- **Errors:** `failure(code, message, { public? })`, `forbidden`, `invalid`, `isPublic`. Only a
  public error's words reach a caller outside.
- **Links and addresses:** `signLink`, `verifyLink`, `linksOf`, `clientAddress`, `callerOf`…
- **Metrics:** `createMetrics`, `noMetrics` ([metrics](operations/metrics.md)).
- **Time:** `manualClock`, `systemClock`.
- **Checks:** `validator(schema)`, a JSON Schema check as the runtime runs them.

## Events

The log records what happened, with no bookkeeping tables beside it. Every event has its `type`,
`data`, `cause`, commit time (`at`) and actor, with `for` and `in`.

| Event                                          | When                                               | Its data                                          |
| ---------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| `<collection>.created`, `.updated`, `.deleted` | a write changes a document, in its commit          | `_id`, `doc`; an update also `changed`, `removed` |
| `action.started`                               | a recorded call starts                             | `action`, `input`, `startedAt`, `attempt`         |
| `action.completed`, `action.failed`            | it ends                                            | `action`, `result` or `error`, `ms`, `attempt`    |
| `action.retried`                               | a call runs again                                  | `attempt`, `after`: `failed` or `lost`            |
| `processor.retried`, `processor.failed`        | a delivery failed; the last one is the dead letter | `attempt` or `attempts`, `error`                  |
| a declared event                               | code emits it                                      | what its schema says                              |

- **Collection writes:** the document after the write, the last version for a delete, without
  private fields. A write that changes nothing records nothing. `sys.` collections never record.
- **Action calls:** `started` costs no commit of its own: it lands in the call's earliest commit,
  ahead of all its effects. An Action's `private` fields stay out of both `input` and `result`.
- **Retries:** `runtime.call(action, input, { id })` is retryable. An id that completed answers its
  recorded result without running. One still running is joined. Otherwise the call runs again. An id
  reused for another action or input is refused (`id_conflict`). A call whose executor died fails
  with `executor_lost`. A nested call's id comes from its cause, its place, and its input, so a
  retried delivery finds the calls it already made.
- **Timers:** an occurrence is the call `<timer>@<due time>`, and a failed one runs again as that
  same call.
- **Causes:** every event names its cause, so the log is a tree you walk from any event back to the
  request that started it.
- **Large values:** strings over 16 KiB are stored once, by the hash of their content, and documents
  and events hold a reference in their place. Plugin code never sees one, and a `$blob` key in what
  it writes is refused.
- **Outside effects** (payments, emails): write the intent first, call out with its id as the
  idempotency key, then write the result.

[The log and its Processors](architecture/events.md) are in the architecture.

## Schedules

Time is a caller of Actions. A timer is a document in `sys.timers` naming an Action, its input and
when to call it.

```ts
schedules: {
  "usage.close": { cron: "10 0 * * *", call: "usage.close", input: {} },
  heartbeat: { every: "5m", call: "health.check" },
  "notes.migrate": { once: true, call: "notes.migrate", retries: 5 },
}
```

- **Declared:** by a cron expression (in a `timezone`, UTC by default) or `every` so long (`30s`,
  `15m`, `2h`, `1d`, or milliseconds), with `retries` (2). They patch like resources, and `null`
  removes one. At start the owner makes the timers what the plugins declare. A schedule calling an
  unknown Action, with input its Action refuses, or with a bad cron expression stops the runtime
  from starting. Declared ones run as the system.
- **Run once:** `once: true` runs as soon as the owner starts with it (a deploy) and never again
  while it's declared as it is: its timer stays, without a time, as the record that it ran. Declared
  otherwise (another input), it runs again. One that didn't finish, its retries spent, gets another
  go each time the owner starts, until it's done. For migrations of what's kept: its Action must be
  safe to run again, as the owner may stop in the middle of it. Only the owner holding the store
  runs timers, so instances started together run it once.
- **From code:** `ctx.schedule(action, input, { at | cron | every, id?, retries? })` sets a timer
  with the call's writes, and `ctx.unschedule(id)` removes it. In a transaction, `tx.schedule`
  commits with the rest. Scheduling an id again replaces its timer. Without an `id`, a retried call
  sets the same timers again rather than more. A declared timer can't be changed from code.
- **As whom:** a timer set by an actor runs as them, where they were, and its call asks `allow`.
- **Once:** the owner claims what's due in one commit and calls each occurrence as
  `<timer>@<due time>`, so an occurrence called twice runs once. A recurring timer that missed
  several times fires once, then keeps its beat.
- **Retries:** a failed occurrence tries again after 10 s, 30 s, 90 s…, up to an hour apart.
  `action.failed` stays on record for Processors to answer.
- **The clock is a port:** `createRuntime({ clock })`. `manualClock(start)` moves only when a test
  says so (`advance`, `set`). A host whose clock only rings, like a Durable Object's alarm, calls
  `runtime.wake()`. `copilotz.timer.lateness` measures how late occurrences were called.

## Models and providers

A model is `"provider/model"`, with its settings next to it.

```ts
resources: {
  provider: {
    openai: { apiKey },                       // the catalog knows its protocol and address
    deepseek: { apiKey },                     // OpenAI-compatible, at api.deepseek.com
    local: { adapter: "openai-compatible", baseURL: "http://localhost:11434/v1" },
    chatgpt: { adapter: "openai", catalog: "openai", headers: () => oauthHeaders() },
  },
  model: { cheap: { model: "openai/gpt-5.4-mini", effort: "low" } },   // aliases
  agents: {
    lead: { instructions, model: "openai/gpt-6.1-sol", effort: "low" },
    // A list is tried in order when a model fails before writing anything.
    north: { instructions, model: ["chatgpt/gpt-6.1-sol", "anthropic/claude-opus-5-5"], effort: "low" },
  },
  history: { summarizer: "cheap" },
  memory: { embedder: { model: "openai/text-embedding-3-small", dimensions: 512 }, extractor: "cheap" },
}
```

- **A `provider`** is an account or an endpoint: `baseURL`, `apiKey` (the provider's usual auth
  header), `headers` (added last; a function computes them per request, hearing whom the call is
  for), `adapter` (the protocol: `openai`, `openai-compatible`, `anthropic`, `gemini`, or a plugin's
  own), `catalog` (whose entries its models use, `false` for none), `options`, `tags`, `silence` and
  `retry`.
- **The catalog** is a snapshot of [models.dev](https://models.dev). It fills in what a provider
  leaves out: its protocol and address, and each model's prices, limits and how its reasoning is
  controlled.
- **Settings** sit next to a model, per port: `effort`, `maxTokens` and `temperature` for language
  models, `dimensions` for embeddings, and `options` (sent as they are) for all. Settings where a
  model is used win over an alias's, and a list entry's win over its list's.
- **`effort`** is one scale for every provider: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
  `max`. A level a model doesn't take stops the runtime from starting.
- **Checked at start:** chat checks every agent's model, history its summarizer, memory its embedder
  and extractor, so a missing provider or a wrong effort fails `createRuntime`, not a turn.

Action inputs name models and never carry keys, because inputs are recorded. A plugin adds an
adapter under `adapters.llm`, `adapters.embeddings`, `adapters.transcription` or `adapters.image`,
named by the protocol it speaks. The [models page](reference/plugins/models.md) lists its Actions.

## The web's look and words

- **The theme:** the web host owns a vocabulary of tokens and its defaults, which are Copilotz's
  look. An app rebrands with a `theme` resource (`{ radius, font, logo, light, dark }`), applied
  from the first paint. Front ends compose the host's toolkit (`Button`, `Menu`, `Dialog`,
  `Markdown`…), and their own CSS is only layout, on the theme's variables. The default fonts are
  served under `/assets/copilotz/`. A theme's own come from Google Fonts or from the app's
  `page.assets`.
- **Words:** every word the web front ends show is English by key (`chat.send`), and an app changes
  any with a `words` resource. The keys and their English are in
  [WORDS.md](https://github.com/copilotzhq/copilotz/blob/main/hosts/web/WORDS.md). Blanks are
  `{name}`. Plurals are an object by the language's plural categories, chosen by `{count}`. Dates,
  numbers and currency follow the page's language, `page: { lang: "pt-BR" }`.
- **Your own front end** says its words the same way: `const say = defineWords("acme", { … })`, then
  `say("key", { name })`.

[Serving on the web](guides/serving-on-the-web.md) shows the page, its theme and the sign-in page's
words.

## Plugins

Each plugin's page is read from the plugin itself: what it keeps, who may call each Action, where it
shows, what it needs, and what it builds on. [The index](reference/plugins.md) lists them all, and
`reference/plugins.json` has the same as data.

- **Models:** [`models`](reference/plugins/models.md).
- **Agents:** [`chat`](reference/plugins/chat.md) ([web](reference/plugins/chat-web.md),
  [terminal](reference/plugins/chat-terminal.md)), [`history`](reference/plugins/history.md),
  [`memory`](reference/plugins/memory.md) ([web](reference/plugins/memory-web.md),
  [terminal](reference/plugins/memory-terminal.md)) with
  [`memoryExtraction`](reference/plugins/memory-extraction.md),
  [`skills`](reference/plugins/skills.md) ([web](reference/plugins/skills-web.md)),
  [`routines`](reference/plugins/routines.md) ([web](reference/plugins/routines-web.md)),
  [`openapi`](reference/plugins/openapi.md), [`webTools`](reference/plugins/webTools.md).
- **Access:** [`spaces`](reference/plugins/spaces.md) ([web](reference/plugins/spaces-web.md),
  [terminal](reference/plugins/spaces-terminal.md)), [`identity`](reference/plugins/identity.md),
  [`contacts`](reference/plugins/contacts.md) ([web](reference/plugins/contacts-web.md)),
  [`googleSignIn`](reference/plugins/google-sign-in.md),
  [`emailSignIn`](reference/plugins/email-sign-in.md), [`email`](reference/plugins/email.md),
  [`devSignIn`](reference/plugins/dev-sign-in.md).
- **Billing:** [`usage`](reference/plugins/usage.md) ([web](reference/plugins/usage-web.md),
  [terminal](reference/plugins/usage-terminal.md)).
- **The doors:** [`webPage`](reference/plugins/web-page.md),
  [`webShell`](reference/plugins/web-shell.md), [`webLines`](reference/plugins/web-lines.md),
  [`terminalPlugin`](reference/plugins/terminal.md),
  [`terminalShell`](reference/plugins/terminal-shell.md), [`api`](reference/plugins/api.md)
  ([web](reference/plugins/api-web.md)), [`mcp`](reference/plugins/mcp.md),
  [`whatsapp`](reference/plugins/whatsapp.md) ([web](reference/plugins/whatsapp-web.md)),
  [`voice`](reference/plugins/voice.md), [`maintenance`](reference/plugins/maintenance.md).

From the [product packages](#product-packages):

- **`@copilotz/work`:** [`boards`](reference/plugins/boards.md)
  ([web](reference/plugins/boards-web.md)), [`documents`](reference/plugins/documents.md)
  ([web](reference/plugins/documents-web.md)).
- **`@copilotz/team`:** [`team`](reference/plugins/team.md) ([web](reference/plugins/team-web.md)),
  [`tiers`](reference/plugins/tiers.md) ([web](reference/plugins/tiers-web.md)).
- **`@copilotz/directory`:** [`directory`](reference/plugins/directory.md)
  ([web](reference/plugins/directory-web.md)) and what each org gets of it,
  [`directory.member`](reference/plugins/directory-member.md).
- **`@copilotz/billing`:** [`credits`](reference/plugins/credits.md)
  ([web](reference/plugins/credits-web.md)), [`stripe`](reference/plugins/stripe.md),
  [`stripeWebhook`](reference/plugins/stripe-webhook.md).

The compute plugins (`computers`, `cloud`, `apps`) and `accounts` have no page here.
[Installing a computer](guides/installing-a-computer.md) covers what an app serves for computers.
