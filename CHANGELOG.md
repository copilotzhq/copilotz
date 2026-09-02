# Changelog

## 0.65.2 — 2026-09-02

Closes the public read boundary for semantic memory. `search_memory` now returns
a bounded public summary and `inspect_memory` returns a bounded semantic detail,
both with closed output schemas. Storage internals—including embeddings,
namespaces, memory-space/thread/consolidation identifiers, and edge metadata—
are never projected. Results, sources, and relations have explicit budgets and
truncation/count semantics while preserving memory-space authorization.

## 0.65.1 — 2026-09-01

Preserves bounded, sanitized error details from structured OpenAPI and NDJSON
tool responses, including terminal errors carried by successful HTTP streams.
Opaque response payloads continue to use a fixed safe fallback.

## 0.65.0 — 2026-09-01

Breaking: progressive streams now have one retained terminal contract. Body
stores must expose ranged reads, renewal, and terminalization; published streams
always settle with a canonical terminal outcome, including retained failed or
cancelled prefixes. Replay cursors use only operation-local lane ordinals, and
malformed LLM tool-call attempts are retained as bounded, canonical failure
evidence rather than speculative action calls.

## 0.64.3 — 2026-08-31

Fixes long-running conversation history after a Thread exceeds 1,000 Messages.
Collection cursors now use stable ordered keysets, Core routes from one
trigger-anchored, branch-aware chronological snapshot, and public history pages
the true newest records instead of truncating the oldest prefix. Thread activity
also selects the latest Event correlation without an oldest-page cutoff.

## 0.64.2 — 2026-08-31

Fixes reconnect history while an operation is active in a tenant database
schema. Message history now checkpoints active operations in the same trusted
schema scope, avoiding transient `operation_not_found` responses on refresh.

## 0.64.1 — 2026-08-31

Clarifies the storage-provider compatibility boundary used by the Compass/GCS
interoperability hotfix. AWS Signature Version 4 HMAC clients must select
`provider: "s3"`; `x-goog-*` coordination requires GOOG4 signing and is not safe
through `s3-lite`. Storage behavior is unchanged in this metadata-only patch.

## 0.64.0 — 2026-08-31

Adds durable, reconnectable application operations. A submitted root Event is
now also the generic operation identity; callers can detach an HTTP observer
without cancelling durable work, resume ordered Events and progressive Bodies
from an opaque cursor on any replica, inspect operation state, and issue an
explicit idempotent cancellation. The Server facade supports asynchronous
receipts, operation output feeds, thread feeds, replay cursors, and SSE
keepalives. Additive operational tables index discovery and offsets while
canonical Events and Assets remain the state and payload authorities.

Progressive storage is now bounded and maintainable across every built-in Body
backend. Live process buffers are released and capped, database parts compact at
seal, crashed filesystem/object staging is enumerable and retry-cleanable, and
temporary observation Bodies expire through guarded maintenance. LLM frame
writes are coalesced, and an exact media-type/length/digest match dynamically
reuses the streamed Body for the normalized final Asset; non-equivalent output
keeps its separate canonical Asset without duplicating a stream Asset.

## 0.63.9 — 2026-08-31

- Semantic memory now distinguishes an object's lifecycle from its editorial
  validity. Records carry `valid`, `retracted`, `superseded`, or `archived`
  validity, and ordinary context, consolidation, and search exclude records that
  are no longer editorially visible while history and inspection retain them.
- Adds the narrow, provenance-bound `invalidate_memory` tool for retraction,
  supersession, and archival. It preserves domain lifecycle, enforces writable
  memory-space access, is idempotent for identical retries, and rejects
  conflicting dispositions.
- `consolidate_memory` publishes a discriminated public input schema and an
  auditable output contract with canonical created/reused record IDs. Invalid
  on-demand consolidation now settles its owned pending checkpoint as failed.

## 0.63.8 — 2026-08-29

- Persistence now recognizes typed Oxian session-loss outcomes, retires the
  affected OminiPG generation, and returns a bounded indeterminate error without
  replaying the in-flight database operation.
