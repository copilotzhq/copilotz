---
title: Copilotz v3 Feature and Test Parity Ledger
description: The behavioral and downstream compatibility gate for the v3 refactor.
section: Internal Design
status: proposal
---

# Copilotz v3 Feature and Test Parity Ledger

## Purpose

This ledger prevents an architecture rewrite from becoming an accidental product
rewrite. It describes the observable contracts on current `main`, maps the
current tests to their v3 disposition, identifies missing characterization
coverage, and defines the downstream applications that must remain operable.

This is a behavior ledger, not a promise that every current type or method keeps
the same name. A breaking change is acceptable only when the behavior is either:

- preserved behind the new API;
- replaced by an explicitly approved behavior with migration coverage; or
- deliberately retired in a separately reviewed ledger change.

No row may disappear as an incidental consequence of deleting its old module.

## Baseline and Vocabulary

- Code baseline: `origin/main` at `64dddb8`, package version `0.56.1`.
- Spike reference: branch `v3`; useful for ideas, not suitable as the new base.
- Current first-party suite: 93 test files containing 624 declared tests or
  subtests.
- Downstream application suites inspected: 56 files containing 333 declared
  tests or subtests. The shared chat packages add 11 files/61 declarations, for
  a combined compatibility inventory of 67 files/394 declarations.

The counts are static declarations found in source. They are an inventory aid,
not a claim that every environment-dependent test executes in every CI job.

### Characterization implementation status

The first executable Gate 1 batch lives in `contracts/v3/` and is run by
`deno task test:v3-contracts` in publish CI. It currently covers:

- A01: factory shape plus an exact allowlist that prevents additional non-error
  classes;
- A02: root, server, and resources entrypoint exports used by downstream apps;
- A04: every bundled manifest resource and preset selector is loadable and has a
  stable identity;
- A05: sequential in-memory factory ownership, usable replacement instances, and
  idempotent runtime shutdown;
- A06/A08: a minimal durable text run, message persistence, public stream
  ordering, and causal completion;
- A14/A16: current observer ordering and `{ producedEvents: [] }` claim/swallow
  behavior.

A07 has an explicit temporary current-main contract: `cancel()` closes the
caller's observation stream while already accepted durable work continues to
settlement and `done` resolves. This differs from the proposed v3 cancellation
contract in the table below. Changing it therefore requires an intentional API
decision and a replacement assertion; it must not change incidentally.

Writing A04 exposed and fixed three catalog defects: `scheduled_job` was absent
from the collection barrel, `list_knowledge_spaces` had no convention path, and
two manifest-loaded processors lost their stable IDs/event types when their
default exports were unwrapped. A05 also exposed a lifecycle defect where a
closed in-memory database remained in the global connection cache; in-memory
databases are now instance-owned while persistent URLs retain caching.

This is the first batch, not completion of Gate 1. Unimplemented A-tests below
remain required according to their priority.

Disposition labels:

| Label            | Meaning                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| **Keep**         | The observable contract and test remain valid. Internal imports may move.                          |
| **Adapt**        | Preserve the behavior, but rewrite assertions around the new mechanism or representation.          |
| **Characterize** | Add a black-box test on current `main` before changing the subsystem.                              |
| **Decide**       | Product behavior is real but its v3 outcome has not been approved. It cannot be deleted meanwhile. |
| **New**          | Required by the accepted v3 direction and not covered by current behavior.                         |

Priorities:

- **P0** blocks deleting or replacing the current subsystem.
- **P1** blocks the v3 release.
- **P2** may follow the first v3 release if its public surface remains
  extensible.

## Parity Rules

1. Tests move by replacement, not by subtraction. A removed test file must name
   the new test that owns its contract in the same change.
2. Architecture-coupled assertions are rewritten only after a black-box
   characterization test captures their product effect.
3. The current API is not assumed sacred, but every breaking change must include
   a compile-time migration fixture, runtime migration test where applicable,
   and downstream update.
4. The public runtime remains factory-first. New stateful `*Manager`, `*Store`,
   `*Coordinator`, `*Registry`, `*Executor`, or `*Service` classes fail the
   architecture check unless they are error subclasses or explicitly approved.
5. `nodes`, `edges`, immutable semantic events, and durable deliveries are
   implementation targets. They do not justify dropping collections, goals,
   scheduled jobs, channels, admin views, memory, skills, or tools.
6. Uppercase live events and legacy processor controls are migration contracts,
   not permanent v3 concepts. Their adapters remain until the direct consumers
   listed below have moved.
7. Cleanup happens vertically. The old implementation for one green capability
   may be removed; unrelated working capabilities and tests remain.

## Capability Ledger

### F01 — Factory-first public runtime

**Current contract:** `createCopilotz(config)` returns a plain object exposing
configuration, database/operations, collections, schema helpers, `run`, `goal`,
`recover`, `start`, `shutdown`, assets, and embeddings. Current asset storage is
already factory-first.

**Disposition:** Keep, P0. The new engine may be split into cohesive modules,
but its public and internal stateful components are created by functions and
represented by closures/plain records. Error subclasses are allowed.

Current `main` still has non-error class implementations in the CLI, async
queues, schema conversion, MCP client, finance provider, and tool-call draft
tracker. A temporary explicit allowlist records that migration debt and prevents
new classes; the v3 cleanup gate removes or separately approves each entry. The
class-heavy v3 spike does not extend the allowlist.

**Coverage:** `runtime/create-copilotz-resources.test.ts`,
`runtime/storage/assets.ts` through its consumer tests, and new test A01 below.

