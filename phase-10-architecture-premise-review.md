# Phase 10 architecture premise review — historical review request

Status: **review completed; superseded for implementation**

Prepared: 2026-08-19

Repository: `lib/copilotz`

Branch context: `feat/plugin-first-event-source`

The review requested by this document was completed and its accepted/amended
premises were incorporated into `phase-10-implementation-lock.md`. This file is
retained as architecture and review history. It is not implementation authority.
The canonical `plugin-first-event-sourced-refactor-handoff.md` incorporates the
Phase 10 lock as its detailed phase contract.

Important retrospective: the additive shims, dual readers, old-shape
normalizers, and rolling support proposed as review questions below were
rejected. Code introduced on this unreleased refactor branch is migrated and
deleted in its owning Phase 10 slice. Only named published data crosses the cut
through isolated Phase 11 migration.

## 1. Assignment for the reviewing agent

Review the architecture proposed below before Phase 10 is specified or
implemented. The purpose is to challenge, refine, and make the premises
implementation-ready—not to rubber-stamp them.

Do not implement the proposal, move files, change package exports, alter the
database schema, or begin Phase 10. Do not modify the completed Phase 9 work.
Inspect the current code and return an evidence-backed architecture review.

For every numbered premise in section 5, classify it as one of:

- **Accept** — sound as written;
- **Amend** — directionally sound, but state the precise correction;
- **Reject** — explain the failure mode and provide a stronger alternative;
- **Defer** — valid question, but belongs after Phase 10; state the dependency
  that must be resolved first.

The review must distinguish:

1. facts about the current implementation;
2. desired invariants;
3. tentative API shapes;
4. published-data migration constraints;
5. decisions that must be locked before implementation.

Prefer the smallest coherent runtime. Do not achieve minimalism by moving
runtime-coupled code into nominal plugins while retaining hidden privileged
access.

## 2. Context and constraints

Phase 9 is complete. Its public domain call model is locked:

```ts
await context.collections.message.create({ ... }, options?)
await context.collections.message.update({ id, set, unset }, options?)
await context.collections.message.delete({ id }, options?)
await context.collections.llm_attempt.commands.complete({ id, ... }, options?)
await context.collections.message.queries.history({ threadId, ... }, options?)
await context.features.threadMessage.create({ ... }, options?)
```

The namespace is supplied only by scoped context. It cannot appear in domain
arguments or call options. A domain operation has one domain args object and an
optional execution-options object.

Processors and feature bodies do not receive a public transaction or raw
collection runtime. Collection commands are pure one-record mutations. Named
queries are reads. Features own reusable multi-collection or non-trivial
business policy. Runtime transaction joining remains an implementation detail.

Preserve these repository invariants:

- graph mutation, immutable event, and durable delivery obligations commit
  atomically;
- raw media/token chunks are never persisted as semantic events;
- resource availability does not imply caller or agent authority;
- injected persistence, dispatch, and host resources retain their ownership;
- runtime-neutral code does not import host filesystem/process APIs;
- distributed work resolves stable resource identities on the worker rather than
  serializing closures;
- public factories remain closure-backed and runtime-neutral;
- source-architecture cleanup belongs to the Phase 10 slice that replaces the
  source path; Phase 11 owns only published historical-data migration.

The existing Phase 10 handoff is narrower: it moves memory, knowledge, goals,
schedules, and usage into independent plugins. The reviewer must decide whether
the architecture below is:

- a prerequisite foundation for that Phase 10;
- an expanded Phase 10;
- several independently lockable Phase 10 slices; or
- partly deferred work that should not block the existing plugin moves.

## 3. Problem statement

Three related boundary problems remain.

### 3.1 Collection content and asset ownership are split

Several features do little more than:

1. convert prepared content into canonical assets;
2. perform a collection create/update/command;
3. link or synchronize the record's asset ownership.

That is mechanical persistence behavior rather than business policy. It makes
features larger, exposes content-storage choreography to every feature author,
and creates several ways to forget ownership synchronization.

The current code already contains two incomplete halves of the intended model
and, more fundamentally, two different APIs exported under the name
`CollectionDefinition`:

- `runtime/domain/definition.ts` defines the older repository shape, including
  `keys`, hooks, commands, and `content.fields`;