- OminiPG advances to `0.9.0-rc.11` and Oxian to `0.21.1`. In-process workers no
  longer self-expire after a request-scoped CPU pause, while WebSocket workers
  retain heartbeat lease fencing.

## 0.63.7 — 2026-08-29

Makes Gateway delivery recovery continuous and restart-safe. Gateways now sweep
already-ready persistence before serving, arm one schema-scoped wakeup for the
next persisted retry or lease-expiry deadline, and recover dynamically opened
database scopes. A process that restarts before an abandoned lease expires can
therefore resume the delivery after expiry instead of leaving it permanently
leased. Worker roles remain passive, filtered recovery cannot widen its scope,
and recovery timers are cancelled at shutdown.

## 0.63.6 — 2026-08-29

Adds bounded raw Asset uploads to the compiled Server facade. `POST /assets`
publishes directly to the configured Asset body store, supports exact idempotent
replay, and returns a canonical attachment ContentRef without copying bytes into
Action or Event payloads. Streaming request limits are enforced while consuming
the body, including chunked uploads without a declared content length.

LLM calls now preserve the ContentRef disposition boundary: attachments and
unspecified files become deterministic `asset://` descriptors for Asset Tools,
while only explicitly inline content is materialized into provider requests.

## 0.63.5 — 2026-08-28

Routes semantic-memory consolidation through the owning Agent's ordinary Core
Message, prompt, Model, credential, Tool-plan, Ask, and Action lifecycle. A
generic private Agent-turn scope keeps background work out of public history,
while `consolidate_memory` remains available in ordinary turns and provider
prompt prefixes stay cache-compatible. The obsolete Memory-owned Model list,
maintenance Action, direct LLM loop, and manual Tool parser are removed.

Also adds trusted shared prompt-instruction Resources, durable channel thread
membership, recoverable model-authored Tool input validation, explicit
scheduled-message recipient selection, correlation-scoped thread activity, and
safe progressive-stream failure diagnostics.

## 0.63.4 — 2026-08-26

Keeps routed LLM work inside the originating durable settlement scope so Web
Channel request observation remains open through delayed Agent output and
cancels provider work with its parent request.

## 0.63.3 — 2026-08-25

Aligns the retained package-configuration contract with the JSR-safe explicit
self-import graph introduced in 0.63.2.

## 0.63.2 — 2026-08-25

Restores explicit package self-import mappings for every public export so JSR
can construct the publication module graph. The package-surface gate now
requires those mappings to mirror `exports` exactly.

## 0.63.1 — 2026-08-25

Adds the schema-level Secret lifecycle, compiled Server façade, named Collection
query schemas, and trusted event recovery required by the Compass 0.63
migration. Secret-bearing Action values are encrypted through a process-local
Adapter, remain redacted in ordinary observation, and never become public
Assets.

## 0.63.0 — 2026-08-25

Final plugin-first runtime and deployed-data migration release.

### Breaking

- The root now exposes one application factory and the narrow
  `{ send, observe, close }` surface. Runtime internals, semantic DTOs, and host
  capabilities live on explicit subpaths or inside their owning plugins.
- LLM calls and every concrete Tool are native Actions. Built-in providers are
  selected directly by ordered Model Resources; custom LLM Adapters remain
  application-owned. Tool Resources are data-only presentations of the same
  Action aliases Core invokes.
- Channels, Memory, Knowledge, Skills, Schedules, Usage, and Admin are ordinary
  plugins built from Collections, Actions, Processors, Resources, and Adapters.
  The former Goals workflow plugin is replaced by the local Core `runGoal`
  authoring loop over settled application sends.
- `/domain`, `/attachments`, `/adapters`, `/adapters/node`, `/migration/v1`,
  `/migration/content-v2`, and `/migration/memory-v4` are removed.
- Provider-aware token estimation moves from the generic `/tokens` subpath to
  `/llm/tokens`; mutable calibration is now private to the LLM plugin.

### Added

- Generic application stream observation through `/streams`, with one
  subscriber-owned byte follower per `stream.output` descriptor.
- Resolved immutable Event data on `send().outputs` and `observe()`, retaining
  each durable Event's original body reference.