### F02 — Public exports and configuration

**Current contract:** root exports include runtime/database factories, types,
collection builders, resource loading, graph/schema helpers, asset-ref helpers,
goals, and channel types. Additional entrypoints are `./resources`, `./tokens`,
`./server`, and `./create`. `CopilotzConfig` supports explicit resources,
filesystem/remote resource loading, base-agent inheritance, history transforms,
usage, RAG, security, tenancy, assets, recovery, and multi-agent options.

**Disposition:** Adapt, P0. Plugin terminology can replace package-loading
`resources`, but explicit resource arrays and practical configuration features
must have a defined destination. No export disappears solely because the v3
spike did not use it.

**Coverage:** `index.ts` type fixtures,
`runtime/create-copilotz-resources.test.ts`, `utils/merge-resources.test.ts`,
and new tests A02–A03.

### F03 — Resource composition and plugin packaging

**Current contract:** bundled core resources, named presets, dot-path imports,
local directories, remote packages with manifests, filters, channel overrides,
resolver callbacks, and explicit arrays merge with stable-ID precedence.

**Disposition:** Adapt, P0. `plugins` becomes the package-loading vocabulary;
agents, tools, processors, collections, providers, channels, features, memory,
skills, APIs, and MCP servers remain resource kinds inside plugins. Define a
deterministic conversion for existing resource directories and manifests.

**Coverage:** `runtime/loaders/resources.test.ts`,
`runtime/loaders/agents-file.test.ts`,
`runtime/create-copilotz-resources.test.ts`, `utils/merge-resources.test.ts`,
`resources/core.test.ts`, and `resources/skills/index.test.ts`.

### F04 — Built-in resource catalog

**Current contract:** the manifest provides five bundled agents; 34 built-in
tools; 11 processors; participant/history/retrieval/long-term memory; seven LLM
providers; OpenAI embeddings; filesystem/S3 storage; 15 collections; five
channels; admin features; 24 skills; and `core`, `rag`, `admin`, `finance`,
`code`, and `skunk-works` presets.

**Disposition:** Keep, P0. Renaming or repackaging is allowed, but every current
manifest entry requires a parity row or an approved retirement. The v3 spike’s
deletion of most of this catalog is explicitly rejected.

**Coverage:** `resources/core.test.ts`, `resources/skills/index.test.ts`, tool,
provider, channel, memory, and processor tests listed in the appendix. Add A04,
which compares the declared manifest with loadable resources.

### F05 — Runtime lifecycle and embedding

**Current contract:** apps can create one long-lived engine, run multiple
messages, use the interactive `start()` controller, recover work, and shut down
owned database resources. Injected resources are not implicitly owned.

**Disposition:** Adapt, P0. Add app-owned Oxian dispatcher/target injection and
private in-process hosting while preserving ownership boundaries. Keep `start()`
unless separately retired with CLI replacement.

**Coverage:** `runtime/run-thread.test.ts`, `runtime/recovery.test.ts`,
`server/app.test.ts`, examples, and A05/A24.

### F06 — Text `run()` contract

**Current contract:** `run(message, options)` returns a handle with thread/work
identity, an async event stream, completion, and cancellation semantics. The
stream exposes messages, tokens/reasoning, tool lifecycle, LLM lifecycle,
assets, errors, and custom events. `run()` settles after causally produced work.

**Disposition:** Adapt, P0. Keep `run()` as the simple text API and implement it
over a temporary attachment/correlation scope. Queue vocabulary may disappear,
but cancellation, causal completion, error propagation, and event ordering must
remain characterized.

**Coverage:** `runtime/event-engine.test.ts`, `runtime/run-thread.test.ts`,
`runtime/run-generation.test.ts`, `runtime/stream-redaction.test.ts`, and
A06–A08.

### F07 — Threads, messages, participants, and history

**Current contract:** create/find/update threads, stable external identity,
participants, sender identity, target/target queue, ordered and paginated
history, thread tags/metadata, edit/delete routes, and participant lifecycle
updates. Messages preserve reasoning, tool calls, attachments, visibility, and
sender roles.

**Disposition:** Keep behavior and adapt persistence, P0. Threads may become
graph-native without a physical `threads` table. The HTTP representation must
remain usable while clients migrate to canonical content references.

**Coverage:** `database/operations/message-history-pagination.test.ts`,
`database/migrations/migration_0017_participant_identity.test.ts`,
`runtime/thread-metadata.test.ts`, `runtime/routing/index.test.ts`,
`resources/processors/participant_lifecycle/message.created.test.ts`,
`resources/processors/message_router/*.test.ts`, and server app tests.

### F08 — Multi-agent routing and public agent-to-agent conversation

**Current contract:** participant lists, explicit targets, participant target
state, turn limits, fallback routing, tool-result return to the producing agent,
and `delegate_task`/`create_thread` flows. Some delegation is currently private.

**Disposition:** Adapt and Decide, P0. The accepted direction is a public `ask`
conversation: both question and answer are ordinary participant messages, with
causation resuming the asker. Before replacing delegation, characterize current
routing, nested tool loops, and failure/limit behavior. Background
`create_thread` remains a distinct capability. Whether `delegate_task` remains
as a compatibility alias is a release decision, not cleanup.

**Coverage:** `runtime/routing/index.test.ts`,
`resources/processors/message_router/routing.test.ts`,
`message_router/metadata.test.ts`, `message_router/coalescing.test.ts`,
`runtime/run-thread.test.ts`, examples, and A09–A12.