- `runtime/collections/definition.ts` defines the newer replayable-kernel shape,
  including named queries, pure patch commands, and `content.fields`;
- `runtime/domain/collections.ts` implements automatic materialization and
  ownership synchronization for the older shape;
- `runtime/domain/collection-manager.ts` currently casts every registered
  collection to the older definition/repository shape;
- `runtime/engine/database-scope.ts` additionally binds only definitions without
  a `keys` property into `runtime/collections/kernel.ts`;
- the replayable kernel does not currently consume `definition.content`;
- `runtime/features/context.ts` spreads the older scoped bindings first and the
  kernel bindings second, so the kernel binding wins for duplicate names;
- core features therefore manually call `materialize` and `linkOwner`.

The reviewer must validate this dual-path convergence and decide which
definition/runtime becomes canonical before proposing deletion of either path.

### 3.2 Runtime and plugin vocabulary are blurred

The plugin registry currently hardcodes domain-specific resource buckets such as
agents, LLMs, embeddings, tools, skills, MCP, APIs, channels, storage, and
memory kinds. Processor context separately hardcodes content, streams,
schedules, knowledge, and memory capabilities.

This makes it unclear which concepts are runtime mechanics and which are
domain/plugin semantics. Moving a module under `plugins/` would not solve the
problem if the engine still knows its names, repositories, events, workload, or
special context capability.

### 3.3 Streams currently mix control-plane and data-plane ownership

The `stream` record is a core-plugin collection, while the engine/runtime owns
the writer, follower, hardcoded workload, storage selection, attachment
projection, and `context.streams`. This is a real two-layer problem, but the
layers currently share one public concept and know too much about each other.

The stream writer also creates a `ContentRef` before a canonical asset graph
record necessarily exists. Progressive stream bodies and ordinary canonical
assets use related storage machinery but do not yet share one promotion and
recovery lifecycle.

## 4. Proposed north star

Describe the extensibility model as:

> Three privileged executable resource kinds—Collections, Features, and
> Processors—plus generic, typed dependency bindings supplied through plugin
> composition.

Under this model:

- the **runtime kernel** hosts mechanisms and enforces cross-cutting invariants;
- a **plugin** is a versioned bundle/composition unit and is not synonymous with
  “optional”;
- a **collection** declares durable graph state and its local policies;
- a **feature** declares reusable business logic and explicit dependencies;
- a **processor** reacts to events and invokes features or simple collection
  operations;
- providers, adapters, catalogs, host services, and storage backends are generic
  typed dependency bindings rather than additional engine-specific capabilities.

The default Copilotz experience may still install a convenient core preset. Its
semantics should come from ordinary plugin composition rather than hidden engine
branches.

## 5. Premises to review

### P1. Only three plugin resource kinds receive privileged runtime semantics

Collections, Features, and Processors are the only resource kinds the runtime
understands behaviorally:

- Collections participate in graph projection, validation, replay, relations,
  events, and mutation transactions.
- Features receive scoped dependency injection and an invocation lifecycle.
- Processors receive matched events and durable/transient execution semantics.

All other extensibility is expressed through generic resource bindings with
stable typed contracts.

Challenge:

- Are workloads, output projectors, context contributors, channels, or storage
  policies genuinely additional executable primitives?
- Can they be modeled as Features/Processors/bindings without awkwardness or
  loss of runtime guarantees?
- Which concepts must be special for distributed placement?

### P2. Feature packages may own resource contracts; actions may not create them

A package defining an LLM feature may export an LLM-provider resource contract.
Provider plugins bind implementations to that contract. The same pattern can
cover embeddings, body stores, tool implementations, API/MCP adapters, skill
sources, clocks, or other dependencies.

Illustrative only:

```ts
const llmProvider = defineResourceSlot<LlmProvider>({
  id: "@copilotz/llm.provider",
  contractVersion: 1,
  cardinality: "many",
  scope: "worker",
});

const llmFeature = defineFeature({
  id: "@copilotz/llm",
  requires: {
    providers: resources(llmProvider, { min: 1 }),
    attempts: collection("llm_attempt"),
  },
  actions: { generate: workflow(generate) },
});
```

Resource contracts are static, globally qualified, versioned, and validated
during composition. A running feature action cannot add a resource kind or
mutate the registry.

