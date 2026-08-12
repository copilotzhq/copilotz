# Changelog

## 0.59.13 — 2026-08-12

This patch preserves historical workflows whose legacy conversation threads were
deleted before the one-way v1 upgrade.

### Fixed

- Legacy tool executions and LLM attempts with an unavailable thread now share
  an archived tombstone thread for that original thread ID instead of aborting
  the tenant transaction.
- Workflow and tombstone metadata explicitly records orphan recovery, and
  settled event references continue to resolve without attaching history to an
  unrelated live conversation.

## 0.59.12 — 2026-08-12

This patch adopts Ominipg `0.9.0-rc.8` and exposes its configurable session
request timeout through managed Copilotz persistence.

### Fixed

- Long-running migration and analytical queries can opt into a request timeout
  above Ominipg's unchanged 30-second default.

## 0.59.11 — 2026-08-11

This patch completes the legacy null-content migration fix without losing
available partial model output.

### Fixed

- Legacy LLM attempts still prefer `partialAnswer` or `partialReasoning` when a
  final field is null; JSON `null` is preserved only when no partial fallback
  exists.

## 0.59.10 — 2026-08-11

This patch preserves explicit null output fields during the one-way v1
migration.

### Fixed

- Legacy LLM attempts with an explicit `null` answer or reasoning value and no
  partial fallback now materialize that value as valid JSON `null` instead of
  producing an empty JSON asset and aborting the tenant transaction.

## 0.59.9 — 2026-08-11

This patch aligns durable tool-execution identity with provider behavior found
in long-lived production threads.

### Fixed

- Provider tool-call IDs are indexed as repeatable lookup labels instead of
  being treated as globally unique within a thread. Durable node/event IDs
  remain the canonical execution identity.
- Re-provisioning an existing v3 schema removes the obsolete unique tool-call
  index, and the v1 migration preserves every historical execution when a
  provider reuses a call ID across attempts.
- Singular tool-call lookup now deterministically returns the latest matching
  execution; exact callers continue to address executions by their canonical ID.

## 0.59.8 — 2026-08-11

This patch adopts Ominipg `0.9.0-rc.7` throughout Copilotz.

### Fixed

- Large database request and response frames now cross Oxian as bounded,
  backpressured stream chunks instead of exceeding the worker staging limit.
- Downstream applications resolve one consistent Ominipg release rather than
  retaining the previous transitive version alongside a direct upgrade.

## 0.59.7 — 2026-08-11

This patch reconciles a legacy message's logical scope with its canonical thread
during the one-way v1 upgrade.

### Fixed

- A message whose legacy namespace differs from its readable thread now adopts
  the thread namespace atomically instead of aborting the tenant migration.
- Outgoing edge scope follows the moved message, and migration metadata retains
  the original namespace for auditability.

## 0.59.6 — 2026-08-11

This patch makes bounded v1 node pagination safe with PostgreSQL timestamp
decoding.

### Fixed

- Migration cursors now round-trip the database's exact `timestamptz` text,
  preserving microseconds instead of re-reading the final page after a driver
  converts timestamps to millisecond-precision JavaScript dates.
- The bounded-batch regression test emulates PostgreSQL timestamp decoding with
  microsecond-distinct rows and fails fast if a cursor stops advancing.

## 0.59.5 — 2026-08-11

This patch preserves unavailable legacy JSON assets without inventing invalid
database bodies.

### Fixed

- Missing legacy `application/json` bodies use a valid `null` sentinel whose
  bytes, length, and digest agree while the asset remains explicitly failed and
  unreadable.

## 0.59.4 — 2026-08-11

This patch makes the one-way v1 database upgrade safe for large production
tenant histories.

### Fixed

- Multi-gigabyte upgrades translate events with one set-based database operation
  and normalize nodes in bounded keyset batches instead of loading whole tenant
  histories into application memory.
- Bulk graph and event copies return aggregate counts instead of materializing
  every inserted identifier in the migration process.

## 0.59.3 — 2026-08-11

This patch makes the v1 content migration loss-aware for production databases
whose historical filesystem assets are only partially available.