### F09 — LLM provider and streaming behavior

**Current contract:** OpenAI, Anthropic, Gemini, Groq, DeepSeek, Ollama, and
MiniMax resources; reasoning-aware transcripts; fallback chains; deadline and
recovery policy; usage; model catalog/pricing; prompt-cache identity; tolerant
tool-call streaming; and provider wire-role normalization.

**Disposition:** Keep, P0. Provider adapters remain functions. Text deltas
become the ephemeral event vocabulary internally, with a compatibility
projection for current uppercase SSE consumers until migrated.

**Coverage:** all `resources/llm/*/adapter.test.ts` files and all
`runtime/llm/*.test.ts` files. These tests are not replaced by generic Oxian
transport tests.

### F10 — Prompt construction, context, and history policies

**Current contract:** participant and agent context, instructions including the
per-input resolver, asset materialization, bounded history, reasoning
visibility, tool-result truncation/readback, cache-safe append-only history, and
custom `historyTransform`.

**Disposition:** Keep with content-representation adaptations, P0.

**Coverage:** all `runtime/agent-llm-input/*.test.ts`,
`runtime/llm/agent-request.test.ts`,
`runtime/llm/asset-materialization.test.ts`,
`resources/processors/tool_call/history-policy.test.ts`, and
`runtime/tools/format-tools-for-prompt.test.ts`.

### F11 — Tool definitions and execution lifecycle

**Current contract:** custom tools, built-in tools, JSON-schema formatting,
OpenAPI-generated tools, MCP-generated tools, pipelines/jq, per-tool timeouts,
context injection (`db`, collections, thread, agent, assets, resolver),
incremental tool-call JSON, durable execution records, projected/history-safe
output, assets, idempotent result handling, and errors returned to the agent.

**Disposition:** Keep, P0. Large args/results may be content assets; tool name,
call ID, status, visibility, attempts, timing, causation, and idempotency remain
inline. External calls receive an idempotency key.

**Coverage:** all `runtime/tools/*.test.ts`,
`resources/processors/tool_call/*.test.ts`,
`resources/processors/tool_result/*.test.ts`, and built-in tool tests. Add A13
for a complete user → agent → tool → same agent → public answer loop.

### F12 — Custom processor behavior

**Current contract:** processors can match uppercase or durable event types,
filter with `shouldProcess`, run in priority order, mutate through rich
`ProcessorDeps`, return replacement events, claim/swallow downstream work with
`producedEvents`, and emit channel actions. Current downstream applications use
all of these mechanisms.

**Disposition:** Characterize, Adapt, and Decide, P0. The target subscription
model removes global chains, priority claiming, and `producedEvents`, but their
product uses require explicit replacements:

- observation/side effects become independent subscriptions;
- event mutation becomes a typed pre-domain command hook or a new mutation;
- suppression/claiming becomes an explicit routing or policy decision;
- channel actions become ordinary typed outputs;
- stale thread reads use collection access in handler context;
- deterministic ordering dependencies become one named composite processor or
  domain operation, not implicit global priority.

No legacy processor adapter is removed until Compass and Mobizap are migrated
and A14–A17 pass.

**Coverage:** `runtime/event-priority.test.ts`,
`runtime/processors/coerce.test.ts`, `resources/processors/convention.test.ts`,
all built-in processor tests, and the Mobizap processor suites.

### F13 — Collections and graph application data

**Current contract:** `defineCollection`, typed inference, keys, indexes,
relations, validation, before/after hooks, CRUD, namespace scoping,
`withNamespace`, graph search, native collections, and direct use from app code,
features, tools, and processors.

**Disposition:** Keep and Adapt, P0. Keep `before*` validation/transformation.
Replace `after*` effects with subscriptions only after equivalent transaction
and error behavior is characterized. Remove public raw graph writes, but retain
typed query/read needs and a supported escape hatch for application reporting.

**Coverage:** `database/collections/collections.test.ts`,
`database/collections/type-inference.test.ts`,
`database/operations/graph-search.test.ts`,
`runtime/collections/native.test.ts`, and downstream custom collection suites.
Add A18 for hook migration and A19 for typed aggregate mutations.

### F14 — Atomic mutation, immutable events, and deliveries

**Current contract:** domain mutation and outbox insertion are atomic; event
claims use leases; trace state supports completion; recovery handles crashes;
JSON values remain safe in Postgres; duplicate work is constrained.

**Disposition:** Adapt, P0. Replace queue rows with immutable semantic events
and sparse `event_deliveries`. Preserve atomicity, at-least-once delivery,
idempotency, cancellation, retry limits, leases/heartbeats, dead letters, crash
recovery, and causal settlement. Queue-specific supersession and coalescing are
Decide items until their user-visible purpose is documented.

**Coverage:** `database/operations/mutation-outbox.test.ts`,
`worker-lease.test.ts`, `trace-state.test.ts`, `event-supersession.test.ts`,
`runtime/event-engine.test.ts`, `runtime/recovery.test.ts`,
`runtime/run-generation.test.ts`, and A20–A23.

### F15 — Database portability, schemas, and tenancy

**Current contract:** PGlite and PostgreSQL, tenant schemas, namespace scoping,
schema provisioning/migration/cache, safe JSON, snapshots/restore, and helpers
such as `withSchema`, `listTenantSchemas`, and `createDatabase`. Apps mix
high-level collections with sanctioned lower-level reads.