Challenge:

- Should the abstraction be called a slot, token, contract, port, capability, or
  resource kind?
- What runtime validation is needed when TypeScript types are unavailable?
- How should breaking contract versions be identified?
- Can generic bindings preserve current stable-ID override and preset behavior?

### P3. Plugins declare both provisions and requirements

Composition occurs in at least two logical passes:

1. collect contracts, definitions, and provided bindings;
2. resolve required/optional/many dependencies and instantiate scoped values.

Missing dependencies fail at composition, not during a delivery. Dependency
cycles report the complete chain. A preferred layering is:

```text
runtime ports and resource contracts
    -> adapter bindings and collections
        -> features
            -> processors
```

Cycles that represent asynchronous collaboration should normally be broken by
events/processors rather than service-locator access.

Challenge:

- Which dependencies may be lazy?
- Can features depend on features, and under what cycle rules?
- Do processors also declare dependencies?
- How are collection relation targets and processor event-source dependencies
  validated when only part of a plugin graph is installed?
- How are plugin selection, partial imports, and presets validated against
  requirements?

### P4. Injection is narrow and declared

Feature and processor code should not inspect an unrestricted global resource
registry. It receives only the collections, features, and typed bindings it
declared, plus minimal invocation information such as namespace, event,
identity, signal, and authority.

Availability and authority remain separate:

- dependency resolution says a provider/tool/skill implementation exists;
- caller and agent grants decide whether the current invocation may use it;
- feature-to-feature delegation must propagate authority without escalation.

Challenge:

- What minimal common context is unavoidable?
- How are application/worker/database/namespace/delivery lifetimes expressed?
- Who owns construction, pooling, concurrent access, failure isolation, and
  disposal for each binding lifetime?
- How do secrets and live connections remain worker-local?
- What debugging/introspection remains available without a service locator?

### P5. Collection declarations own canonical content fields

`content.fields` is the opt-in assetization contract. Absence means ordinary
inline JSON. Presence means the stored and replayed value is always a canonical
`ContentRef[]` sequence.

Illustrative only:

```ts
defineCollection({
  name: "message",
  schema: messageSchema,
  content: {
    fields: ["content"],
    storageClass: "default",
  },
});

await context.collections.message.create({
  id: "message-a",
  threadId: "thread-a",
  senderId: "participant-a",
  content: preparedContent,
});
```

The review must specify the contract per operation rather than treating every
mutation alike:

- **create** — define defaults/hooks, content preparation, canonicalization,
  schema validation, record storage, and ownership ordering;
- **update** — distinguish an omitted declared field, `set`, `unset`, `null`,
  and `[]`; untouched fields preserve their refs and changed fields synchronize
  ownership from the final record;
- **command** — keep the Phase 9 evaluator pure and one-record-scoped; define
  whether it observes prepared values or canonical refs, when its patch is
  canonicalized, and how retries produce the same mutation intent;
- **delete** — accept only the record identity/options contract, remove current
  liveness ownership, and never attempt content preparation;
- **replay** — derive ownership from canonical refs without re-uploading bodies
  or re-running external side effects.

Across applicable create/update/command operations, the kernel or an injected
transactional kernel extension must:

- accept existing canonical refs and the selected prepared/raw input contract;
- validate tenant scope and asset integrity;
- materialize or verify retry-stable asset metadata and body identity;
- replace prepared input with canonical refs before final record
  validation/storage;
- derive and synchronize ownership edges from the final record.

For create/update/command/delete, all database-native effects—asset metadata,
owner-edge changes, the collection event, and deliveries—must commit in the same
database transaction. Replacement/delete removes current liveness ownership
without prematurely deleting shared or historically retained bodies.

External body stores cannot join that database transaction. For ordinary
collection assetization—not only streams—the review must define a deterministic
staging/finalization protocol, retry-stable asset IDs and body keys, idempotent
retries, orphan cleanup, and reconciliation for at least:

- body written or finalized, then the SQL mutation rolls back;
- SQL metadata commits, but the body is absent or unavailable;
- a retry resumes after an indeterminate client or worker failure.

The contract must say whether deduplication fingerprints derive from stable
caller intent, body digest, or generated canonical refs. It must not claim
cross-system atomicity for SQL plus filesystem/S3.

