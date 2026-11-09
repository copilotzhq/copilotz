# STAGING: architecture (not published)

> **Staging, not a page.** This file holds the old README's content destined for the architecture
> pages, copied verbatim from the README of 1.0.0-rc.31 (`git show v1.0.0-rc.31:README.md`), so
> nothing is lost while the architecture waits for a runtime change. It's not in
> `docs/manifest.json`, and the website doesn't show it. Headings, links and code are as they were
> in the README: relative links are relative to the repository's root, not to this folder. Rewrite
> it into `docs/architecture/` in the guide voice, check every claim against the code, then delete
> this file.
>
> The Shape section's bullets on the design system and on words are in `reference.md`, beside this
> file. The Layout section and the layers' import rules are in `CONTRIBUTING.md`.

## From the old README: its opening

One runtime for agents and the apps around them, on Node, Deno, Bun, Cloudflare Workers and the
browser.

An app is plugins: agents that answer with tools and talk to each other and to people, conversations
in shared spaces, memory, skills and routines, a usage ledger, people's computers, sign-in and
connected accounts, a developer API, WhatsApp, phone calls. Each is a plain object built from the
same few primitives (collections, Actions, Processors, Views, resources and adapters), and the
runtime knows nothing else. Everything durable is an event, a document, an edge, a vector or a blob,
written by one owner to one store (memory, SQLite or PostgreSQL), so every change is on the record
and every screen follows it live: in a terminal, in a browser, or in an agent's prompt.

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
  output stream back to it. Oxian takes a stream in chunks of at most 1 MiB, so a line longer than
  that (a long history, a prompt with pictures) goes in parts; what's meant to be large (a file's
  content) isn't put in an answer at all: host code reads it from the owner in parts
  (`runtime.bytes`, see Blobs).
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
  and the transport and listener (Oxian, whose Hypervisor takes fetch-style upgrades). The runtime
  is a fetch handler itself (`runtime.fetch`): `Deno.serve` serves it as it is, workerd too, and
  `copilotz/web/node`'s `listen` is the listener on Node and Bun.
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
  Adapters (port implementations); and, for HTTP, routes and `who`. It never knows what a plugin is
  for.
- **Plugins merge in order.** Collections, Actions and Processors are unique. Resources are
  configuration: a later plugin patches an earlier one's entries (JSON Merge Patch: objects merge,
  `null` removes, the rest replaces). A later View or adapter replaces an earlier one of its name.
  Then each plugin's `check` validates what it understands of the result.
- **Five things persist:** events, nodes (documents), edges, vectors and blobs. That's the storage
  port (`runtime/store.ts`).
- **Collections speak MongoDB:** `ctx.db.collection("x").insertOne/find/updateOne(...)`, with the
  usual filter and update operators. The runtime translates each call into one store operation,
  which the memory store runs in JavaScript and the SQL stores translate to SQL. `find` and
  `findOne` take a `projection` (`{ name: 1 }` keeps fields, `{ data: 0 }` leaves them out), which
  the owner applies before it loads any blob: a file's metadata costs no read of its content.
- **Queries** are named reads declared on a collection
  (`queries: { history: (messages, params,
  ctx) => … }`). Clients call
  `runtime.query("message.history", params)`; plugin code calls
  `ctx.db.collection("message").query("history", params)`. They never write. An actor calling from
  outside runs only those that let them (`{ allow, run }`, as Actions); a bare function is the
  system's.
- **Views** are each plugin's front end, found by name (see [design/views.md](design/views.md)):
  `views: { "booking.panel": BookingPanel }`. A name says what the View shows; where the same thing
  is shown in several places it takes the place as a prefix (`llm.message`, `web.message`,
  `terminal.message`, `whatsapp.message`, `voice.message`; likewise `thread`, `memory`, `live`,
  `shell` and `spaces`), and `ctx.show("web.message", m)` shows exactly the View it names. A host
  asks for its own default (`web.default`, `terminal.default`) when a name has no View.
  `runtime.render(name, item)` renders one once (an agent's prompt);
  `runtime.observe(name, item, { part })` keeps one live: it runs again when a commit changes a
  document it read, and each View it shows (`ctx.show`) is a part that runs again on its own. Views
  call Actions from their handlers (`ctx.call`, `ctx.emit`).
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
- **HTTP is the runtime's:** `runtime.fetch` answers every request: its own paths (`POST /connect`,
  the socket at `/oxian`, the REST API at `/api/`) and plugins' `routes`, plain functions by URL
  pattern (a webhook, a sign-in, an OAuth callback, a download, a socket of their own), each as
  whoever plugins' `who` say the request is. Hosts only listen (`Deno.serve(runtime.fetch)`,
  `listen(runtime.fetch)`); cookies are named and set by the runtime, through `ctx.cookies`.
- **The web** (see [design/views.md](design/views.md), "The web") runs Views in the browser. The
  page's cookie (a person's session, a site visitor's) trades for a one-time ticket
  (`POST /connect`), and it connects to the owner over Oxian as an untrusted worker bound to that
  actor (`web({ plugins, root })` in the browser; the page plugin, `webPage`, serves the page). A
  browser reads a collection directly only when a rule speaks for it; anything else, through queries
  that let its person. Writes are Actions, or direct where a rule speaks for the collection's
  writes. Files people sent are chat's route, `/files/<id>`, for whoever may read them, with ranges.
- **The design system** and **Words**: see `reference.md`, beside this file.
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
  calls, never holds the writer. An op in a transaction that fails, a write the rules refuse
  included, ends it: it rolls back, and its later ops fail, even when the error is caught. One with
  no op for 5 seconds rolls back too.
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