**Disposition:** Keep, P0. Use Ominipg’s Oxian-native session model and one
session per engine/worker. Core code must not unconditionally import Deno or
Node APIs. Fresh v3 databases use a clean baseline; v1 upgrade code is isolated.

**Coverage:** all `database/*.test.ts`, schema/migration tests, server migration
tests, and A24–A27 across PGlite and PostgreSQL.

### F16 — Migration of existing databases

**Current contract:** current tenants contain graph nodes/edges, a physical
thread projection, event/outbox state, usage, memories, assets, and custom
collections. Some applications provision many tenant schemas.

**Disposition:** New, P0. Upgrade must refuse unsafe active work, preserve graph
and domain IDs, merge thread state, migrate settled durable facts, preserve
custom collection data and indexes, and verify every tenant before dropping old
columns/tables. Queue-only transient state can be discarded only under the
approved preconditions.

**Coverage:** existing migration/schema tests plus A28 using anonymized v1
snapshots with custom collections, assets, memory, tools, usage, and multiple
tenants.

### F17 — Memory and participant identity

**Current contract:** participant memory, history, retrieval, long-term memory
spaces, ownership/access, memory reservation/checkpoints, consolidation,
explicit memory tools, and participant identity migration.

**Disposition:** Keep, P0. Execution may move to Oxian workloads; the memory
model, boundaries, retry safety, and agent-scoped visibility remain.

**Coverage:** `runtime/memory/long-term.test.ts`, memory processor tests,
`resources/tools/update_user_memory/index.test.ts`, participant lifecycle tests,
and migration tests.

### F18 — RAG, documents, chunks, and graph memory

**Current contract:** document parsing/chunking, embedding providers, retrieval,
knowledge spaces, ingestion/deletion/search tools, entity extraction, graph
search, and admin brain inspection.

**Disposition:** Keep, P1. Document bodies naturally use the content/asset
model; searchable extracted text and embeddings remain queryable projections.

**Coverage:** document parser, graph search, memory tests, API/tool generator
tests, admin brain tests, and add A29 for asset-backed document ingestion.

### F19 — Assets, attachments, and media

**Current contract:** `asset://` references; memory, passthrough, filesystem,
and S3 backends; namespace validation; extraction from message/tool payloads;
provider materialization; public asset events; REST retrieval; and UI attachment
hydration. Existing input accepts text/image/audio/file/JSON parts and data
URLs.

**Disposition:** Adapt, P0. Adopt the content/asset model in the companion spec.
Keep compatibility parsers and client projections while moving canonical durable
bodies to references. Raw stream frames never become event rows.

**Coverage:** asset generator/materialization tests, inbound-message and
document-parser tests, channel media tests, chat-adapter message/asset tests,
and A30–A35.

### F20 — Persistent realtime attachments

**Current contract:** recorded/file audio can be submitted as an attachment;
there is no foundational bidirectional realtime runtime.

**Disposition:** New, P1. `connect()` creates a persistent thread attachment;
`attachment.send()` is the sole ingress for discrete and stream inputs;
participant-labelled output streams can be concurrent; semantic boundaries and
final results are durable; frames are ephemeral and backpressured.

**Coverage:** A36–A42 against private in-process and injected Oxian dispatchers.
Provider-specific codecs, VAD, and production audio providers are P2.

### F21 — Goals and simulation

**Current contract:** `goal()` drives bounded multi-turn journeys with a lead
agent, streams progress/results, supports stopping, and is used for application
QA. The lead thread is currently private.

**Disposition:** Decide, P0. Realtime/public `ask` does not automatically
replace the separate goal/testing primitive. Preserve `goal()` until its
simulation, judge, stopping, and reporting responsibilities have a reviewed
destination.

**Coverage:** `runtime/goal.test.ts`, goal documentation/examples, and Mobizap’s
goal QA scripts/features.

### F22 — Scheduled and background work

**Current contract:** scheduled-job collection/tool, scheduler tick API,
background thread creation, recovery, and process-independent durable work.

**Disposition:** Keep and Adapt, P1. Model schedules as domain records whose due
events create deliveries; Oxian places execution. Do not confuse a background
task with a private agent consultation.

**Coverage:** manifest/resource checks and new A43–A44. Current coverage is
insufficient, so deletion is blocked until characterization exists.

### F23 — Usage, cost, observability, and admin

**Current contract:** LLM/tool/asset/RAG usage attribution, pricing overrides,
usage ledger, admin overview/activity/events/threads/participants/agents/brain,
thread activity/failure summaries, and event inspection.

**Disposition:** Keep and Adapt, P0 for data correctness and P1 for UI. Admin
queries move to semantic events/deliveries without presenting obsolete queue
states as canonical. A compatibility response may translate delivery activity
during client migration.

**Coverage:** runtime usage/token/pricing tests, all admin feature tests,
chat-admin client contract, and A45–A47.

### F24 — Channels and server facade

**Current contract:** framework-independent handler factories, `withApp`, web,
WhatsApp, Zendesk, Discord, and Telegram ingress/egress, feature routes,
collections/graph/assets/messages/threads/participants/events endpoints,
authentication context, SSE, channel overrides, and generated-event logging.

**Disposition:** Keep, P0. Server/CLI/filesystem concerns move to adapters, but
these adapters remain first-party. Current HTTP/SSE shapes require a versioned
compatibility layer while chat packages migrate.

**Coverage:** all server and channel tests, `server/app.test.ts` subtests,
Compass/Mobizap channel tests, chat adapter tests, and A48–A51.