Challenge:

- Should raw `ContentInput` also be accepted, or must callers prepare first?
- Should content policy live in the collection definition or JSON Schema
  annotations?
- How should nested fields, roles, cardinality, and field-level authorization be
  represented?
- How should command input typing expose prepared content while stored record
  typing remains canonical refs?
- Exactly where do hooks, defaults, command evaluation, content preparation,
  canonicalization, and validation occur relative to one another?
- Does assetization belong directly in the kernel or in a transactional kernel
  extension supplied by an assets plugin?

### P6. Assetization is declarative, not a per-call toggle

The same collection field must not alternate between raw bodies and canonical
refs based on the caller or deployment. Therefore:

- no content declaration means disabled for that field;
- a content declaration means required;
- globally disabling semantic assets while an installed collection declares
  content fails during composition;
- there is no silent inline fallback.

Thus the assets capability is conditionally required by the installed collection
graph, not independently removable from a preset whose collections declare
content. Disabling it either removes the whole dependent preset closure or
produces a deterministic composition error. The reviewer must separately
classify the stream plugin as required, conditionally required, or independently
optional.

Storage selection is separate from content semantics. A collection may name a
logical storage class. Composition maps it to database, filesystem,
S3-compatible, memory, or custom implementations. Portable collection plugins do
not contain credentials or host filesystem access.

Challenge:

- Is a global disable switch useful, or is absence of content-aware collections
  sufficient?
- Should storage classes be selectable per field, collection, namespace, media
  type, size, or policy function?
- Which choices must remain deterministic for replay and distributed workers?

### P7. Semantic assets are protected graph state over a pluggable body store

An asset has two distinct representations:

1. logical metadata and ownership in the graph;
2. immutable bytes in a selected body-store adapter.

Asset metadata should be graph-native and traversable, but not an ordinary
freely mutable/replaceable plugin collection. Treat it as a protected system
collection or system node model owned by the assets package and enforced by the
kernel contract.

Explicit upload/read/delete/maintenance operations may be exposed through an
assets/content Feature. Subordinate assets materialized as part of another
collection mutation should not create recursive “asset event whose body is
another semantic asset” behavior or an event explosion.

A database body adapter may use a physical `asset_bodies` table. Filesystem and
object adapters use keys/objects. The physical body location is not a domain
collection.

Challenge:

- Is asset metadata runtime-managed, assets-plugin-managed, or a protected
  hybrid?
- Should subordinate asset creation emit `asset.created`, only the owning
  collection event, or both?
- Should database bodies be moved out of graph-node JSON into a dedicated table?
- How are shared ownership, authorization, retention, deletion, and garbage
  collection defined?
- Can storage backends rotate while old readers remain available?

The review may choose a future `asset_bodies` or event-body representation, but
Phase 10 must not physically relocate historical bodies or rows. Phase 10 may
lock the target contract and add target new-write/read paths; Phase 11 owns
persisted-data migration unless the user explicitly expands the boundary.

### P8. Event bodies and semantic assets are separate contracts

The event-sourced runtime always requires immutable collection event bodies,
even when an application installs no semantic content collections. Define a
mandatory runtime `EventBodyStore` and an optional/default-installed semantic
asset capability. They may share an underlying generic body-store adapter but
have different identity, lifecycle, authorization, retention, and event rules.

Challenge:

- Is this separation necessary, or can one asset protocol safely cover both?
- If shared, how is recursion prevented?
- Which event-body storage must remain transactionally database-native?
- How does replay behave when an external body backend is unavailable?

### P9. Features have per-action execution modes

Feature-level `read | write` is insufficient. LLM, embedding, API, MCP, and
stream operations must not hold a SQL transaction open around external or
long-running work.

Tentative modes:

- `query`: read-only; no write transaction;
- `transaction`: deterministic, short, atomic collection work;
- `workflow`: external/long-running orchestration; each collection mutation is
  independently atomic and idempotent.

Challenge:

- Are these the right names and semantics?
- Can a workflow safely call transactional features and preserve causation,
  delivery identity, settlement scope, and authority?
- What prevents side effects from being replayed after an indeterminate failure?
- Does a long-lived session/stream require a fourth feature action contract?

