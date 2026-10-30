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