### F25 — APIs, MCP, features, and custom tools

**Current contract:** OpenAPI resources generate safe tools; MCP servers add
tools; features expose app-owned HTTP behavior; tools receive runtime context;
errors are bounded and safe for the agent.

**Disposition:** Keep, P0. These remain plugin resource types and execute
through logical Oxian resource IDs rather than serialized closures.

**Coverage:** API generator, safe API error, MCP/tool formatting, server
feature, and downstream sandbox/feature tests.

### F26 — Skills and built-in operational tools

**Current contract:** bundled skills and on-demand skill loading, skill resource
reading, filesystem/code/terminal/web/finance/wait/memory/asset tools, and
prompt formatting.

**Disposition:** Keep, P1. Runtime-specific implementations live behind
capability adapters; unsupported runtimes fail at resource resolution rather
than making the core runtime non-portable.

**Coverage:** skill, filesystem, fetch, terminal, web-search, jq, pipeline, and
tool-formatting tests plus manifest completeness.

### F27 — Runtime portability and Oxian placement

**Current contract:** Copilotz is primarily exercised on Deno, while Ominipg and
Oxian now support Deno, Node, Bun, browser, and Cloudflare-compatible execution
with injected capabilities.

**Disposition:** New/Adapt, P0. The core has no unconditional Deno/Node imports.
Default execution uses a private in-process host; an injected dispatcher/target
supports shared hosts and hypervisors. Copilotz shuts down only infrastructure
it owns. Worker payloads contain resource/delivery IDs, never closures.

**Coverage:** A24–A27 and A52–A55. Browser/Cloudflare smoke tests use supported
injected providers and storage; they need not promise local filesystem or CLI
capabilities.

## P0 Characterization Tests to Add Before Refactoring

These tests run against current `main`. They establish the contract before the
first subsystem replacement.

| ID  | Test                                | Required assertion                                                                                                                                                      |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Factory architecture guard          | Runtime construction exposes plain objects/functions; a temporary current-main class allowlist prevents growth, and the v3 gate removes non-error stateful entries.     |
| A02 | Public export compile fixture       | Every currently consumed root/server/resources export compiles from package entrypoints.                                                                                |
| A03 | Configuration fixture matrix        | Explicit arrays, resource callbacks, local resources, remote manifest shape, filters, overrides, agents file, assets, tenancy, RAG, recovery, and usage all type-check. |
| A04 | Manifest loadability                | Every declared built-in resource and preset resolves exactly once with stable-ID precedence.                                                                            |
| A05 | Ownership lifecycle                 | Owned database/worker infrastructure closes once; injected infrastructure is never closed.                                                                              |
| A06 | Minimal text run                    | User input persists, agent output streams and persists, and `done` settles after the public answer.                                                                     |
| A07 | Cancellation/error run              | Cancel interrupts causal work and rejects completion without corrupting the thread.                                                                                     |
| A08 | Stream ordering                     | Attempt, reasoning/text deltas, tools, messages, errors, and custom events have a documented observable order.                                                          |
| A09 | Multi-agent target                  | Explicit target and participant target state route to the intended agent.                                                                                               |
| A10 | Tool return ownership               | A tool result resumes the agent that produced the call, including concurrent agents.                                                                                    |
| A11 | Nested/parallel multi-agent loop    | Turn limits, correlation, and public ordering remain bounded under nested and parallel work.                                                                            |
| A12 | Current delegation characterization | Capture current private/public behavior and failure semantics before introducing `ask`.                                                                                 |
| A13 | End-to-end tool turn                | User → agent tool call → execution → same agent → public final message, including retry-safe persistence.                                                               |
| A14 | Processor observation               | Independent side-effect processors see the intended event once logically under retries.                                                                                 |
| A15 | Processor priority dependency       | Capture current ordering, replacement, and stale-deps behavior used by Mobizap.                                                                                         |
| A16 | Processor claim/swallow             | Capture `{ producedEvents }`, event replacement, live-stream timing, and built-in suppression.                                                                          |
| A17 | Processor channel action            | A custom processor can produce a channel-neutral action that reaches egress once.                                                                                       |
| A18 | Collection hook contract            | `before*` and `after*` ordering, rollback, validation, transformation, and error behavior are explicit.                                                                 |
| A19 | Collection aggregate mutation       | Custom and native writes preserve keys, indexes, relations, namespace, and one intended semantic event.                                                                 |
| A20 | Atomic commit                       | Graph/domain write, immutable event, and required delivery obligations are all-or-nothing.                                                                              |
| A21 | Crash matrix                        | Recover after commit/before dispatch, during execution, and after idempotent output/before settlement.                                                                  |
| A22 | Delivery lifecycle                  | Ordering, leases, heartbeat, retries/backoff, cancellation, dead letter, manual retry/discard, and dedupe.                                                              |
| A23 | Causal settlement                   | `done` waits for required descendants only and reports dead-letter/cancellation correctly.                                                                              |
| A24 | Deno embedded smoke                 | Text run with private in-process Oxian and PGlite/Ominipg.                                                                                                              |
| A25 | Node embedded smoke                 | Same core scenario with injected runtime capabilities.                                                                                                                  |
| A26 | Bun embedded smoke                  | Same core scenario with injected runtime capabilities.                                                                                                                  |
| A27 | Browser/Cloudflare smoke            | Core import, in-process event transport, Web Streams, and supported injected persistence/provider.                                                                      |
| A28 | V1 database upgrade                 | Multi-tenant snapshot with custom collections, messages, tools, assets, memory, usage, and safely settled legacy work upgrades without loss.                            |
| A29 | Asset-backed RAG                    | Asset document ingestion, extraction, embedding, retrieval, and deletion preserve search behavior.                                                                      |
| A30 | Canonical content round trip        | Text, JSON, image, audio, file, and mixed ordered parts persist and resolve without representation loss.                                                                |
| A31 | Tool content round trip             | Large args/result, projected output, error, assets, and history visibility resolve for tools, agents, APIs, and UI.                                                     |
| A32 | Storage policy                      | Small DB-backed and large object-backed bodies share one reference contract; orphan cleanup is safe.                                                                    |
| A33 | Namespace/security                  | Cross-tenant asset access and accidental cross-tenant dedupe are rejected.                                                                                              |
| A34 | UI compatibility                    | Existing REST message/asset responses and adapter hydration render text, tools, reasoning policy, and attachments.                                                      |
| A35 | Provider projection                 | Content is batched, budgeted, and projected correctly for each LLM provider.                                                                                            |
| A45 | Usage idempotency                   | Retries do not duplicate usage/cost rows.                                                                                                                               |
| A46 | Admin compatibility                 | Overview/activity/events/brain/thread detail remain correct on new storage.                                                                                             |
| A47 | Growth invariant                    | Passive participants, observers, and frame/token volume do not create durable deliveries or body duplication.                                                           |
| A48 | `withApp` route contract            | Existing thread/message/participant/asset/collection/graph/feature/admin routes retain versioned behavior.                                                              |
| A49 | Web SSE compatibility               | Current adapter event names and payloads remain available until the adapter migrates.                                                                                   |
| A50 | Channel round trip                  | Web, WhatsApp, and Zendesk ingress → run → egress, including media/actions, remains correct.                                                                            |
| A51 | Channel override contract           | Ingress/egress decorators receive stable inputs and can replace output.                                                                                                 |
| A52 | Shared-host dispatch                | Injected Oxian host executes logical resources without owning app infrastructure.                                                                                       |
| A53 | Remote dispatch contract            | Payloads contain serializable IDs/data only and resolve resources on the worker.                                                                                        |
| A54 | Stream backpressure transport       | Web Streams preserve pressure/cancellation in process and across the supported remote transport.                                                                        |
| A55 | Core import portability             | Importing core does not access filesystem, environment, network, CLI, or server APIs.                                                                                   |