### P10. LLM, Embedding, Agent, Tool, API, MCP, and Skill semantics are plugins

The runtime should not know provider selection, prompt construction, model
fallbacks, tool catalogs, agent definitions, skill disclosure, API descriptors,
or MCP connection semantics.

Tentative decomposition:

- an LLM feature consumes LLM-provider bindings and owns attempt orchestration;
- an Embedding feature consumes embedding-provider bindings;
- a Tool Catalog feature normalizes native tools, APIs, and MCP descriptors;
- a Tool Execution feature consumes normalized tool implementations;
- an Agent feature consumes higher-level LLM, tool, skill, context, and peer
  features rather than direct provider adapters;
- processors coordinate event-driven conversation flow using these features.

Challenge:

- Which feature owns provider fallback and physical attempt accounting?
- Where does prompt/transcript construction live?
- Should LLM and embedding remain separate even when one vendor adapter supplies
  both?
- Which catalog pieces are static resources versus executable features?
- How are agent grants enforced without letting a broadly injected feature
  bypass them?

### P11. Stream control state is a plugin; the byte plane is runtime machinery

“Stream” currently names two different concepts:

- durable control-plane state: ID, thread/participant relation, lane, routing,
  lifecycle, ownership, audit, and reconnect metadata;
- a live data plane: bytes, backpressure, cancellation, offsets, storage,
  framing, and distributed work placement.

Proposed ownership:

- a default stream plugin supplies the `stream` collection, stream Feature,
  workload/output bindings, and stream event projection;
- runtime supplies only generic byte transport, cancellation, placement, and
  progressive body-store ports;
- processors normally call `features.stream`; they do not receive both a special
  `context.streams` capability and direct lifecycle mutation authority;
- runtime does not hardcode the collection name `stream`, semantic stream event
  names, or a reserved Copilotz stream workload.

Challenge:

- Are workload handlers and output projectors generic bindings, Features, or
  additional privileged resource kinds?
- How can a stream Feature expose a long-lived writer without keeping its
  transaction open?
- Should raw lifecycle collection mutation be restricted to the stream Feature,
  migrations, and administration?
- Which portions must exist when realtime streaming is disabled?

### P12. Streams and assets remain distinct, with explicit promotion

A stream is a production/delivery session. An asset is immutable retained
content. Assets may exist without streams, and transient/failed streams may
produce no asset.

For retained streams, review this lifecycle:

1. reserve fenced staging storage and create open stream control state;
2. pump bytes outside a database transaction;
3. finalize the physical body;
4. atomically create/mark ready canonical asset metadata, link ownership, and
   close the stream;
5. reconcile open records, abandoned staging, and finalized-but-unlinked bodies
   after crashes.

S3/filesystem and SQL cannot form one physical transaction. “One operation” is
therefore an idempotent saga with recovery, not cross-system atomicity.

Challenge:

- Should an open stream point to a staging asset, a private body handle, or no
  content at all until finalization?
- How is late replay defined for transient streams?
- Which body stores are valid for distributed writers/followers?
- How are writer fencing, takeover, cancellation, retain/discard, and offset
  reconnect preserved?
- Are existing Stream rows published data, or unreleased rows that should be
  removed when callers/tests move to the final protocol?

### P13. Distributed composition is explicit and verifiable

Gateway and workers must agree on resource contracts and stable identities, but
secrets and live adapters remain local. Workers should advertise or derive a
composition fingerprint plus locally satisfiable processor/feature requirements.
Work is routed only to workers meeting its declared requirements.

Challenge:

- What belongs in the fingerprint?
- How do overrides and plugin versions affect requirement matching?
- Can a worker satisfy only a subset of features/processors?
- What data may be serialized in delivery/workload metadata?
- How are rolling deployments and open streams handled?

## 6. Runtime/plugin boundary to validate

The proposal currently places the following in the runtime kernel:

- generic plugin/resource contract collection and dependency resolution;
- namespace and invocation scoping;
- collection graph projection, validation, replay, named commands/queries, and
  relation derivation;
- immutable event storage, event-body durability, processor matching, delivery
  obligations, leases, retries, cancellation, settlement, and recovery;
- feature invocation modes, nested identity/authority propagation, and
  idempotency;
- generic SQL/session, dispatcher, clock, ID, digest, byte transport, and body
  storage ports;