### Fixed

- Legacy message attachments become ordered canonical content references while
  retaining compatibility metadata.
- Asset resolvers can explicitly preserve unavailable bodies as `failed` or
  `abandoned` records; unexpected resolver failures still roll back the tenant.
- Failed legacy assets remain addressable and report not-ready reads instead of
  receiving invented empty content or blocking unrelated tenant migration.

## 0.59.2 — 2026-08-11

This patch restores graph-native conversation details required by embedded and
HTTP clients while keeping the event-native contracts authoritative.

### Fixed

- Thread names and descriptions are preserved by create, update, channel
  ingress, and the isolated v1 database upgrade.
- Channel thread participants are now independent from per-message recipients,
  so passive participants do not accidentally receive work.
- Thread participant filters accept either the internal participant ID or its
  stable external ID.
- Message history supports `before` cursors and ascending or descending order,
  enabling latest-first windows and chronological client pages without offset
  pagination.
- Tool-call-only LLM turns now create their public agent-message anchor instead
  of disappearing from durable conversation history.
- The v1 Fetch projection emits explicit SSE `event:` names, restoring the
  uppercase stream contract expected by existing clients.

## 0.59.0 — 2026-08-11

This pre-1.0 minor makes shared persistence and physical-schema routing
first-class without multiplying Copilotz execution infrastructure.

### Added

- Application-owned Ominipg database injection through the public `database`
  option. Copilotz adapts the database internally and never closes an injected
  instance.
- Lazy `databaseScope(name)` application views and per-operation
  `databaseSchema` routing. Every schema gets isolated repositories and event
  observation while sharing one database, Gateway/Worker topology, and Oxian
  executor.
- Trusted `resolveDatabaseSchema(request)` Gateway routing for multi-tenant HTTP
  applications. Untrusted request context can confirm, but cannot choose, a
  physical schema.
- Atomic named collection commands through `defineCollection({ commands })` and
  `POST /collections/:name/:id/commands/:command`. Commands lock the aggregate,
  validate the resulting record, emit one semantic event, and honor idempotency
  keys.
- Feature response headers across JSON, empty, and streaming Fetch responses.

### Changed

- Ominipg advances to `0.9.0-rc.6`, whose operation lane makes one shared
  database instance safe across Gateway and Worker transaction boundaries.
- Delivery, live-event, and realtime workload metadata now carry the physical
  database schema so detached Workers resolve the correct durable scope.
- Goal, channel, attachment, recovery, and maintenance capabilities resolve
  against the same lazy schema boundary.

### Removed

- The public SQL-session injection vocabulary, `closeSession`, and managed
  session factories. SQL sessions remain a package-private persistence seam;
  applications configure or inject a database.

## 0.58.0 — 2026-08-10

This pre-1.0 minor release makes Copilotz topology explicit while keeping the
ordinary embedded application simple.

### Added

- `createCopilotzGateway()` for durable ingress, HTTP Fetch handling, recovery,
  event relay, and Oxian placement without hosting plugin execution.
- `createCopilotzWorker()` for outbound in-process or WebSocket Workers that
  reconstruct plugin executors locally.
- One versioned framed Worker-output protocol for semantic events, response
  metadata, raw bytes, cancellation, and completion across both transport types.
- Runtime-neutral `gateway.fetch` and capability-oriented `listen(gateway)` on
  the Deno adapter.
- In-process and real-WebSocket contracts covering cascading durable work,
  ephemeral output, realtime stream bytes, frame non-persistence, injected
  infrastructure ownership, and capacity-one Workers.

### Changed

- `createCopilotz()` now composes a private Gateway and Worker over an
  in-process Oxian event fabric while exposing only application semantics.
- Detached Worker events return to the Gateway immediately; their durable
  delivery obligations are placed there while Ominipg remains the recovery
  authority.
- Causal completion waits for correlated output relays before its final database
  confirmation, eliminating the final-frame/settlement race.
- Run contracts now use the direct `RunInput` and `RunHandle` vocabulary instead
  of event-native-prefixed aliases.