P1 realtime and background tests A36–A44 are specified in the content model and
the capability rows; they may be added when those new APIs are introduced, but
before the v3 release.

## Current First-Party Test Disposition

Every current test file is accounted for below. “Adapt” never means delete the
behavior; it means the test must stop asserting an obsolete physical mechanism.

### Database — 12 files

| Test file                                                         | Disposition                       | V3 owner                                      |
| ----------------------------------------------------------------- | --------------------------------- | --------------------------------------------- |
| `database/collections/collections.test.ts`                        | Keep/Adapt                        | Collection contract and hooks (F13, A18–A19)  |
| `database/collections/type-inference.test.ts`                     | Keep                              | Public collection type contract (F13)         |
| `database/migrations/migration_0017_participant_identity.test.ts` | Keep in isolated v1 upgrade suite | F07/F16/F17, A28                              |
| `database/operations/event-supersession.test.ts`                  | Decide after characterization     | F14, A21–A23                                  |
| `database/operations/graph-search.test.ts`                        | Keep                              | F13/F18                                       |
| `database/operations/message-history-pagination.test.ts`          | Keep/Adapt                        | F07                                           |
| `database/operations/mutation-outbox.test.ts`                     | Adapt                             | Atomic event/delivery commit (F14, A20)       |
| `database/operations/trace-state.test.ts`                         | Adapt                             | Correlation settlement (F06/F14, A23)         |
| `database/operations/worker-lease.test.ts`                        | Adapt                             | Durable delivery lifecycle (F14, A21–A22)     |
| `database/packed-types.test.ts`                                   | Keep/Adapt                        | Portable persistence serialization (F15)      |
| `database/postgres-json-safety.test.ts`                           | Keep                              | F14/F15                                       |
| `database/schema-provisioning.test.ts`                            | Keep/Adapt                        | Tenant provisioning and v3 baseline (F15/F16) |

### Runtime composition, execution, and routing — 22 files

| Test family                                                                  | Disposition                                  | V3 owner                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| `runtime/create-copilotz-resources.test.ts`                                  | Keep/Adapt                                   | F01–F04                                     |
| `runtime/loaders/resources.test.ts`, `runtime/loaders/agents-file.test.ts`   | Adapt                                        | Plugin adapter and agent instructions (F03) |
| `utils/merge-resources.test.ts`                                              | Keep/Adapt                                   | Stable-ID composition (F03)                 |
| `runtime/event-engine.test.ts`, `runtime/event-priority.test.ts`             | Characterize/Adapt                           | F06/F12/F14                                 |
| `runtime/processors/coerce.test.ts`                                          | Adapt, then remove with downstream migration | F12                                         |
| `runtime/recovery.test.ts`, `runtime/run-generation.test.ts`                 | Adapt                                        | F14                                         |
| `runtime/run-thread.test.ts`                                                 | Keep/Adapt                                   | F05–F08                                     |
| `runtime/routing/index.test.ts`                                              | Keep/Adapt                                   | F07/F08                                     |
| `runtime/goal.test.ts`                                                       | Keep pending product decision                | F21                                         |
| `runtime/stream-redaction.test.ts`                                           | Keep                                         | F06/F09/F23                                 |
| `runtime/thread-metadata.test.ts`                                            | Keep                                         | F07                                         |
| `runtime/collections/native.test.ts`                                         | Keep/Adapt                                   | F13/F16                                     |
| `runtime/memory/long-term.test.ts`                                           | Keep                                         | F17/F18                                     |
| `runtime/usage/attribution.test.ts`                                          | Keep/Adapt                                   | F23                                         |
| `server/app.test.ts`, `server/channels.test.ts`, `server/migrations.test.ts` | Keep/Adapt                                   | F15/F16/F24                                 |
| `utils/inbound-message.test.ts`                                              | Keep/Adapt                                   | F07/F19                                     |
| `utils/document-parser.test.ts`                                              | Keep                                         | F18/F19                                     |