- distributed work framing, placement, cancellation, and backpressure.

The proposal currently places the following in plugin composition:

- every named domain collection and its semantic schema;
- every business Feature and Processor;
- conversation, agent, LLM, embedding, tool, API, MCP, skill, memory, knowledge,
  schedule, goal, usage, channel, asset-policy, and stream-lifecycle semantics;
- concrete LLM/embedding/tool/API/MCP/channel/storage adapters;
- context contributors, prompt policy, catalogs, projections, and optional
  administration features.

Review each item that crosses or strains this boundary. In particular, identify
anything nominally placed in a plugin that would still require a privileged
engine repository, hardcoded collection/event name, special processor context
field, or unconditional workload installation.

## 7. Alternatives that must be compared

Do not evaluate only the preferred proposal. Compare at least these options:

### A. Fixed resource-type registry

Keep the current global union of resource types, add requirements and scoped
injection, and move semantics into plugins without introducing generic slots.

### B. Three privileged kinds plus generic typed slots

Keep Collections/Features/Processors special and represent everything else as
versioned typed bindings. This is the current preferred premise.

### C. Fully generic resource kinds

Even Collections/Features/Processors are registered through resource-kind
descriptors that supply validators and lifecycle hooks.

### D. Service/plugin split without feature dependency injection

Keep explicit runtime services for content, streams, LLM, tools, etc., and use
plugins primarily for registration/overrides.

For each option, compare:

- TypeScript developer experience;
- runtime validation and error quality;
- plugin packaging and partial imports;
- least authority;
- testability;
- distributed placement;
- override/version matching;
- startup and invocation cost;
- migration complexity from the current API;
- likelihood of recreating a god-object registry or hidden runtime privilege.

## 8. Required evidence and code areas

At minimum, inspect and cite the relevant portions of:

- `runtime/collections/definition.ts`
- `runtime/collections/kernel.ts`
- `runtime/collections/reducer.ts`
- `runtime/domain/definition.ts`
- `runtime/domain/collection-manager.ts`
- `runtime/domain/collections.ts`
- `runtime/features/types.ts`
- `runtime/features/context.ts`
- `runtime/plugins/types.ts`
- `runtime/plugins/registry.ts`
- `runtime/engine/types.ts`
- `runtime/engine/context.ts`
- `runtime/engine/database-scope.ts`
- `runtime/content/types.ts`
- `runtime/content/database-repository.ts`
- `runtime/content/body-store.ts`
- `runtime/content/database-body-store.ts`
- `runtime/content/storage.ts`
- `runtime/streams/writer.ts`
- `runtime/streams/follower.ts`
- `runtime/streams/workload.ts`
- `runtime/attachments/attachment.ts`
- `plugins/core/plugin.ts`
- `plugins/core/resources/collections/stream.ts`
- `plugins/core/resources/features/content-policy.ts`
- `plugins/core/resources/features/message.ts`
- `plugins/core/resources/features/thread-message.ts`
- `plugins/core/resources/features/llm-attempt.ts`
- `plugins/core/resources/features/tool-execution.ts`
- `runtime/application/core-plugins.ts`
- `runtime/application/types.ts`
- current contracts and the Phase 9/10 handoff sections.

Inspect additional files where necessary. Do not infer behavior from filenames
when the implementation can answer the question.

## 9. Required review output

Return one review memo with these sections:

1. **Executive verdict** — whether the north star is coherent and the largest
   correction it needs.
2. **Current-state findings** — confirmed facts, contradictions, and hidden
   coupling, with file references.
3. **Premise decisions** — P1 through P13 marked Accept/Amend/Reject/Defer.
4. **Recommended final vocabulary** — precise definitions of Runtime, Plugin,
   Resource Binding, Collection, Feature, Processor, Asset, Stream, and
   Authority.
5. **Resource/dependency model** — static shape, lifecycle, requirements,
   versioning, overrides, partial imports, cycle rules, and narrowed injection.
6. **Collection assetization contract** — convergence of both current
   definition/runtime paths; exact create/update/command/delete/replay ordering;
   inputs, stored form, ownership, backend selection, retry-stable identity,
   external-store recovery, orphan cleanup, and GC.