- Minimal target/lead Goal conversations through `/goals#runGoal`; ordinary Core
  Messages and Action lifecycles remain their only durable record.
- Core-owned conversation contracts, projections, and portable CLI adapters on
  `/core`, `/core/cli`, and `/core/cli/node`.
- Parallel Tool branches with sequential `jq` pipelines, durable fan-in, nested
  Agent asks, public/private Ask history, and participant-aware CLI streaming.
- Frozen Agent instruction hooks, Tool/API authoring helpers, reusable dynamic
  LLM credential Resources, and built-in provider Models that require no
  manually instantiated provider Adapter.
- Per-provider-attempt Usage accounting. Framework-rejected streams drain to
  final metering before recovery, while credentials remain process-local and
  absent from Action lifecycle data.
- OpenAPI response Asset promotion for configured data URL/base64 fields, with
  canonical Asset references replacing raw media payloads.
- The sole deployed-data migration, `/migration/v4#migrateToV4`, for the exact
  legacy graph profile used by Copilotz 0.47/0.48. It archives old tables,
  creates ordinary v4 source Events, rebuilds and verifies projections, and
  writes the v4 readiness marker only after successful verification.

### Verified

- A frozen real Gilpinna 0.48 PGlite fixture preserves all 12 messages and both
  original Asset byte streams, resumes after a crash immediately before the
  readiness marker, and continues through the final Core/LLM seam.
- The package passes the complete type, architecture, boundary, runtime test,
  and publish dry-run ladder.

## 0.62.1 — 2026-08-24

Published the initial plugin-first v4 baseline and repaired its PostgreSQL
schema-readiness gate. Version 0.63.0 finalizes the physical plugin layout and
public package surface before 1.0.

## 0.61.0 — 2026-08-18

Plugin-first event-sourced core. Conversation collections, text/ask processors,
and bundled vendor adapters ship on `@copilotz/core`. Runtime keeps host
mechanism and does not own a vendor catalog.

### Added

- Static `corePlugin` / `coreCollectionsPlugin` with participant, thread, and
  message Collections plus LLM and Tool Features.
- `llm` resources expose `generate()`. Shipped adapters live on the core plugin
  as `{ id, type: "llm", generate }`.
- `copilotz.core.thread-message` `create` feature for ensure-participant, thread
  membership, and `message.create` in one transaction.
- Direct Feature action calls through `context.features.<alias>.<action>(...)`
  and `context.feature(definition).<action>(...)`.
- Persisted Feature Action lifecycle events derived automatically from the
  Feature/action identity; operational LLM/tool Collections are gone.

### Changed

- Core processors and writes use bound collections and `CollectionRecord`.
  Application ingress is `send(core.message(...))`; session output is observed
  through `observe()`.
- `chat()` requires an explicit provider registry. No hardcoded vendor map in
  runtime. `generateFromFactory` binds one adapter as one resource.
- Package-root `createCopilotz` injects `canonicalCore: [corePlugin]`.
- `agent.runtime` replaces `llmOptions` and `runtimes.text` /
  `runtimes.realtime`. Same-mode `fallbacks` feed `runGenerateChain`.

## 0.60.18 — 2026-08-15

- Treat the successful signed conditional PUT as the canonical acknowledgement
  for new immutable objects, removing the redundant post-upload HEAD while
  retaining HEAD-based verification for resumable conflicts.
- Feed each byte-bounded body slice continuously through the upload pool instead
  of imposing upload-count synchronization barriers.

## 0.60.17 — 2026-08-15

- Permit up to 128 concurrent object writes for high-latency small-asset
  migrations while bounding each fetched body slice by a configurable total byte
  budget.

## 0.60.16 — 2026-08-15

- Fetch database asset bodies in upload-sized SQL batches before bounded
  concurrent object writes, eliminating one database round trip per asset while
  retaining the upload-concurrency memory cap.

## 0.60.15 — 2026-08-15

- Relocate database assets through metadata-only keyset pages and fetch one body
  per active uploader, bounding resident body memory by upload concurrency
  instead of page size.
- Add an interruption-safe partial relocation index so resumable runs avoid
  repeatedly scanning unrelated graph nodes.

