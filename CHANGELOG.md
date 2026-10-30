## Unreleased

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