7. **Asset architecture decision** — graph metadata ownership, body-store model,
   event-body separation, SQL table decision, and plugin/runtime split.
8. **Stream architecture decision** — collection/feature/data-plane split,
   staging/promotion/recovery, distributed requirements, and public API.
9. **Feature execution model** — per-action modes, nested calls, authority,
   external side effects, and idempotency.
10. **Plugin decomposition** — proposed first-party plugin packages/presets,
    dependency direction, and required/conditionally-required/optional status,
    including LLM, embedding, agent, tools, API/MCP, skills, assets, and
    streams.
11. **Published-data migration plan** — named source versions, one-way data
    translation, validation, and deletion gates.
12. **Phase placement** — what must be a Phase 10 prerequisite, what belongs in
    Phase 10 slices, and what should remain Phase 11 or later.
13. **Test and proof matrix** — concrete contracts required before deletion or
    movement.
14. **Proposed lock text** — a concise, implementation-ready replacement or
    expansion for the existing Phase 10 handoff section.

The memo must end with:

- unresolved decisions that require user choice;
- a recommended implementation sequence;
- explicit files/symbols that must not be moved or deleted in the first slice.

## 10. Acceptance criteria for a future Phase 10 lock

The review is ready to become an implementation lock only if it resolves or
explicitly defers all of the following:

- one canonical collection runtime owns declared content semantics;
- the two current `CollectionDefinition` shapes and their convergence path have
  an explicit convergence/removal plan;
- exact content input/stored/replay contracts are specified;
- create, update, command, delete, and replay semantics are specified
  independently, including omitted/`unset`/`null`/empty content behavior and
  hook/evaluator/canonicalization/validation ordering;
- asset metadata, body storage, event bodies, ownership, retention, and GC have
  non-overlapping owners;
- database, filesystem, S3-compatible, memory, and custom storage behavior is
  deterministic and portable;
- ordinary collection and stream external-storage crash windows, retry-stable
  identities, orphan cleanup, and recovery are specified;
- plugin and runtime are defined behaviorally, not by directories;
- resource requirements, versioning, lifetimes, overrides, cycles, partial
  imports, and runtime validation are specified;
- dependency availability and invocation authority are separate;
- feature action modes prevent transactions from spanning external calls;
- distributed workers can prove required composition without receiving secrets
  or closures;
- stream control state and byte transport have explicit owners;
- retained versus transient stream semantics and asset promotion are defined;
- every first-party plugin is classified as required, conditionally required, or
  independently optional; disabling an independently optional plugin removes
  only its resources and does not change kernel behavior, while removing a
  required dependency deterministically fails composition or removes the whole
  dependent preset closure;
- superseded in-repository paths are migrated and deleted in their owning slice;
- Phase 11 migration/native DTO cleanup boundaries remain explicit;
- Phase 10 may lock future storage representations, but historical persisted
  data relocation remains Phase 11 unless the user explicitly expands scope;
- the full existing event, delivery, attachment, SSE/WebSocket, content,
  collection replay, and plugin override contracts remain provable.

## 11. Candidate implementation sequence — not locked

This candidate was superseded. In particular, its additive fixed-bucket path,
generalized lifecycle/fingerprint machinery, Stream wrapper, and dual readers
were rejected. The incorporated Phase 10 lock contains the approved sequence:
introduce the final mechanism with a real vertical, migrate every caller and
test, and delete the replaced path before that slice closes. Published data is
translated separately in Phase 11.

## 12. Non-goals for this review

- Do not implement or benchmark the proposal.
- Do not rename the project-wide plugin API merely for aesthetics.
- Do not move files just to make directory ownership look cleaner.
- Do not perform source deletion in this review-only task; the accepted lock
  assigns each deletion to the Phase 10 slice that replaces its owner.
- Do not design client-specific Compass/Gilpinna/Mobizap behavior.
- Do not make raw content resolution implicit on collection reads; large bodies
  should remain explicit/lazy unless the review proves otherwise.
- Do not persist raw stream chunks as events.
- Do not treat S3/filesystem writes as transactionally atomic with SQL.
- Do not weaken stable-ID overrides, tenant isolation, idempotency, or agent
  capability grants.

The desired outcome is a refined architecture and lock-ready Phase 10 plan—not
code.