## 0.60.14 — 2026-08-15

- Release completed S3-compatible PUT response streams immediately, avoid
  copying upload buffers, and isolate decoded bodies in short-lived page frames,
  keeping long-running object relocation memory-bounded.

## 0.60.13 — 2026-08-15

- Amortize concurrent content-v2 repair commits with bounded, partition-safe
  semantic transaction batches.
- Use conditional S3-compatible PUT as the immutable-object existence probe,
  removing one network round trip for every newly relocated asset while
  retaining post-write checksum verification and idempotent conflict handling.

## 0.60.12 — 2026-08-15

### Fixed

- Concurrent content-v2 workers now partition and lock by logical tool execution
  identity instead of whole thread. Independent calls in very large legacy
  threads can repair in parallel while reused call identities remain ordered on
  one worker.

## 0.60.11 — 2026-08-15

### Fixed

- Content-v2 apply now builds migration-scoped partial indexes for execution,
  participant, and migrated-event identity lookups instead of repeatedly
  scanning JSON history for every repaired message.
- Prepared asset nodes and ownership edges are inserted in bounded sets,
  reducing the number of database round trips in the semantic repair path.
- Participants synthesized by content-v2 now use the canonical external-ID
  source identity.

## 0.60.10 — 2026-08-15

### Fixed

- Content-v2 apply now builds a temporary partial candidate index before
  semantic repair, eliminating a full candidate sort and PostgreSQL temporary
  spill for every repaired message.
- Concurrent semantic workers use stable thread-hash partitions, keeping every
  thread on one worker while avoiding idle workers contending for adjacent
  messages from the same thread.
- Successful semantic repair removes the temporary index; interrupted runs
  retain it so a resumable rerun can reuse the completed index build.

## 0.60.9 — 2026-08-15

### Changed

- Content-v2 apply can now run independent semantic repairs concurrently with
  bounded `semanticConcurrency`, using `FOR UPDATE SKIP LOCKED` claims and
  transaction-scoped per-thread advisory locks.
- Concurrent repair keeps strict preflight, per-message resumability, thread
  ordering, and bounded progress telemetry while eliminating the sequential N+1
  latency multiplier on remote PostgreSQL databases.

## 0.60.8 — 2026-08-15

### Fixed

- Content-v2 dry-run and ambiguity preflight now use keyset-paginated semantic
  planning, releasing legacy payloads between batches so memory use is bounded
  by `semanticBatchSize` instead of total tenant history.
- Large legacy payload sets no longer exhaust the JavaScript heap while
  retaining read-only planning, deterministic ordering, and strict ambiguity
  rejection.

## 0.60.7 — 2026-08-15

### Changed

- Content-v2 dry-run is now a read-only bulk planner with a bounded number of
  SQL round trips instead of applying every repair inside a rollback-only
  transaction.
- Apply preflights ambiguous history before writes, commits semantic repair in
  resumable bounded batches, and exposes semantic, asset, and byte progress.

### Fixed

- Large content-v2 dry-runs no longer generate production-sized writes, WAL,
  MVCC churn, or multi-hour open transactions merely to calculate a report.

## 0.60.5 — 2026-08-14

### Fixed

- Content-v2 now audits existing tool outputs in indexed batches, resolves
  provenance once per batch, uploads bodies with bounded concurrency, and
  commits each relocated batch in one database update instead of performing
  history-sized N+1 queries and per-asset transactions.

## 0.60.4 — 2026-08-14

### Fixed

- Content-v2 now uses explicit legacy execution IDs, projected-output and error
  digests, and original result creation times to disambiguate reused tool calls.

## 0.60.3 — 2026-08-14

### Fixed

- Existing delivery settlement-scope backfills now recurse only from delivery
  obligations that need migration, avoiding history-sized temporary results.

## 0.60.2 — 2026-08-14

### Added

- Delivery-level settlement scopes with declarative detached durable processors,
  automatic descendant propagation, scope-local cancellation, and Worker-output
  settlement.

### Changed

- Long-term memory consolidation now runs as durable background work without
  blocking or failing the user-facing run.

## 0.60.1 — 2026-08-14

### Fixed