### LLM and prompt construction — 24 files

Keep all provider semantics. Adapt only canonical content inputs and internal
event names:

- `resources/llm/anthropic/adapter.test.ts`
- `resources/llm/gemini/adapter.test.ts`
- `resources/llm/minimax/adapter.test.ts`
- `resources/llm/openai/adapter.test.ts`
- `runtime/agent-llm-input/asset-generator.test.ts`
- `runtime/agent-llm-input/context-generator.test.ts`
- `runtime/agent-llm-input/history-generator.test.ts`
- `runtime/agent-llm-input/index.test.ts`
- `runtime/agent-llm-input/instructions-resolver.test.ts`
- `runtime/llm/agent-request.test.ts`
- `runtime/llm/asset-materialization.test.ts`
- `runtime/llm/config.test.ts`
- `runtime/llm/deadline.test.ts`
- `runtime/llm/fallback.test.ts`
- `runtime/llm/internal-cache-key.test.ts`
- `runtime/llm/model-catalog.test.ts`
- `runtime/llm/pricing.test.ts`
- `runtime/llm/recovery-policy.test.ts`
- `runtime/llm/response-interpreter.test.ts`
- `runtime/llm/usage.test.ts`
- `runtime/llm/utils.test.ts`
- `runtime/llm/wire-roles.test.ts`
- `runtime/tokens/calibration.test.ts`
- `runtime/tokens/estimate.test.ts`

### Built-in processors and memory — 16 files

| Test family                                                                                                                                                                   | Disposition         | V3 owner                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------ |
| `resources/processors/convention.test.ts`                                                                                                                                     | Adapt               | Named subscription/plugin convention (F12) |
| `resources/processors/participant_lifecycle/message.created.test.ts`                                                                                                          | Keep/Adapt          | F07/F17                                    |
| `resources/processors/memory_reservation/message.created.test.ts`                                                                                                             | Keep/Adapt          | F17                                        |
| `resources/processors/memory_consolidation/long_term_memory.created.test.ts`                                                                                                  | Keep/Adapt          | F17/F18                                    |
| `resources/processors/message_router/routing.test.ts`, `resources/processors/message_router/metadata.test.ts`, `resources/processors/message_router/long_term_memory.test.ts` | Keep/Adapt          | F07/F08/F17                                |
| `resources/processors/message_router/coalescing.test.ts`, `resources/processors/message_router/recovery.test.ts`                                                              | Characterize/Decide | F08/F14                                    |
| `resources/processors/llm_call/llm_attempt.created.failure.test.ts`, `resources/processors/llm_call/llm_attempt.created.routing.test.ts`                                      | Keep/Adapt          | F08/F09/F14                                |
| `resources/processors/llm_result/llm_attempt.completed.test.ts`                                                                                                               | Keep/Adapt          | F09/F14/F23                                |
| `resources/processors/tool_call/tool_execution.context.test.ts`, `resources/processors/tool_call/history-policy.test.ts`                                                      | Keep/Adapt          | F10/F11                                    |
| `resources/processors/tool_call/generators/api-generator.test.ts`                                                                                                             | Keep                | F25                                        |
| `resources/processors/tool_result/tool_execution.completed.test.ts`                                                                                                           | Keep/Adapt          | F11/F14/F19                                |

### Channels, admin, skills, and tools — 21 files

Keep behavior; adapt event/content representations and persistence queries:

- `resources/channels/web/egress.test.ts`
- `resources/channels/whatsapp/egress.test.ts`
- `resources/channels/whatsapp/ingress.test.ts`
- `resources/channels/whatsapp/shared.test.ts`
- `resources/channels/zendesk/shared.test.ts`
- `resources/core.test.ts`
- `resources/features/admin/_helpers.test.ts`
- `resources/features/admin/brain.test.ts`
- `resources/features/admin/events.test.ts`
- `resources/features/admin/usage.test.ts`
- `resources/skills/index.test.ts`
- `resources/tools/_shared/fs-utils.test.ts`
- `resources/tools/fetch_text/index.test.ts`
- `resources/tools/persistent_terminal/index.test.ts`
- `resources/tools/update_user_memory/index.test.ts`
- `resources/tools/web_search/index.test.ts`
- `runtime/tools/format-tools-for-prompt.test.ts`
- `runtime/tools/jq.test.ts`
- `runtime/tools/pipeline.test.ts`
- `runtime/usage/attribution.test.ts` (also listed with runtime ownership)
- `utils/document-parser.test.ts` (also listed with content ownership)