- Gateway, Worker, and embedded products remain frozen factory records with
  closure-held state and explicit infrastructure ownership.

### Removed

- Public engine/application assembly factories and raw workload maps. Engine,
  delivery-executor, and framed-protocol composition are package-private.
- `application.engine`, `application.execution`, and embedded Hypervisor or
  transport leakage.
- Public event-native server assembly; v3 HTTP is `gateway.fetch`, while the
  `/server` subpath retains only the transitional v1 projection.
- The `/engine` and `/execution` package entry points.

## 0.57.0 — 2026-08-08

Copilotz v3 is an intentionally breaking pre-1.0 architecture release.

### Added

- Factory-created applications, engines, plugins, processors, resources, and
  runtime adapters.
- Canonical immutable content/assets shared by messages, tools, model attempts,
  knowledge, memory, and finalized media.
- Immutable positioned semantic events plus sparse, durable consumer deliveries
  with leases, retries, dead letters, causal settlement, recovery, and
  compaction.
- Oxian execution with private in-process, injected shared-hypervisor, and
  remote dispatcher placement.
- Graph-native participants, threads, messages, model attempts, tool executions,
  custom collections, relations, schedules, memory, usage, and knowledge.
- Public same-thread agent `ask`, persistent attachments, one-call Web Stream
  ingress, participant-labelled concurrent outputs, and realtime provider
  capabilities.
- Runtime-neutral core and explicit Deno, Node, MCP stdio, server, filesystem,
  terminal, and package-loader adapters.
- Agent Skills-compatible manifests, portable lazy skill resources, optional
  plugin-owned disclosure tools, and a Deno build-time directory packer.
- Explicit least-authority agent capabilities, derived ask/skill mechanisms, and
  canonical application introspection with plugin origins.
- Worker-local Oxian workload maps for embedded or outbound registration.
- An isolated one-way v1 database upgrade and transitional v1 HTTP/SSE boundary.

### Changed

- Package composition now uses validated plugins and stable resource IDs.
- `run()` is a temporary attachment over one causal scope; `connect()` owns
  persistent text/control/media interaction.
- Collection post-write behavior is expressed as independent named processors.
- Ominipg is the durable state/recovery authority; Oxian owns work placement.
- Copilotz now targets Oxian `0.21.0-rc.2`'s shared event-fabric lifecycle and
  Ominipg `0.9.0-rc.5`. Embedded Hypervisors and Workers share an explicit
  transport record; Workers auto-start and expose `ready` / `closed` promises.
- Standard Agent Skills directories are canonical source while generated plugin
  modules are runtime artifacts; generic applications install no skills by
  default.
- Runtime-specific adapter subpaths expose capability-oriented factory names;
  host names no longer repeat in their public symbols.
- Workspace and process adapter plugins use runtime-independent logical IDs,
  allowing equivalent host implementations to replace them by capability.
- The interactive CLI coalesces one streamed tool-call draft into one labelled
  tool line while preserving argument deltas for other event consumers.
- Provider and text workflows are the only default core plugins; tools, web,
  finance, memory, usage, ask, schedules, knowledge, and skills are opt-ins.
- The interactive CLI reads agents, tools, and skills from application
  introspection instead of accepting disconnected display arrays.
- The package advances from 0.56.x to 0.57.0 while adopting the v3 public API
  and architecture.

### Removed

- The queue worker/scheduler architecture, thread leases, run generations,
  supersession/coalescing, processor claiming/swallowing/priority phases, and
  legacy resource filesystem loader.
- Private agent delegation/consultation, post-write hooks, public raw graph
  mutation APIs, dual thread storage, compatibility aliases, and stateful
  service-class assembly.
- Unconditional host-runtime imports from the core.
- The statically imported Copilotz development-skill catalog, generated
  per-skill data modules, core skill tools, and injected filesystem reader.
- Agent `allowed*` fields, implicit all-resource inheritance, and static CLI
  agent/tool metadata.

See [the v3 migration guide](docs/migration-v3.md) and
[downstream migration matrix](docs/v3/downstream-migration.md).