- Content-v2 now disambiguates reused legacy tool-call IDs with canonical
  output/argument digests, participant/message evidence, and causal timestamps
  before refusing an uncertain match.

## 0.60.0 — 2026-08-14

This release separates graph asset metadata from pluggable body storage and
repairs legacy tool-result history.

### Added

- Declarative database, memory, filesystem-capability, S3-compatible, and
  injected asset body storage with immutable provenance paths and mixed-location
  reads.
- Generic nested data-URL extraction for tool results before live output,
  persistence, and model continuation.
- The isolated `migration/content-v2` dry-run/apply workflow for canonicalizing
  legacy tool messages and relocating database bodies to object storage.

### Changed

- Database storage remains the zero-configuration default and now accepts up to
  8 MiB per asset.
- The v1 upgrader classifies tool-authored messages as tool executions instead
  of public conversation and skips their duplicate legacy message events.
- HTTP asset metadata omits physical body locations.

## 0.59.26 — 2026-08-14

### Fixed

- The explicit memory-v4 migration now reads legacy memory records and
  checkpoints in bounded batches instead of retaining every embedding and ID in
  application memory.
- Legacy memory relations are rewritten with database-side endpoint detection,
  preserving relation typing when connected records cross migration batches.

## 0.59.25 — 2026-08-14

This release replaces the mixed memory model with a queryable semantic memory
ontology and keeps embedded applications available across recoverable database
connection failures.

### Added

- Memory records use explicit semantic forms, lifecycle states, temporal scope,
  provenance, epistemic metadata, and typed relations for agent and user query.
- Consolidation is an ordinary guarded tool flow, with plugin-provided context
  contributors and post-response similarity retrieval.
- An isolated, idempotent memory-v4 migration preserves legacy records,
  continuity, provenance, history, and relations.
- `createCopilotzPersistence()` lets co-located Gateway, Worker, and application
  services share one stable reconnectable database facade without exposing the
  private SQL session abstraction or transferring ownership to a role.

### Fixed

- Reconnectable persistence now classifies connection failures, serializes
  recovery, fences stale generations, bounds request admission, terminates
  indeterminate live work, and recovers durable deliveries after reconnection.
- Gateway persistence outages return retryable HTTP 503 responses with
  `Retry-After` instead of leaving requests hanging or requiring process
  replacement.

## 0.59.24 — 2026-08-13

This patch aligns the framework and frontend package releases after preserving
participant identity through parallel stream settlement.

### Fixed

- The coordinated frontend adapter retains each LLM attempt's agent identity
  when its terminal durable message arrives without repeating the agent payload,
  keeping parallel participant answers visually stable through settlement.

## 0.59.23 — 2026-08-13

This patch keeps durable workflow identities safe across deeply nested tool,
pipeline, ask, and realtime continuations.

### Fixed

- Synthesized workflow IDs preserve their readable form while short, then
  compact deterministically with SHA-256 before recursive ancestry can exceed
  downstream transport limits.
- LLM attempts, agent messages, tool executions, pipeline stages, public asks,
  and realtime tool calls now share the same runtime-neutral identity rule.

## 0.59.22 — 2026-08-13

This patch makes uploaded and tool-produced files addressable across the full
agent, tool, persistence, and client flow.

### Added

- LLM transcript attachments carry model-visible raw and tenant-qualified asset
  references while retaining provider-native multimodal parts.
- Workflow tools can return bounded output plus canonical attachments through
  `WorkflowToolResult`.
- OpenAPI resources can map tool response fields into canonical attachments
  through `API.responseAssets`.

### Fixed

- Asset-aware tools resolve raw IDs, canonical `asset://namespace/id` refs, and
  the legacy unqualified shorthand through one namespace-safe parser.
- Binary export bodies are removed from live/model output and persisted once as
  immutable content referenced by the public tool-result message.

## 0.59.21 — 2026-08-13

This patch lets downstream applications type their own processors against the
real delivery contract instead of duck-typing it.

### Added