The two cross-owned files are intentionally listed in both owning sections; the
unique first-party inventory remains 93 files.

## Downstream Compatibility Gate

### Shared chat packages

`@copilotz/chat-adapter` has 9 test files/48 declared tests and
`@copilotz/chat-ui` has 2 files/13 tests. The adapter currently depends on:

- `POST /v1/providers/web` as an SSE stream;
- uppercase `LLM_CALL`, `TOKEN`, `NEW_MESSAGE`, `TOOL_CALL`, `TOOL_CALL_DELTA`,
  `TOOL_RESULT`, `LLM_RESULT`, `ASSET_CREATED`, and `ERROR`;
- reasoning/answer attempt and phase identity;
- REST threads, thread activity, agents, paginated messages, message edit, and
  thread delete/update routes;
- string message content, tool calls, sender fields, metadata visibility, and
  attachments hydrated from `metadata.attachments`;
- `GET /v1/assets/:id?format=dataUrl` and `asset://` parsing.

Before removing compatibility projections, migrate the adapter to the new
semantic/stream contract and run its complete suite. `@copilotz/admin` also
depends on `/v1/admin/*`, `/v1/collections`, `/v1/threads`, and event/activity
representations; it currently lacks its own tests, so A46/A48 must supply them.

### Compass — 31 test files/131 declarations

Compatibility surface includes `createCopilotz`, `Copilotz`, `CopilotzDb`,
`Event`, `NewEvent`, `ProcessorDeps`, `LLMRuntimeConfig`, `IngressResult`,
`createDatabase`, `defineCollection`, `index`, `withSchema`,
`listTenantSchemas`, `parseAssetRef`, `loadResources`, `bundledResourcesUrl`,
`withApp`, direct `collections`, direct/sanctioned database reads, schema
management, recovery, assets, custom resource paths/overrides, four-agent
routing, tools/features, WhatsApp, and chat/admin packages.

Gate: type-check Compass against the workspace build and run its suite,
especially tenant isolation, connected accounts, sandbox asset import/export,
attached-computer state, custom collections/tools, server middleware, and
WhatsApp processor behavior.

### Copilotz Starter — no current tests

Compatibility surface is intentionally small: local resource loading and
imports, base agent options, filesystem assets, multi-agent settings,
`createCopilotz`, `withApp`, and the standard chat/admin HTTP surface.

Gate: add a compile and smoke fixture before v3. A reference starter without a
test cannot be treated as evidence of compatibility.

### Gilpinna — 1 integration file/22 declarations

Compatibility surface includes `createCopilotz`, `withApp`, `start().closed`,
shutdown, S3 assets, custom collections with `withNamespace`, features,
`ToolExecutionContext.resolveAsset`/`assetStore`, provider streaming, and the
chat packages.

Gate: run its integration suite and add a focused asset-backed image/tool
fixture so canonical content changes cannot silently break references.

### Mobizap — 24 test files/180 declarations

Mobizap is the strongest processor compatibility gate. It uses uppercase and
durable event aliases, `eventType`/`eventTypes`, priority, `shouldProcess`,
replacement events, `{ producedEvents }` claiming/swallowing, rich
`ProcessorDeps`, direct database operations, thread metadata mutation, channel
actions/overrides, `goal`, schema provisioning, `run`, `withApp`, and legacy SSE
translation. It also has application-level idempotency and stale-dependency
workarounds that must survive the new delivery model.

Gate: migrate each custom processor to an explicit v3 primitive and keep its
application tests green. Do not remove the compatibility processor path before
all migrated processors and the real `createCopilotz + createChannelHandlers`
WhatsApp seam pass.

## Delivery Sequence and Gates

1. **Gate 0 — Design:** approve this ledger and the content/asset specification.
2. **Gate 1 — Characterization:** land P0 A-tests on current `main`; run all 624
   current declarations and downstream compile/smoke gates.
3. **Gate 2 — Internal seams:** introduce factory-created content, event,
   delivery, plugin, and execution interfaces without changing public behavior.
4. **Gate 3 — Vertical migrations:** move one capability at a time. Its existing
   tests, A-tests, and downstream gates must pass before deleting its old path.
5. **Gate 4 — New public model:** introduce plugins, public `ask`, attachments,
   and realtime streams with explicit compatibility adapters.
6. **Gate 5 — Database upgrade:** pass PGlite/PostgreSQL, crash, tenant, and v1
   snapshot matrices before destructive schema cleanup.
7. **Gate 6 — Aggressive cleanup:** remove only superseded modules, exports,
   dependencies, docs, and tests with green ledger replacements. Run unused
   export/dependency checks and the forbidden-symbol check.
8. **Gate 7 — Release:** all P0/P1 rows green; Deno, Node, Bun, browser, and
   Cloudflare core smoke tests pass; first-party downstreams have documented v3
   migration status.

## Open Decisions That Block Deletion

1. Which product guarantees, if any, require event supersession, coalescing, and
   run generations after moving to causal deliveries?
2. Does `goal()` remain a first-class simulation primitive, become a plugin, or
   receive a new API? Public `ask` alone is not equivalent.
3. Which current lower-level database reads become a supported query API rather
   than an unsafe graph mutation API?
4. Is the legacy processor adapter shipped for one major-version migration
   window, or are all first-party consumers migrated atomically before v3?
5. Which live compatibility projection is versioned at `/v1`, and does the new
   semantic attachment API ship at `/v2` or behind content negotiation?
6. Which current built-in resources are intentionally deprecated? The default is
   all remain.