- `@copilotz/copilotz/engine` exposes the processor-facing context types,
  including `CopilotzProcessorContext` and `CopilotzLiveProcessorContext`.
  Previously these were reachable only through the root barrel, which forces
  applications that ban barrel imports to redeclare the context structurally.
  Engine assembly itself stays internal to `@copilotz/copilotz/application`, so
  the new subpath is types only.

## 0.59.20 — 2026-08-13

This patch makes tenant schema lifecycle explicit and exposes renderable history
without flattening the event-native domain contract.

### Added

- `validateCopilotzSchema()` performs a read-only structural check of every
  runtime-required column in the four-table baseline.
- `provisionCopilotzSchema()` is the explicit schema create/upgrade lifecycle
  for migrations and tenant onboarding.
- Message history accepts `include=content,workflow` and returns canonical
  messages with related LLM attempts, tool executions, and immutable content in
  one compound document.

### Fixed

- Lazy tenant access no longer reruns schema DDL or waits on trigger/index locks
  during ordinary requests.
- Co-located Gateway/Worker topologies can let one role provision the default
  schema while the other validates it.
- Canonical history retains participant identity, reasoning, tool calls,
  execution state, projected output, errors, attachments, and pagination without
  introducing a flattened compatibility model.

## 0.59.19 — 2026-08-13

This patch makes tool execution lifecycle and progressive output first-class in
the event-native channel contract.

### Added

- Tools can emit ordered `tool_output.delta` events on named channels such as
  `stdout`, `stderr`, and `result` while they execute.
- OpenAPI tools can consume `application/x-ndjson` responses incrementally,
  preserving backpressure from an HTTP workload through the Copilotz event
  stream.
- Small ordinary tool return values are projected automatically onto the live
  `result` channel without duplicating explicit output.

### Fixed

- Tool lifecycle events now carry stable call, execution, tool, status, and
  bounded error fields with the tool's configured visibility policy.
- The canonical `/channels/*` routes retain native event names and payloads;
  uppercase compatibility projection remains isolated to legacy `/providers/*`
  routes.

## 0.59.18 — 2026-08-12

This patch restores legacy v1 thread-history queries over the event-native
conversation API.

### Fixed

- The v1 Fetch adapter treats the legacy `status=all` thread-list query as no
  status filter instead of looking for a literal `all` thread status.
- Explicit status filters such as `active`, `archived`, and custom statuses
  continue to pass through unchanged.

## 0.59.17 — 2026-08-12

This patch makes periodic event retention safe for large PostgreSQL schemas.

### Fixed

- Event and settled-delivery compaction runs in bounded batches instead of one
  unbounded delete transaction.
- Candidate selection uses existing position and namespace/causation indexes;
  causal trees are compacted safely from their leaves without rollout DDL.
- The existing maintenance `limit` now bounds recovery and each compaction
  phase, with a defensive maximum of 1,000 rows per phase.
- Ominipg `0.9.0-rc.10` and Oxian `0.21.0-rc.4` keep timed-out database sessions
  recoverable and expose bounded HTTP worker capacity downstream.

## 0.59.16 — 2026-08-12

This patch bounds one-way migration responses for legacy LLM attempts with very
large embedded transcripts.

### Fixed

- Legacy LLM attempts are migrated in single-row pages so multi-gigabyte
  histories cannot overflow Ominipg's session-frame encoding.
- Ordinary node types retain their larger migration batches.

## 0.59.15 — 2026-08-12

This patch makes the one-way v1 database upgrade preserve legacy text-labelled
assets whose bytes are not valid UTF-8.

### Fixed

- Invalidly labelled legacy `text/*` assets are stored losslessly as base64
  while retaining their media type; valid UTF-8 text and JSON remain unchanged.
- Runtime asset writes remain strict, so this compatibility behavior is limited
  to importing historical data.

## 0.59.14 — 2026-08-12

This patch adopts Oxian `0.21.0-rc.3` and Ominipg `0.9.0-rc.9` so embedded
Copilotz runtimes can keep durable in-process streams alive for the application
lifetime.

### Fixed

- In-process Gateway, Worker, database-session, and realtime streams no longer
  inherit WebSocket connection-age rotation or its bounded drain timeout.
- WebSocket Workers retain proactive connection rotation and the existing
  reconnect lifecycle.

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
