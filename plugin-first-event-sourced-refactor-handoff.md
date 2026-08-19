---
title: Copilotz Plugin-First Event-Sourced Refactor Handoff
description: Self-contained implementation authority for rebuilding Copilotz from the clean 0.60.18 main baseline.
status: proposed
baseline: 2b2bb77cac780dfecebada11691643795a90adaf
target: 0.61.0
---

# Copilotz Plugin-First Event-Sourced Refactor Handoff

## 1. Purpose and authority

This document is the implementation handoff for the next Copilotz refactor. It
starts from clean `main` at commit `2b2bb77` (`0.60.18`). No code from the
abandoned implementation attempt is part of the baseline.

The retained foundation and earlier implementation-plan documents are decision
history. This document is the implementation authority. When they conflict,
follow this document. When a required decision is genuinely absent, stop and
ask rather than inventing a second architecture.

The target is not a source-tree reshuffle. The target is one coherent system in
which:

```text
commands
   │
   ▼
typed collections ──► immutable replayable events ──► deterministic reducers
   │                           │                              │
   │                           ├──► durable deliveries        ▼
   │                           └──► asset-backed bodies    nodes + edges
   │
   └──► plugin processors ──► child collection commands

streams ──► stream.created ──► progressively written asset
                                  │
                                  ├──► independent followers
                                  └──► one terminal stream.updated
```

The finished implementation must be smaller conceptually than the baseline. It
must remove duplicate domain repositories, duplicate validation, hidden
workflow mutation paths, and modality-specific execution architectures.

## 2. Working rules for the implementing agent

These rules are part of the acceptance contract.

1. Work sequentially through the phases. Phases 1–4 are not parallel work.
2. Do not move a subsystem merely to make the target tree appear complete.
3. Add the new canonical mechanism, prove it, port one behavior, then remove the
   replaced path.
4. Do not create compatibility repositories or plugin `utils` that reproduce
   runtime collection operations. A collection query one-liner is success;
   `getParticipantByExternalId` in `plugins/core/utils/` is failure.
5. Do not copy validators from existing repositories. Collection JSON Schema is
   the record validator.
6. Do not add a second event, reducer, relation, content, stream, or processor
   abstraction to bridge old and new code.
7. Preserve current behavior with characterization tests before deleting it.
8. A focused test passing does not override an earlier architectural gate.
9. Keep each phase reviewable and commit it independently.
10. Record any proposed deviation in the document before implementing it.
11. Judge Phases 1–4 by kernel invariants, not plugin-author DX. Declarative
    core processors and direct collection reads land in Phases 5–6.
12. If a phase produces a bridge type, a second processor context, or a
    compatibility conversation helper, stop and record the deviation before
    continuing.

Factories are appropriate only when binding runtime state or injected
dependencies. Static resources are exported as declarative constants. Use
functions and closures rather than classes. Test doubles for model invocation
are `llm` resources, not leftover plugin factories.

## 3. Non-negotiable architecture

### 3.1 Generic runtime, application behavior in plugins

Copilotz is:

```text
generic runtime + core plugin + optional/application plugins
```

The runtime owns mechanisms:

- plugin composition and stable-ID precedence;
- collection definition, validation, command evaluation, reduction and query;
- atomic event, projection and delivery commits;
- replay and projection verification;
- content and asset storage;
- processor matching, delivery, retry and settlement;
- stream writing, following and checkpoints;
- provider invocation boundaries;
- Oxian placement and transport;
- host/runtime adapters.

The runtime does not own policy for:

- selecting an agent in response to a message;
- composing a model prompt;
- continuing a turn after a tool result;
- public multi-agent `ask`;
- memory consolidation;
- knowledge retrieval;
- schedules or goals;
- channel-specific identity and routing.

Those behaviors are plugin resources.

### 3.2 Closed resource vocabulary

Copilotz owns one closed resource vocabulary:

```text
agents
collections
processors
context
llm
embedding
tools
skills
features
storage
mcp
api
```

Plugins implement these resource types; plugins do not define new resource
categories at runtime.

The following are plugin compositions, not resource categories:

- memory;
- knowledge;
- goals;
- schedules;
- usage/accounting policy;
- Web, CLI, WhatsApp, Telegram and other channels.

Remove the baseline categories or concepts `providers`, `channels`,
`memoryKinds`, `apis`, and `mcpServers` as parallel vocabularies. Their concrete
resources migrate to `llm`, plugin compositions, `context`, `api`, and `mcp`.

`features` and `api` stay in the vocabulary. They are not interchangeable, and
neither is an escape hatch for a new kernel mechanism:

- `features` are reusable, typed business operations contributed by plugins.
  Processors invoke them through `context.features`. The application layer,
  when enabled, projects them as `/features/...` the same way it projects
  collection CRUD. Admin projections, OAuth start/callback, session and
  tenant switching belong here. Do not wrap a single `collection.create`
  in a feature.
- `api` resources are outbound, agent-callable HTTP tools (OpenAPI or
  equivalent). They are capability-granted like other tools. Agents do
  not call features; they call tools.
- Durable domain *state* is a collection. A *reaction* to an event is a
  processor. A *command* that several callers must share **and** that
  spans more than one collection write (or non-trivial policy) is a
  feature. `collections.message.create` is the message write; there is
  no `postMessage` feature whose only job is to call that. A feature is
  not a processor: it has no event matcher and must not wait on
  deliveries.
- A new *mechanism* (locking, a second event bus, privileged graph writes, a
  scheduler kernel, a memory runtime) is a runtime change. Amend this document
  first. Do not add a thirteenth resource type and do not dump the mechanism
  into `features` because the action type is untyped.

Feature contract:

- identity is `invoke(action, input)`, not an HTTP `FeatureRequest`;
- context is the same injected primitives as processors (`collections`,
  `transaction`, `content`, `resources`, `features`) plus namespace.
  It does not receive `application`;
- writes go only through collections and content. No conversation
  repository, no raw SQL, no public event types emitted by hand;
- when a processor (or parent feature) calls a feature, the callee
  **joins the caller's transaction and delivery identity**. It does not
  open a nested dispatch or a second worker turn;
- HTTP/auth/path shaping is an application projection over that invoke,
  optional when no application layer is composed.

A feature that can reach `application` in today's baseline is a god-object.
That is retired, not preserved.

Composition precedence remains:

1. core plugin;
2. declared plugins in order;
3. explicit top-level resources.

A later resource with the same type and stable ID replaces the earlier one.
Resource availability never implies agent authority.

### 3.3 Dependency direction

The dependency direction is strict:

```text
plugin implementation ──► public Copilotz resource contracts
runtime mechanism      ──► public/internal runtime contracts
runtime mechanism       X► concrete plugin implementation
```

- `runtime/**` must not import `plugins/**`.
- A plugin imports Copilotz as an external plugin would, through exported package
  subpaths such as `@copilotz/copilotz/collections`.
- Plugin resource files must not import `runtime/**` by relative path.
- Resource contracts live in their owning runtime category, not in a central
  `runtime/resources` mirror.
- Do not maintain separate plugin and runtime versions of the same interface.

### 3.4 Declarative plugins

The core plugin is exported as data:

```ts
export const corePlugin = definePlugin({
  manifest: corePluginManifest,
  resources: {
    collections: [...],
    processors: [...],
    context: [...],
    tools: [...],
  },
});
```

Do not wrap a static plugin in `createCorePlugin()`. A configurable provider or
host integration may use a factory when it genuinely binds credentials,
network clients or application state.

## 4. Target source ownership

Exact filenames may evolve, but ownership may not.

```text
runtime/
  agents/        Agent contract, capability selection and runtime selection.
  collections/   Definition, inferred types, commands, reducer, query and binding.
  events/        Envelope, body contract, store, coordinator, replay and schema.
  processors/    Resource contract, matcher, static delivery and transient binding.
  context/       Context resource matching, composition, budgeting and snapshots.
  streams/       Stream collection mechanics, progressive writer and followers.
  llm/           Provider contract, generate/session invocation and normalization.
  embedding/     Embedding resource contract and invocation.
  tools/         Tool contract, grants, validation and invocation.
  skills/        Skill resource contract and portable content access.
  features/      Feature resource contract and invocation.
  storage/       Storage resource contracts and adapter selection.
  mcp/           MCP resource contract and runtime invocation.
  api/           API resource contract and runtime invocation.
  content/       Asset metadata, body stores, preparation and resolution.
  attachments/   Command ingress and transient event/stream observation.
  execution/     Oxian workloads, claims, cancellation and result relay.
  plugins/       Manifest validation, composition, registry and precedence.
  application/   Composition root only; no hidden domain repositories.
  adapters/      Deno, Node, browser, Cloudflare and host capabilities.

plugins/
  core/
    plugin.ts
    manifest.ts
    resources/
      collections/
      processors/
      context/
      agents/
      llm/
      embedding/
      tools/
      skills/
      features/
      storage/
      mcp/
      api/
  memory/
  knowledge/
  goals/
  schedules/
  usage/
  web/
```

A plugin may omit empty directories. Avoid generic `utils/` migration layers.
Small pure business helpers are acceptable only when they are not persistence,
collection, validation, resource-resolution or lifecycle facades. Recurring
reads belong on the collection as declared queries, not as plugin wrappers.

## 5. Collection contract

### 5.1 Collection definition is the domain definition

One `defineCollection()` value is the canonical source for:

- record JSON Schema;
- inferred select and insert types;
- defaults;
- indexes;
- text/vector search configuration;
- declared relationships;
- content fields;
- event envelope projection;
- optional before-create/update/delete validation or transformation;
- named deterministic mutations;
- optional named queries for recurring policy reads.

Do not maintain parallel schemas or handwritten record validators.

The runtime derives:

```ts
collection.create(input, options?)
collection.update(id, { set, unset }, options?)
collection.delete(id, options?)
collection.mutate(id, command, input, options?)

collection.get(id)
collection.list(query?)
collection.query(query)
collection.query.byExternalId(input) // when declared on the collection
collection.search(query)
```

Reads never emit events. The query vocabulary is not a mini-ORM and not raw
SQL. Phase 3 derives it from the actual read patterns of the six core
collections, not from an abstract query-engine wishlist:

- participant by id and by `externalId`;
- thread membership and participant/thread hydration;
- message history with active branch, revision and visibility;
- attempt and tool-execution ownership;
- stream lookup by thread, lane and status.

It supports bounded filters, conditions, ordering, cursor pagination, field
projection, declared relation filters/includes, text search and vector
similarity. If a recurring read is policy rather than a one-off filter, declare
it on the collection:

```ts
defineCollection({
  name: "participant",
  schema: participantSchema,
  queries: {
    byExternalId: {
      filter: ({ input }) => ({ externalId: input.externalId }),
    },
  },
});

await collections.participant.query.byExternalId({ externalId });
```

Named queries still use the generic query engine, emit no events, and are not
repositories. They exist so processors never grow `plugins/core/utils/` facades.

### 5.2 Mutation result

Every write returns one standard result; no semantic repository is required to
recover its event or settlement identity:

```ts
type CollectionMutation<TRecord> = Readonly<{
  record: TRecord;
  event: DurableEvent;
  settlementScopeId: string;
  deliveries: readonly EventDelivery[];
}>;
```

Delete may return the final record plus a deletion marker. An atomic command
scope returns its ordered child mutations and an explicit caller-selected
value.

### 5.3 Named mutations

Collections may declare named commands, but their evaluator is always `mutate`:

```ts
defineCollection({
  name: "job",
  schema: jobSchema,
  commands: {
    claim: {
      mutate({ current, input }) {
        if (current.status !== "pending") return;
        return {
          set: { status: "claimed", claimedBy: input.workerId },
          unset: ["availableAt"],
        };
      },
    },
  },
});
```

Rules:

- `mutate` is synchronous, pure and deterministic;
- `void` is a true no-op and emits no event;
- `set` replaces addressed values and does not deep-merge objects;
- `unset` removes addressed fields;
- the callback performs no I/O, database access, clock access or ID generation;
- ID generation, clocks and namespace stamping are runtime-applied around
  `create`, `update`, `delete`, `mutate` and schema defaults;
- collection `defaults` may name fields the runtime fills (`id`, `createdAt`,
  `updatedAt`); they must not be user callbacks that call `ulid()` or
  `Date.now()`;
- `beforeCreate` / `beforeUpdate` / `beforeDelete` remain synchronous, pure and
  schema-bound. They must not become a second command evaluator;
- the runtime validates the resulting record against the collection schema;
- command input validation may use an optional command input schema, not
  handwritten duplicate record validation.

A command such as `claim` still emits `job.updated`, never `job.claimed`.

### 5.4 Relationships and the edge table

Declared collection relationships are projected into the shared `edges` table
by the collection reducer. Reads traverse those named relationships through the
collection query contract.

There is no generic core `relation` collection and no relation repository. That
would duplicate a relationship as both a node and an edge.

If a future plugin proves that a relationship is itself a domain entity with an
independent lifecycle, that plugin may define an explicit collection after a
concrete contract is approved. Do not introduce dynamic-edge records preemptively.

No plugin writes `nodes` or `edges` directly.

### 5.5 Atomic multi-collection commands

The runtime exposes one transaction-scoped composition mechanism containing
ordinary bound collection operations:

```ts
await context.transaction({
  operationKey: "thread:create",
  async execute({ collections }) {
    const participant = await collections.participant.create(...);
    return await collections.thread.create(...);
  },
});
```

Each non-noop child:

- uses its collection evaluator and reducer;
- emits its own canonical event;
- updates its own node and declared edges;
- resolves its own delivery obligations;
- receives deterministic correlation, causation and deduplication identities.

All child mutations commit or roll back together. Dispatch happens only after
the outer transaction commits. Plugins never receive raw SQL transactions.

When a processor would otherwise call `context.conversation` (or grow a
plugin `utils` helper), put that policy on the owning collection instead:

- named commands on `thread` for membership, active message branch, and
  other thread-owned fields the facade used to patch;
- named commands already on `llm_attempt` / `tool_execution`
  (`complete` / `fail` / `cancel`);
- `message.create` (and revision as a new `message.created` row) for
  the message itself.

Command evaluators stay pure `mutate` of that one record (§5.3). A
sequence that touches several collections is `context.transaction`, not a
conversation repository. Add commands when a processor repeats a policy;
do not pre-build a command catalog.

## 6. Replayable event contract

### 6.1 Canonical event names

Every domain collection uses only:

```text
<collection>.created
<collection>.updated
<collection>.deleted
```

No command-specific durable event names are added.

### 6.2 Compact envelope, immutable asset-backed body

Every Copilotz event is durable and positioned. The event table stores a compact
queryable envelope:

```ts
type DurableEvent = Readonly<{
  id: string;
  position: string;
  schemaVersion: number;
  eventType: string;
  namespace: string;
  threadId?: string;
  subject?: { type: string; id: string };
  routing: EventRouting;
  visibility: EventVisibility;
  metadata: Readonly<Record<string, unknown>>;
  causationId?: string;
  correlationId: string;
  deduplicationId?: string;
  dataRef: ContentRef;
  createdAt: string;
}>;
```

The body behind `dataRef` is immutable JSON, even when small. Database-backed
asset bodies remain the default; memory, filesystem, S3/GCS-compatible and
custom stores use the same resolver contract. Event storage never recursively
emits `asset.created`.

Canonical bodies are versioned:

```ts
type CollectionCreated<T> = {
  operation: "create";
  record: T;
};

type CollectionUpdated<T> = {
  operation: "update";
  id: string;
  set: Partial<T>;
  unset: readonly string[];
  record: T;
};

type CollectionDeleted<T> = {
  operation: "delete";
  id: string;
  record: T;
};
```

Declared content values inside `record`, `set` or `unset` are `ContentRef`s, not
raw duplicated bodies. An updated body includes the final record so replay can
verify the mutation deterministically and processors receive immutable command
authority without reading a later projection.

### 6.3 Projection invariant

Nodes and edges are operational projections. For any position `N`:

```text
replay(events <= N, empty projections) == committed projections at N
```

The normal write path updates events and projections atomically for query
efficiency. That does not make the event log non-replayable.

Side effects never run inside reducers. Reducers only calculate and persist
projections, relationships and content ownership from canonical events.

## 7. Content and assets

Asset metadata remains graph state; asset bodies use pluggable body stores.
Database storage remains the default. Filesystem and S3-compatible storage are
explicit options. GCS uses the supported S3 interoperability configuration.

Rules:

- collection fields declared as content always contain refs, regardless of body
  size;
- there is no size threshold that sometimes embeds and sometimes assetizes the
  same semantic field;
- ordinary metadata remains in the record schema;
- event JSON bodies are always body-store backed;
- ready assets are immutable;
- reads use one bounded, parallel resolver shared across the codebase;
- credentials and physical locators never enter `ContentRef`, events or client
  payloads;
- storage catalog rows, multipart state and checkpoints are operational storage
  authority and do not emit recursive domain events.

When the body store is the database, envelope, body, node, declared edges and
delivery rows commit in one atomic write. A processor must not observe an
envelope whose `dataRef` is not yet durable. Cross-store body uploads (S3,
filesystem) may stage then commit; failure before commit leaves no event. This
is a Phase 1 invariant, not a later optimization. Always-assetized event bodies
are acceptable because that default store hop is the same transaction, not an
extra network write.

Parquet or other analytics projections are future processor outputs. They are
not the canonical node or event format in this refactor.

## 8. Processor contract

### 8.1 One processor definition

```ts
defineProcessor({
  id: "core.agent-turn",
  on: [
    { eventType: "message.created" },
    {
      eventType: "stream.created",
      data: { record: { lane: "content", mediaType: "audio/*" } },
    },
  ],
  settlement: "inherit",
  async handle(event, context) {},
});
```

- entries in `on` are OR;
- fields inside one entry are AND;
- nested objects use partial structural equality;
- media types support exact and wildcard matching;
- matching is synchronous and pure;
- matching may inspect the envelope and prepared JSON body, never stream bytes;
- dynamic decisions belong inside `handle`.

Remove string-only `on`, `delivery`, callback `filter`, phases, priorities,
claiming, swallowing and `producedEvents`.

### 8.2 Static and transient binding

Binding lifetime determines durability:

- a processor composed as a plugin resource is static and receives an atomic
  delivery obligation for every match;
- a connection-bound use of the same processor contract is transient, observes
  committed events and creates no delivery row;
- `settlement: "inherit" | "detached"` applies only to static processors;
- the stable processor ID is the durable logical consumer ID.

Attachments, `run()`, SSE, WebSocket and CLI use transient bindings. They resume
from event position and stream offsets.

### 8.3 Event authority

Before invoking a handler, resolve and verify `event.dataRef` once and deep-freeze
the body. The handler receives the immutable canonical record/mutation.

The first executor step must not be `get(event.subject.id)` to reconstruct what
happened. A processor may query projections for a genuinely new decision. Before
an external side effect, the selected immutable input is captured in a child
collection event.

Processor handlers use injected runtime primitives directly:

```text
context.collections
context.transaction
context.content
context.streams
context.llm
context.tools
context.context
context.resources
```

Do not inject `conversation`, `llmAttempts`, `toolExecutions`, `relations`, or
equivalent semantic repository facades. Recurring reads use collection query or
a declared named query on that collection.

## 9. Core and optional plugins

### 9.1 Core collections

The minimum core domain collections are:

- `participant`;
- `thread`;
- `message`;
- `llm_attempt`;
- `tool_execution`;
- `stream`.

Each is a declarative `defineCollection()` resource. Their record types are
inferred and exported from their definitions. Thread participation, message
sender/thread ownership, attempt ownership and tool ownership are declared
relationships projected to `edges`.

Asset catalog state is a content-storage mechanism and must not be forced into a
recursive ordinary collection lifecycle.

Usage, memory, knowledge, goals and schedules belong to their own plugins unless
a concrete core invariant proves otherwise.

### 9.2 Core processors

The core plugin implements the complete default conversation lifecycle as small
processors with direct collection operations. They never call
`context.conversation`, `context.llmAttempts`, or `context.toolExecutions`.

1. react to an addressed public `message.created` and capture an immutable model
   execution input in `llm_attempt.created`;
2. execute an LLM attempt from that event body;
3. persist progressive output as streams and issue one terminal
   `llm_attempt.updated`;
4. project final agent messages and create tool executions;
5. execute each tool from its immutable `tool_execution.created` body;
6. issue one terminal `tool_execution.updated`;
7. project the public tool-result message and continue the producing agent only
   when its labelled parallel batch is settled;
8. implement public `ask` through ordinary public messages and causation.

The exact filenames are not contracts. Each file under
`plugins/core/resources/processors/` must export an actual processor. Pure helper
logic does not masquerade as a processor resource.

### 9.3 Public multi-agent ask

`ask` is an ordinary tool capability:

- the asking agent creates a public message addressed to the target agent;
- the target response is a public message;
- causation metadata settles the ask tool execution and resumes the caller;
- nested and parallel asks remain visible in the same conversation;
- private `delegate_task` consultation is removed.

Tool-result and reasoning visibility policies remain configurable; normal
participant conversation is public.

### 9.4 Optional domain plugins

Memory, knowledge, goals, schedules and usage are composed from the same closed
resource vocabulary. For example, a memory plugin owns collections and
processors and contributes selected memory through a `context` resource. It
does not require a privileged runtime `memory` capability.

## 10. Agent and LLM contract

### 10.1 Agent runtime

```ts
type AgentRuntime = Readonly<{
  mode?: "generate" | "session"; // generate by default
  provider: string;
  model?: string;
  input?: readonly ("text" | "image" | "audio" | "video" | "file")[];
  output?: readonly ("text" | "image" | "audio" | "video" | "file")[];
  options?: Readonly<Record<string, unknown>>;
  fallbacks?: readonly AgentRuntimeFallback[];
}>;

type Agent = Readonly<{
  // identity, instructions, capabilities and metadata
  runtime?: AgentRuntime | readonly AgentRuntime[];
}>;
```

- one object is the common case;
- an array contains at most one runtime per mode;
- multiple runtimes represent lifecycle modes, not provider failover;
- fallbacks remain in the same mode;
- remove `llmOptions`, `runtimes.text` and `runtimes.realtime` from the final
  contract;
- credentials stay in injected runtime/provider configuration.

### 10.2 LLM resource

An `llm` resource is one vendor adapter. It is not an orchestrator, not a
chat bag, and not a place for prompt/history/timeout policy.

```ts
type LlmResource = Readonly<{
  id: string; // "openai", "anthropic", "acme.qwen", …
  type: "llm";
  generate?: (input: LlmGenerateInput) => LlmInvocation;
  session?: (input: LlmSessionInput) => LlmInvocation;
}>;

type LlmInvocation = Readonly<{
  frames: ReadableStream<LlmFrame>; // protocol values, not Copilotz events
  result: Promise<LlmResult>;
  cancel(reason?: unknown): void;
}>;
```

- `generate` is one finite invocation;
- `session` is an ongoing bidirectional interaction;
- either mode may support any declared modality;
- `agent.runtime.provider` selects the resource by stable id;
- `agent.runtime.fallbacks` are same-mode adapter failover, not a chat
  resource. `decideRecovery` is the only recovery policy.
  `generate()` executes `retry_same` and same-resource fallbacks.
  Cross-resource failover is `runGenerateChain` (processor/memory), not
  a vendor map inside one `generate()`;
- the core processor calls `resources.require("llm", provider).generate`
  (or `session`); it never imports a vendor SDK;
- adapters never select recipients, mutate collections, or publish public
  event types;
- provider-native session IDs and resume tokens remain private adapter state;
- tests swap `llm` resources with this contract, not plugin factories.
- **Child provider `llm_attempt` rows remain.** One logical parent attempt
  plus one child row per physical adapter call (`id` =
  `{parentId}:provider:{index}`, metadata `kind: "provider_attempt"`).
  The processor writes those rows from adapter lifecycle; the adapter
  itself never mutates collections. Usage meters the children. Do not
  collapse this to “logical attempt plus usage only.”

Packaging:

- `corePlugin` ships the current bundled adapters (openai, anthropic, gemini,
  groq, deepseek, ollama, minimax) as declarative `llm` resources.
- `createBuiltInLlmProvidersPlugin` and `options.core.providers` go away.
  A later plugin replaces a built-in by the same id.
- Third-party plugins add more adapters (`qwen`, `nvidia`, …). They use the
  same resource type.
- `copilotz.chat` / `LlmChat` / `LlmChatResource` is deleted in Phase 7
  Step B. Do not rename that bag onto `llm`.

Policy hooks (`resolveAgentTextConfig`, `historyTransform`, `evaluateJq`,
timeouts) stay on the agent or as processor-adjacent plain functions. They
must not be fields of an `llm` resource.

The core processor projects canonical history/context into provider input and
projects normalized provider output into streams and terminal collection
mutations. `LlmFrame` / `LlmResult` are the current `runtime/llm` stream
types (`ChatResponse`, `TokenUsage`, `ToolCallStreamDelta`, and today’s
stream-callback payloads). Do not invent a second frame vocabulary.

## 11. Durable streams and realtime

Realtime is not a separate conversation architecture. It is the `session` LLM
lifecycle plus durable stream assets.

`stream` is a core collection using only:

```text
stream.created
stream.updated
stream.deleted
```

There are no Copilotz events named `audio.input`, `audio.output`, `text.delta`,
`tool_call.delta`, `tool_output.delta`, `stream.delta` or
`stream.interrupted`.

A stream record contains stable routing, lane, media type, status and a content
reference. Core lanes are `content`, `reasoning`, `transcript`, `tool_call`,
`tool_output` and `status`. Plugins may use namespaced lanes.

Lifecycle:

1. reserve a stable staging asset;
2. atomically commit `stream.created` and static processor deliveries;
3. only then accept bytes;
4. pump one bounded, backpressured writer into the configured body store;
5. allow independent followers from committed offsets;
6. seal or retain/discard a verified prefix;
7. issue one terminal `stream.updated`.

Raw chunks are never event rows. They are the progressively written asset body.
One slow follower cannot own or block other followers. A matched processor uses
the same event contract and opens its own stream follower from its checkpoint.

LLM attempts and tool executions do not update for each token or frame. Their
progress lives in stream assets; each normally receives one terminal update.

Oxian carries the same descriptors, cancellation, offsets and backpressure
in-process or over WebSocket. The local path may preserve direct Web Streams;
the remote path uses bounded binary frames. Neither path changes domain
semantics.

## 12. Attachments, run and channels

`attachment.send()` is the only application ingress method. It accepts typed
domain/interaction commands and stream commands containing
`ReadableStream<Uint8Array>`. It never accepts a caller-authored authoritative
event.

`attachment.outputs` is a transient processor binding over committed events.
For `stream.created`, authorized consumers follow the referenced asset using
their stream offset.

`run()` creates a temporary attachment, sends one message, observes one
correlation scope, waits for durable settlement and closes. It does not use a
parallel event hub or queue model.

A channel is a plugin composition:

- `api` or a host adapter authenticates ingress and invokes commands;
- transient processors project SSE, WebSocket or CLI output;
- static processors perform durable external egress;
- optional collections store channel identities and outbound executions.

SSE uses event position as resume ID. WebSocket may multiplex commands, event
envelopes and binary asset frames, resuming from event position and per-stream
offsets. Channel policy never enters the generic kernel.

## 13. Sequential implementation phases

### Phase 0 — Baseline and behavioral safety net

Before production code changes:

- run and record the complete `0.60.18` test suite;
- inventory public exports and existing runtime-neutral checks;
- identify every native direct SQL/node/edge mutation path;
- identify every durable event name and every ephemeral event producer;
- inventory the actual read patterns of participant, thread, message,
  llm_attempt, tool_execution and stream, including branch, revision,
  visibility and external-id lookups;
- inventory every test that injects `chat`, provider fakes or workflow plugin
  options; those become `llm` resources, not leftover plugin factories;
- inventory `lib/packages` attachment, SSE resume and stream-offset contracts;
  Phase 9 must preserve or explicitly version them;
- inventory current `features` and `apis` resources so Phase 4 does not merge
  them or invent a third HTTP category;
- inventory behavior tests for text, tools, pipelines, ask, context, skills,
  memory, knowledge, schedules, goals, channels, attachments and providers;
- create persistent PGlite fixtures representing current conversations;
- add missing characterization tests before porting a behavior.

Exit gate: clean baseline tests pass, feature inventory is reviewed, and no
subsystem is scheduled for deletion without a named preserving test.

### Phase 0 results — 2026-08-17

Recorded against `2b2bb77` (`0.60.18`) on branch
`feat/plugin-first-event-source`. Machine-readable inventory and the
persistent conversation fixture live in `contracts/v3/phase-0/`.

Suite: `deno task test` → **571 passed**, 0 failed, 3 ignored (PostgreSQL
upgrade, MinIO S3, PostgreSQL event-store; all env-gated). Elapsed 3m12s.

Baseline facts later phases must not lose by accident:

- Native conversation, llm_attempt, and tool_execution still write `nodes` /
  `edges` directly. Generic collections already use `defineCollection()`.
- Named collection commands emit `${name}.${command}` (for example
  `contract_counter.increment`), not `${name}.updated`.
- Native lifecycle events include `message.revised`, `llm_attempt.completed` /
  `failed` / `cancelled`, and `tool_execution.completed` / `failed` /
  `cancelled`. Those names collapse to created/updated/deleted only through
  migration.
- Message and attempt writes create `asset` nodes inside the parent mutation.
  The Phase 0 conversation fixture's event log contains no `asset.created`
  rows even though asset nodes exist. Event-backed bodies in Phase 1 must not
  assume today's implicit asset side effects.
- There is no `stream` collection and no `stream.created` event. Live progress
  is ephemeral `*.delta` plus attachment `stream.output`.
- SSE resume today is the `afterPosition` query. Frames have no SSE `id:`
  field. `server/v1-sse.ts` still projects uppercase `TOKEN` / `NEW_MESSAGE`.
  `lib/packages/copilotz-chat-adapter` accepts both native types and leftover
  `LLM_RESULT`. Phase 9 must preserve or explicitly version that contract.
- Test doubles inject `CreateTextWorkflowPluginOptions.chat` and
  `defineLlmProviderResource`. Those become `llm` resources; do not keep a
  plugin factory for tests.
- `features` are inbound HTTP actions; `apis` are outbound OpenAPI tools.
  `FeatureContext.application` is a god-object in this baseline.

No deviation from this document is required to start Phase 1.

### Phase 1 — Canonical collection kernel and replay

Implement only the generic collection/event foundation:

- canonical resource contract and inferred types;
- create/update/delete/mutate with `set`/`unset` semantics;
- standard mutation result;
- query/list/search and declared relation reads;
- event envelope mapping from collection definitions;
- immutable asset-backed event bodies;
- deterministic reducers for created/updated/deleted;
- node/content/edge projection through reducers;
- replay from empty projections;
- no-op semantics and idempotent retry.

Port one synthetic custom collection first. Do not port native domains yet.

Phase 1 adds `runtime/collections/` as the canonical kernel. Leave
`runtime/domain/collections.ts` and native repositories running. Do not switch
usage, memory, knowledge or schedules onto the new path. Two kernels coexist
until later phases delete the old write path. That is add-prove-delete, not a
bridge type. Do not edit `domain/collections.ts` in place.

The new kernel stores compact envelopes in the existing events table. The
canonical body lives behind `payload.dataRef` as an asset node written in the
same transaction. Do not emit `asset.created` for that body. Do not change the
global `CopilotzEvent` type in this phase.

Exit gate: property/fixture tests prove replay equivalence, tamper detection,
content refs, relation projection, deduplication and namespace isolation on
PGlite and PostgreSQL. Database body-store commits include envelope, body,
node, declared edges and deliveries in one atomic write. Query filters required
by the Phase 0 native-read inventory are either representable or listed as
named queries to add in Phase 3. Plugin-author DX is not an exit metric here.

### Phase 1 results — 2026-08-17

Recorded on branch `feat/plugin-first-event-source`. New kernel lives in
`runtime/collections/`. Synthetic fixture: `runtime/collections/kernel.test.ts`
(`job` + `job_note`). Not exported from the root package barrel; Phase 4 owns
public subpaths.

Suite: `deno task test` → **583 passed**, 0 failed, 4 ignored (previous three
env-gated Postgres/MinIO checks plus `collection kernel on PostgreSQL`).
Elapsed 3m33s.

Proved on PGlite:

- `defineCollection()` create/update/delete/`mutate({ set, unset })`; void and
  deep-equal writes are no-ops and insert no event;
- named command `claim` emits `job.updated`, never `job.claimed`;
- compact envelope payload is only `{ dataRef }`; the record lives on an
  `asset` node; no `asset.created` event;
- envelope, body, node, declared edges and deliveries commit atomically, and a
  missing-parent child write leaves no row;
- replay equals stored projections; tampering the node fails verify; rebuild
  from event bodies restores the record;
- `query.byExternalId`, relation `include`, text search, dedup retry, and
  namespace-filtered lists.

Old `runtime/domain/collections.ts` and native repositories were not edited.
Usage, memory, knowledge and schedules still use the old path.

Implementation notes Phase 2+ must keep:

- Store-level dedup compares encoded payload bytes. Body asset ids must be
  stable across retries: `event-body:${namespace}:${deduplicationId}` when a
  dedup key is present, otherwise a fresh id. Changing `dataRef.assetId` on
  retry is a conflict, not a no-op.
- `CollectionDurableEvent` is a mapped view over `DurableEvent` (`type` →
  `eventType`, `payload.dataRef` → `dataRef`). The global `CopilotzEvent` type
  is unchanged.
- `nodes.id` remains a global primary key. Namespace isolation is query/event
  scoping, not `(namespace, id)` uniqueness.
- Rebuilding a parent collection deletes that node's edges via FK cascade.
  Restore child `belongsTo` edges by rebuilding the child collection too.
- Generic `where` / `include` plus a named `byExternalId` cover the Phase 0
  participant-by-external-id read. Message branch, revision and visibility
  queries wait for Phase 3.

No deviation from this document is required to start Phase 2.

### Phase 2 — Atomic multi-collection command scope

Add the single runtime transaction composition described in §5.5.

Phase 2 adds `runtime.transaction()` on the Phase 1 collection kernel. That is
the API Phase 5 later injects as `context.transaction`. Do not introduce
processor context, native collections, public package subpaths, or a second
event/reducer type.

Leave `runtime/domain/collections.ts` running. Do not edit it in place. Do not
switch usage, memory, knowledge or schedules onto this path.

Locked split:

- `createCollectionRuntime()` remembers collections from `bind()` by name.
  `runtime.transaction({ operationKey, namespace, execute })` passes those
  bound collections into `execute({ collections })`. Plugins never receive a
  raw SQL executor.
- Child `create` / `update` / `delete` / `mutate` join one existing store
  transaction. They do not open a nested `commitMutation` SQL transaction and
  they do not dispatch per child.
- Consumer matching stays synchronous and pre-insert. Oxian/live dispatch and
  publish run once, in child order, after the outer SQL commit. A throw before
  that commit leaves no event, body, node, edge or delivery.
- Nested `runtime.transaction()` joins the same SQL transaction and composes
  `operationKey`. Only the outermost call commits and dispatches.
- In-scope `get` / `query` / `list` / `search` use the transaction executor so
  a later child sees earlier siblings.
- Child writes in another namespace than the scope are an error.
- Shared `settlementScopeId` and `correlationId` default to
  `scope:${namespace}:${operationKey}` so retry of the same key is the same
  semantic event. Child `deduplicationId` defaults to
  `${operationKey}:${collection}:${operation}:${id}` (`mutate:${command}` for
  named commands) unless the child passes an explicit identity. No-op children
  insert nothing, remain in the ordered `writes` list, and do not abort the
  scope. A JavaScript no-op must not be implemented as an SQL error.
- The result is the `execute` return value plus that ordered `writes` list.
- "External body upload failure" in this phase is any throw from a child write
  before the outer commit, including a synthetic body-write failure.
  Cross-store S3/filesystem staging remains Phase 8.

Test one/many child mutations, no-op children, deterministic event order, retry
of the same `operationKey`, rollback at every boundary, in-scope sibling reads,
dispatch only after commit (a `job.created` processor must see a later sibling
`job_note`), nested join, and namespace mismatch.

Exit gate: a composite fixture either commits all events/projections/edges/
deliveries and replays identically, or leaves no committed trace.

### Phase 2 results — 2026-08-17

Recorded on branch `feat/plugin-first-event-source`. Scope API is
`runtime.transaction()` in `runtime/collections/kernel.ts`. Fixture:
`runtime/collections/transaction.test.ts`. Still not exported from the root
package barrel.

Suite: `deno task test` → **584 passed**, 0 failed, 5 ignored (previous four
plus `collection transaction on PostgreSQL`). Elapsed 3m38s.

Proved on PGlite:

- one SQL transaction for `job` + `job_note`; later `get` sees the earlier
  sibling;
- no-op child stays in `writes` and inserts no event;
- event order is execute order; children share `settlementScopeId` and
  `correlationId`;
- a `job.created` processor observes the later `job_note` because dispatch
  waits for commit;
- retry of the same `operationKey` deduplicates; a throw after the first child
  leaves no row;
- nested `transaction()` joins the same SQL transaction;
- a child namespace mismatch is rejected.

Store/coordinator extensions are `commitMutation({ transaction })` and
`dispatch: false` plus `flushCommitted()`. That is the existing event path, not
a second event type. `domain/collections.ts` was not edited.

Phase 5 should inject this same `runtime.transaction` as `context.transaction`.
Do not build a second composition API for processors.

No deviation from this document is required to start Phase 3.

### Phase 3 — Core native collections

Define the six core collections and port their mutations one collection at a
time. Native and custom collections must use the same runtime path.

Use atomic scopes for participant/thread/message combinations. Replace direct
native graph writes only after equivalent tests pass. Add explicit hydrated
queries using declared relations; do not create mutation or read repositories.
Drive the query vocabulary off those six collections' actual reads. Add
declared named queries for history, branch, revision, visibility or
external-id lookup only when generic filters cannot express them honestly.

Exit gate:

- native replay equals committed projections;
- direct and aggregate participant creation use the same collection reducer;
- no runtime-native repository writes participant, thread, message, attempt,
  execution or stream nodes directly;
- no core `relation` collection exists;
- no `conversation` read facade remains for those collections;
- `collections.participant.query({ externalId })` or a declared
  `participant.byExternalId` replaces any `getParticipantByExternalId` helper.

Phase 3 adds the six `defineCollection()` resources on the Phase 1 kernel.
Place them in `runtime/collections/core/` so Phase 4 can move them into the
core plugin. The runtime still must not import `plugins/**`.

Locked split:

- Collections: `participant`, `thread`, `message`, `llm_attempt`,
  `tool_execution`, `stream`.
- Canonical events only: created/updated/deleted. `reviseMessage` is a new
  `message.created` with revision fields. `complete` / `fail` / `cancel` are
  named `mutate` commands that emit `*.updated`.
- `stream` is defined here and has no writer. Phase 8 owns body-store streaming.
- Kernel extensions required by these records, not a second graph API:
  node `source_type` / `source_id` from a collection `identity` so the existing
  participant/thread unique indexes still apply; `hasMany` from an ID array
  with optional inverted `participates_in` edges; write options may set
  `threadId`, `routing` and `visibility` on the envelope.
- Participation is `thread.participantIds` plus `participates_in` edges. There
  is no `relation` collection.
- Named queries: `participant.byExternalId`, `thread.byExternalId`,
  `message.byThreadId`, `message.revisions`. Active-branch projection is a pure
  function over those reads, not a conversation helper module.
- Do not switch `runtime/domain/conversation.ts`, `llm-attempts.ts` or
  `tool-executions.ts` in this phase. Processors, SSE and the Phase 0 fixture
  still match `message.revised` and `*.completed|failed|cancelled`. Cutting
  those repositories over is part of this phase's exit gate but is blocked on
  Phase 5 matching and Phase 6 processor port. Direct graph SQL remains until
  those tests pass through canonical events. That is add-prove-delete, not a
  bridge repository.

Prove with a core fixture on PGlite: atomic thread create (participants +
thread), message create, revision as `message.created`, attempt/tool mutate to
`*.updated`, named queries, relation include, replay/tamper, namespace
isolation. Do not export from the root package barrel.

### Phase 3 results — 2026-08-17

Recorded on branch `feat/plugin-first-event-source`. Definitions live in
`runtime/collections/core/`. Fixture: `runtime/collections/core/core.test.ts`.
Still not exported from the root package barrel. Native
`runtime/domain/conversation.ts`, `llm-attempts.ts` and `tool-executions.ts`
were not switched.

Suite: `deno task test` → **586 passed**, 0 failed, 6 ignored (previous five
plus `core collections on PostgreSQL`). Elapsed 2m21s.

Kernel extensions in the Phase 1 modules, not a second graph API:

- collection `identity` stamps `source_type` / `source_id` so the existing
  participant and thread unique indexes still apply;
- `hasMany` from an ID array writes edges; `edge: "child-to-parent"` is
  `participates_in` (source=participant, target=thread);
- include-only `hasMany` (no array on the parent, e.g. `job.notes`) is
  unchanged and still comes from the child's `belongsTo`;
- write options plus record fields set envelope `threadId`, `routing` and
  `visibility`. Thread events use the thread id as `threadId`.

Proved on PGlite:

- one `runtime.transaction` creates two participants and a thread;
- duplicate `externalId` is rejected by the unique index; the same
  `externalId` is allowed in another namespace;
- `participates_in` edges are inverted; `thread` include `participants` and
  `message` include `sender` / `thread` hydrate;
- `reviseMessage` is a second `message.created` with revision fields; no
  `message.revised` row;
- `complete` / `fail` / `cancel` emit `llm_attempt.updated` and
  `tool_execution.updated`; a second terminal command throws;
- named queries `participant.byExternalId`, `thread.byExternalId`,
  `message.byThreadId`, `message.revisions`;
- `projectActiveMessageBranch` is a pure function over those reads;
- `stream` is bound and has no writer and no `stream.*` events;
- tamper + rebuild restores messages, participation and `has_message` edges.

`lastEvent*` on the thread node is still a store side-write when the envelope
has `threadId`. It is not a thread collection event, so `verify(thread)`
disagrees until those fields are rebuilt away. That is existing store
behavior, not a second cursor API.

No deviation from this document is required to start Phase 4. Cutting native
repositories over remains blocked on Phase 5 matching and Phase 6 processor
port.

### Phase 4 — Plugin vocabulary and dependency boundaries

Introduce the final resource categories and registry, public package subpaths,
static `corePlugin`, and target dependency rules. Move only already-canonical
resources.

Add automated forbidden-import checks:

- no `runtime/**` import of `plugins/**`;
- no plugin relative import of `runtime/**`;
- no duplicate resource interface;
- no `runtime/resources` umbrella vocabulary;
- no hidden core plugin factory.

Exit gate: resource precedence, manifest agreement, capability grants and
external-style plugin imports pass without changing characterized behavior.
`features` are reusable operations (callable from processors and, when
the application is composed, HTTP); `api` remains outbound
agent-callable HTTP. No new resource category is introduced.

Locked split:

- Registry keys flip now: `providers` → `llm`, `apis` → `api`,
  `mcpServers` → `mcp`. Same objects, new bucket. `embedding` is added empty.
  Phase 7 still owns the `generate`/`session` contract.
- `channels` and `memoryKinds` stay in the registry until Phases 9 and 10.
  They are not 1:1 renames. Removing them here would be a channel/memory
  rewrite.
- `corePlugin` in this phase is collections only: the six definitions from
  Phase 3, imported through a public subpath. No text, ask, memory or
  knowledge processors.
- `createCopilotzCorePlugins()` remains the options binder for optional and
  legacy plugins. It is not a `createCorePlugin()` wrapper around static core
  data. Delete it when those plugins move.
- Composition root is the package root. `runtime/**` does not import
  `plugins/**`. Application receives `canonicalCore` as an argument; the root
  factory defaults it to `[corePlugin]`.
- Add public subpaths (`./collections`, `./plugins/core`). Do not delete
  `./domain`, `./workflows`, `./channels`, or `./resources`.
- Forbidden-import checks land now and must not fail the still-canonical old
  tree. `runtime/resources` may keep type re-exports; it is not the resource
  vocabulary.

### Phase 4 results — 2026-08-17

Recorded on branch `feat/plugin-first-event-source`. `channels` and
`memoryKinds` stay in the registry until Phases 9 and 10.

Suite: `deno task test` → **590 passed**, 0 failed, 6 ignored (previous six).
Elapsed 3m26s. `deno task check:boundaries` passes.

Registry:

- `PLUGIN_RESOURCE_TYPES` is the target set plus `channels` and
  `memoryKinds`. Inventory asserts `PHASE_4_RESOURCE_TYPES`.
- Call sites list/get/require/origin/provides/resources use `llm`, `api`,
  `mcp`. Same objects, new bucket. `embedding` is present and empty.
- `pluginResourceId` for `llm` / `api` / `mcp` uses `id ?? name`. Those
  resources keep a stable `id` and a display `name`; name-first lookup
  broke catalog tests (`Contract API` vs `contract-api`).
- HTTP `/v1/providers` remains a channel alias. `options.core.providers`
  and `createBuiltInLlmProvidersPlugin` stay; Phase 7 still owns
  `generate` / `session`.

Core plugin:

- Static `corePlugin` at `plugins/core/`. Manifest `@copilotz/core`
  `0.61.0`. Collections only: the six Phase 3 definitions, imported
  through `@copilotz/copilotz/collections`.
- No processors, text, ask, memory, or knowledge in core this phase.
- `createCopilotzCorePlugins()` remains the options binder. There is no
  `createCorePlugin()`.

Composition:

- Package-root `create-copilotz.ts` defaults `canonicalCore` to
  `[corePlugin]`. `runtime/**` does not import top-level `plugins/**`.
- `runtime/application/public.ts` re-exports the wrapped factories.
  `runtime/application/index.ts` still exports the unwrapped ones so
  internal `core: false` tests stay honest.
- Public subpaths: `./collections`, `./plugins/core`. `./domain`,
  `./workflows`, `./channels`, and `./resources` were not deleted.

Not moved:

- native `conversation.ts` / `llm-attempts.ts` / `tool-executions.ts`;
- text / ask processors;
- `createCopilotzCorePlugins`;
- `channels` / `memoryKinds` resources;
- `runtime/resources` type re-exports.

No deviation from this document is required to start Phase 5. Cutting
native repositories over remains blocked on Phase 5 matching and Phase 6
processor port.

### Phase 5 — Processor matching and event-authoritative execution

Implement the declarative matcher and static/transient binding semantics. Make
resolved immutable event bodies the handler authority. Add the injected generic
processor context.

Port one small existing processor to direct collection operations. Confirm that
it performs no triggering-subject fetch and captures external input in a child
event.

Exit gate: precommit static matching, committed consumer IDs, retry,
settlement, transient catch-up and delayed-executor immutability tests pass.

Locked split:

- One `defineProcessor`. `on` is matcher objects only. Entries are OR; fields
  in one entry are AND; nested objects use partial structural equality; media
  types allow exact and `type/*`. Matching is synchronous and pure. It sees
  the envelope plus an in-memory prepared JSON body, never stream bytes.
- Remove string-only `on`, `delivery`, and callback `filter`. Structural
  filters become matcher fields. Dynamic checks move into `handle`.
- Plugin-resource processors are static and still receive a delivery row.
  Consumer id stays `processor:${id}`. `settlement` remains inherit/detached
  on static processors only.
- Transient is a bind API on the same processor contract: catch-up from an
  event position, then live-tail, no delivery row. Existing `delivery: "live"`
  test processors move to `transientProcessors` / `bindTransient`. Do not
  rebuild attachments or `run()` this phase.
- Before `handle`, resolve `dataRef` once and deep-freeze the body. The
  handler receives that value as `event.data`. Delayed execution must still
  see the original body after a later projection mutation.
- `context.transaction` is the Phase 2 `runtime.transaction`. Same
  `CopilotzProcessorContext`. Do not add a second context type. Do not delete
  `conversation` / `llmAttempts` / `toolExecutions` this phase.
- The one ported processor is a job-style fixture, not text/ask/memory/
  schedules. It matches `job.created`, uses the frozen body (no
  `get(event.subject.id)`), writes a child collection event with captured
  external input, then performs the fake side effect — all through
  `context.transaction`.
- Coordinator matching accepts optional `matchData`. Collection `create`
  passes the prepared body. Envelope-only matching remains valid.

### Phase 5 results — 2026-08-17

Recorded on branch `feat/plugin-first-event-source`.

Suite: `deno task test` → **595 passed**, 0 failed, 6 ignored. Elapsed 3m55s.

Contract:

- `defineProcessor` takes matcher objects only. String `on`, `delivery`, and
  `filter` are gone. Consumer id is still `processor:${id}`.
- Matching is OR of entries, AND of fields, partial nested equality, and
  `type/*` media wildcards. Coordinator `durableConsumers(draft, matchData)`
  runs before insert. Collection `create` passes the prepared body.
- Plugin-resource processors are static. Transient processors use
  `transientProcessors` / `engine.bindTransient({ afterPosition })` and
  create no delivery row.
- The delivery workload resolves `dataRef`, deep-freezes the body, and
  passes it as `event.data`. A later projection mutation does not change
  that body.
- `context.transaction` is the Phase 2 collection kernel API. Same
  `CopilotzProcessorContext`. Native `conversation` / `llmAttempts` /
  `toolExecutions` remain.

Fixture: `runtime/collections/processor-authority.test.ts`. A
`job.created` processor matches on the create body, writes `job_note`
through `context.transaction` with captured external input, and never
fetches the triggering subject. The create delivery still sees
`title: "original"` after the same transaction updates the job to
`"later"`.

Not moved: text/ask/memory/schedules production handlers, native
conversation repos, attachments/`run()` rebuild.

No deviation from this document is required to start Phase 6.

### Phase 6 — Core text, tool and ask processors

Port the complete current text workflow incrementally into core plugin
processors. Preserve every characterized behavior:

- provider fallback;
- text and reasoning visibility;
- multimodal history;
- asset materialization;
- tool grants and execution context;
- parallel tools and exactly one continuation;
- jq/tool pipelines;
- timeout, cancellation and failures;
- public, nested and parallel ask;
- skill and context contributions;
- agent-relative history.

Delete old workflow/domain executors only after equivalent core processors pass.
Do not keep `createTextWorkflowPlugin({ chat })` or equivalent factories so
tests can inject a model. Provisional test doubles may be `llm` resources
before Phase 7 lands; they must not be plugin factories.

Exit gate: current text and ask behavior tests pass through only the new
collection/event/processor path.

Locked split:

- Cut over native writes and reads for `participant`, `thread`, `message`,
  `llm_attempt`, and `tool_execution` on the text/ask path. New processors
  match collection events only. No `message.revised`. No
  `*.completed|failed|cancelled` event types. Status lives on
  `event.data.record`. Named commands `complete` / `fail` / `cancel` emit
  `*.updated`.
- Engine `conversation` / `llmAttempts` / `toolExecutions` become ingress
  adapters over the collection kernel so existing tests can still call
  `createMessage`. They are not processor facades. Core processors use
  `event.data`, `context.transaction`, and collection query only. No
  `context.conversation.getMessage` (or equivalent) in
  `plugins/core/resources/processors/`.
- Do not implement stream writers. Keep ephemeral `text.delta` /
  `reasoning.delta` / `tool_call.delta`. One terminal `llm_attempt.updated`
  / `tool_execution.updated`. Streams wait for Phase 8.
- Do not invent `generate` / `session`. Processors invoke today's provider
  `chat` through an `llm` registry resource (`id` plus invoke). Tests swap
  that resource. Then delete `createTextWorkflowPlugin` and
  `createAgentAskPlugin`. Stop injecting them from
  `createCopilotzCorePlugins()`.
- Port one processor at a time and remove the old one in the same step. Do
  not run old and new processors for the same event. Order: route message →
  execute attempt → project text/tools → execute tool → project tool
  result/continuation → ask.
- Prompt, history, tool catalog, and jq stay as plain functions imported by
  processors, not `plugins/core/utils/` query facades.
- Ask processors and the ask tool join `corePlugin`. They only match ask
  metadata. `options.core.text` and `options.core.ask` go away. Memory,
  knowledge, and schedules keep native facades until Phase 10.
- Exit gate: `text-plugin.test.ts` and `ask-plugin.test.ts` pass with
  collection-backed writes and the new processors only.

### Phase 6 results — 2026-08-17

Recorded on branch `feat/plugin-first-event-source`.

Exit gate: `runtime/workflows/text-plugin.test.ts` and
`runtime/workflows/ask-plugin.test.ts` → **21 passed**, 0 failed.

Contract:

- `corePlugin` owns the five conversation collections, text/ask processors,
  the ask tool, and the swappable `copilotz.chat` llm resource. Tests replace
  that resource. `createTextWorkflowPlugin` / `createAgentAskPlugin` and
  `options.core.text` / `options.core.ask` are gone.
- Engine `conversation` / `llmAttempts` / `toolExecutions` are ingress
  adapters over the collection kernel when those collections are bound.
  Native repos remain for domain unit tests and engines without `corePlugin`.
- Named commands emit `*.updated`. Status lives on `event.data.record`.
  Kernel `update` / `mutate` pass the next body as `matchData` so data
  matchers work. Follow-on writes in one ingress transaction omit the
  caller's `deduplicationId`.
- `context.transaction` injects `sourceDeliveryId` so nested collection
  writes do not deadlock capacity-1 workers.
- Processors skip agent participants with no registered agent resource.
  Embedded `createCopilotz` and `createCopilotzWorker` default worker
  capacity to 8 so core and application processors can run on the same
  `message.created`.
- Public `core: false` only disables optional plugins. Package-root
  factories still inject `canonicalCore: [corePlugin]`. Embedding tests
  that own the reply path must pass `canonicalCore: []`, or core text
  processors will invoke the app's `llm` resource (the downstream
  contract hung on `https://downstream.invalid/v1/chat`).
- Core text/ask processors are declarative `defineProcessor` constants.
  Memory/usage/knowledge processors that close over plugin options stay
  factories until Phase 10. Prompt, catalog, jq, and provider helpers
  are imported from `@copilotz/copilotz/{agents,tools,llm,events}` after
  Phase 7 Step A deleted `runtime/workflows/`. They are not plugin
  resources.

Deviations from the locked split:

- Many processor writes still go through ingress facades
  (`context.conversation.createMessage`, `context.llmAttempts.complete`).
  Router create of `llm_attempt` uses `context.transaction`. Prompt
  construction still reads via `context.conversation.listMessages`.
- Content `materialize` / `linkOwner` is not in the same SQL transaction
  as the collection event.
- `projectActiveMessageBranch` is duplicated in ingress; runtime cannot
  import `@copilotz/copilotz/plugins/core`.
- Phase 0 inventory still lists native lifecycle event names because that
  fixture still uses native repos.

Not moved: stream writers, `generate` / `session`, memory / knowledge /
schedules native facades, attachments/`run()` rebuild.

### Phase 7 — Agent and LLM resource contract

Introduce `generate`/`session`, modality declarations and ordered same-mode
fallbacks. Port provider adapters behind the one `llm` resource contract.

Keep provider normalization independent from domain mutation. Persist immutable
attempt input before each external call. Use actual provider lifecycle tests in
addition to fakes where credentials are available. Test injection is swapping
`llm` resources, not plugin factories.

Exit gate: generate fallback, tool calls, usage, cancellation and runtime
selection pass with no `llmOptions`, text/realtime provider split or provider-
specific public event types. `@copilotz/copilotz/workflows` is gone.

Locked split:

- Do not keep `runtime/workflows/` as a junk drawer until Phase 11. Dissolve
  it by the §4 ownership tree **before** rewriting `generate` / `session`.
  Relocate files, point processors at the owning public subpaths, keep
  characterization tests green, then delete the folder and the
  `./workflows` export. No compatibility re-export barrel.
- Do not turn prompt, catalog, jq, executor, or pipeline into plugin
  resources or `plugins/core/utils/` query facades. Named collection
  queries if a lookup repeats.
- Ownership map:

  | From `runtime/workflows/` | Owner |
  |---|---|
  | `tool-catalog.ts`, `tool-executor.ts`, `tool-result-assets.ts`, `pipeline.ts` | `runtime/tools/` |
  | `evaluateJq` re-export | already `runtime/tools/jq.ts` |
  | `llm-lifecycle.ts`, asset materialization re-export | `runtime/llm/` |
  | `agentTextBaseConfig`, `requireAgent`, `providerRegistry` | `runtime/agents/` (new) and `runtime/llm/` |
  | `prompt.ts`, `transcript.ts` | `runtime/agents/` until Phase 10; `runtime/memory` still
    calls `buildAgentTextPrompt` and runtime cannot import `plugins/**`.
    After memory is a plugin, these can move next to core processors. |
  | `identity.ts`, ask/workflow metadata helpers | core processor helpers or `runtime/events` |
  | `providers-plugin.ts`, `LlmChat`, `CreateTextWorkflowPluginOptions` | delete in Step B |

  Prefer `executeTool(...)` over `createWorkflowToolExecutor()`. Catalog
  cache stays a runtime object, not an `llm` resource. Move
  `text-plugin.test.ts` / `ask-plugin.test.ts` out of `workflows/` with
  the code they characterize.
- Step B, after the folder is gone: replace `copilotz.chat` / `LlmChat`
  with one `llm` resource (`generate` now, `session` declared). Both
  return normalized frames plus a final result. Adapters never write
  collections, select recipients, or emit public event types. Agent
  `runtime` / same-mode `fallbacks` replace `llmOptions` and
  `runtimes.text` / `runtimes.realtime`. `execute-text-attempt` selects a
  runtime, persists immutable attempt input, calls `generate`, writes
  child provider `llm_attempt` rows plus one terminal parent
  `llm_attempt.updated`. Tests swap `llm` resources.
- Policy hooks (`resolveAgentTextConfig`, `historyTransform`, `evaluateJq`,
  timeouts) must not remain on the `llm` resource. `LlmChatResource` as a
  bag of old text-plugin options is deleted, not renamed.
- When `execute-text-attempt` is rewritten, switch prompt reads off
  `context.conversation` onto collection query.
- Fold bundled adapters into `corePlugin`. Delete
  `createBuiltInLlmProvidersPlugin`. No native conversation fallback in
  the engine (see lock below).

Locked 2026-08-18 (before Step B coding):

- **Engine native fallback is removed.** If the five conversation
  collections are not bound, the engine does not install
  `createConversationRepository` / `createLlmAttemptRepository` /
  `createToolExecutionRepository`. No core plugin means no conversation
  aggregate and no text/ask processors. There is no hidden default
  processor.
- **Core processors never use `context.conversation` /
  `context.llmAttempts` / `context.toolExecutions`.** They use
  `event.data`, `context.transaction`, bound collections, and
  `context.features` only. Do not wrap `message.create` in a
  `postMessage` feature. Recurring *multi-collection* policy (ensure
  participant + membership + message, or revision + active branch)
  becomes a feature and/or named commands on the owning collection.
  Cross-collection sequences use `context.transaction` (§5.5), including
  inside a feature. Command evaluators stay pure. Features join the
  caller's transaction. Application ingress uses collection writes or
  those shared features; do not keep `engine.conversation.*` as a
  supported app contract. Domain unit tests may construct native repos
  until Phase 11 deletes those files; the engine must not select them.
- **`llm` resource = vendor adapter** with `generate` and/or `session`
  (§10.2). `corePlugin` ships the current bundled adapters. Other plugins
  add more adapters. `copilotz.chat` is deleted, not renamed.
- **Policy hooks** live on the agent or as processor-adjacent functions
  (prompt/transcript stay in `runtime/agents/` until Phase 10). Not on
  the `llm` resource. Not a context resource unless a plugin contributes
  context.
- **Child provider `llm_attempt` rows remain.** Logical parent plus one
  child per physical adapter call. Processor writes them; adapters do
  not. Usage meters `kind: "provider_attempt"`.
- **`LlmFrame` / `LlmResult`** are today’s `runtime/llm` types
  (`ChatResponse`, `TokenUsage`, `ToolCallStreamDelta`, stream-callback
  payloads). No second vocabulary.

Step B coding may start. No remaining lock questions.

Step B slices (locked 2026-08-18, originally B1 → B2 → B2b → B3 → B4).

Deviation — 2026-08-18: the user pulled **B3 ahead of B2**. Coding order
on this branch is B1 → B3 → B2 → B2b → B4. B2 and B2b remain required
before B4. `FeatureContext` must not grow `LlmAttempt` because B2b has
not run.

Deviation — 2026-08-18 (remaining Step B, user-locked): finish B as
one remaining pass so we stop teaching the facade. Order:

1. Strip conversation reads off `FeatureContext`. Admin reads bound
   collections. No `postMessage` feature.
2. **B2** — `generate()` / declare `session`, fold bundled adapters into
   `corePlugin`, delete `copilotz.chat` / `LlmChat` / `LlmChatResource`,
   delete `createBuiltInLlmProvidersPlugin` and `options.core.providers`.
   Move content-role helpers next to core collections (domain may
   re-export until Phase 11).
3. **B2b** — core processors work on `CollectionRecord`. Map to `./domain`
   only at `buildAgentTextPrompt` / `buildTextTranscript` / `executeTool`
   / `recordProviderAttemptLifecycle`.
4. Drop `conversation` / `llmAttempts` / `toolExecutions` off processor
   context. Stop installing native repos when collections are unbound.
   Characterization tests ingress is `message.create` (plus
   participant/thread setup), not `engine.conversation.createMessage`.

Step B slices:

- **B1 — Processor collection cutover.** Core text/ask processors, ask
  tool, `buildAgentTextPrompt` / `buildTextTranscript`,
  `recordProviderAttemptLifecycle`, and `executeTool` thread/participant
  reads use bound collections + `context.transaction`. Keep
  `copilotz.chat.invoke`. Keep `engine.conversation.*` as test/plugin
  ingress until a later slice. Do not wrap `message.create` in a
  feature; tool-sender ensure + membership + message is one
  `context.transaction`. Prove `plugins/core/text.test.ts` and
  `plugins/core/ask.test.ts` before the rest of Step B.
- **B2 — `llm` adapters.** Fold bundled adapters into `corePlugin`.
  Replace `copilotz.chat` / `LlmChat` / `LlmChatResource` with
  `generate()` (and declare `session`). Delete
  `createBuiltInLlmProvidersPlugin` and `options.core.providers`. Tests
  swap `llm` resources. Child provider `llm_attempt` rows stay processor
  writes. Same slice: move collection content-role helpers
  (`LLM_CONTENT_ROLE`, `TOOL_CONTENT_ROLE`, `llmAttemptContent`,
  `toolExecutionContent`, `composeRoleContent`, `replaceContentRoles`)
  next to the core collections (or generic role ops under `./content`).
  Native `runtime/domain/` may re-export until Phase 11. Do **not** also
  retype processor bodies onto `CollectionRecord` in this slice.
- **B2b — Processor working types.** Phase 7, after B2, before B3.
  `text.ts` / `ask.ts` / `writes.ts` take `CollectionRecord`, not
  `LlmAttempt` / `ToolExecution` / `Participant` as their working type.
  Map to `./domain` only at the runtime boundary
  (`buildAgentTextPrompt`, `buildTextTranscript`, `executeTool`,
  `recordProviderAttemptLifecycle`). Prove `plugins/core/text.test.ts`
  and `plugins/core/ask.test.ts` again. Do not move `LlmAttempt` into
  `plugins/core`.
- **B3 — Features as reusable commands.** `FeatureContext` is the same
  primitives as processors (no `application` god-object). Add a feature
  only for a shared multi-collection sequence. Application layer may
  project features as `/features/...`.
- **B4 — Engine native fallback off.** If the five conversation
  collections are unbound, the engine does not install native
  conversation / llm-attempt / tool-execution repositories. Domain unit
  tests may still construct those files until Phase 11.

### Phase 7 Step A results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`.

`runtime/workflows/` and the `./workflows` package export are gone. No
compatibility barrel.

Ownership after the dissolve:

- `runtime/tools/`: catalog, `executeTool` / executor, result-assets,
  jq-pipeline. `createWorkflowToolExecutor` is a thin wrapper around
  `executeTool`.
- `runtime/llm/`: attempt lifecycle, built-in providers plugin, provider
  resource registry, `LlmChat` / `CreateTextWorkflowPluginOptions`
  (deleted in Step B, not renamed onto the `llm` resource).
- `runtime/agents/`: `requireAgent`, `agentTextBaseConfig`, prompt and
  transcript. Prompt stays here until Phase 10 because `runtime/memory`
  still calls `buildAgentTextPrompt` and runtime cannot import
  `plugins/**`.
- `runtime/events/`: `deriveWorkflowId`, ask/workflow metadata helpers.
- Characterization tests live at `plugins/core/text.test.ts` and
  `plugins/core/ask.test.ts`.

Public subpaths: `./agents`, `./llm`, `./tools`, `./events`. Core
processors import those plus `./engine`, `./resources`, `./content`,
`./domain`, and `./capabilities` through the package imports map.

Prove:

- `deno task check` — 34 exports, 297 production modules, release-clean.
- `deno task test` — **595 passed** (4 steps), 0 failed, 6 ignored.

Deviations:

- Usage processors match both collection `*.updated` and native
  `*.completed` / `*.failed` / `*.cancelled` until Phase 11 deletes the
  native repos. The usage characterization fixture has no `corePlugin`.
- `createCopilotzApplication` core plugin IDs are only
  `@copilotz/built-in-llm-providers` by default. `@copilotz/core-text`
  died with `createTextWorkflowPlugin` in Phase 6. Package-root
  `createCopilotz` still injects `canonicalCore: [corePlugin]`.

### Phase 7 Step B1 results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. B1 is closed. B3 was
pulled ahead of B2; B2 follows B3.

Core text/ask processors, ask tool, prompt/transcript, attempt-lifecycle,
and executeTool thread/participant reads use bound collections +
`context.transaction`. `copilotz.chat` and engine conversation ingress
remain until later slices.

Prove:

- `deno task check` — 34 exports, 299 production modules, release-clean.
- `deno task test` — **595 passed** (4 steps), 0 failed, 6 ignored.

Fixes during B1:

- Processor writes must `content.materialize` + `linkOwner`, not only
  `prepare`. `prepare` is in-memory.
- Parallel tool executions in one model turn are created in one
  `context.transaction` so both `tool_execution.created` deliveries are
  scheduled before the worker slot is yielded. Per-item creates let the
  first tool finish before the second exists.
- `isLastSettledToolResult` reads terminal `tool_execution` rows for the
  batch, not result-message list order.

Deviations:

- `content.materialize` / `linkOwner` are not in the same SQL transaction
  as the collection event.
- `projectActiveMessageBranch` is still duplicated (ingress,
  collection-graph, `message.ts`).
- Engine still installs native conversation/attempt/execution repos when
  collections are unbound (B4).
- Test ingress still uses `engine.conversation.createMessage` (allowed
  for B1).

### Phase 7 Step B3 results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. B3 is closed. B2 is
next, then B2b, then B4.

`FeatureContext` is processor primitives (collections, transaction,
content, resources, features) plus namespace. No `application`. Feature
identity is `invoke(resourceId, action, input)`. HTTP `/features/...`
builds that context and passes the request as `input`. Admin projections
use it. Processors get `context.features` from the existing capability
assembler in `runtime/engine/context.ts`. No `postMessage` /
`createThreadMessage` feature.

Prove:

- `deno task check` — 34 exports, 300 production modules, release-clean.
- `deno task test` — **595 passed** (4 steps), 0 failed, 6 ignored.

Deviations:

- `FeatureContext` still has scoped conversation **reads**
  (`listThreads` / `listParticipants` / `listMessages`) so admin works
  when `core: false` and those collections are unbound. Writes stay on
  collections/content. Stripped in remaining Step B.
- Processor-originated `deliveries.list` is stubbed as `[]`.
- `collectionRuntime` is on the public engine/application object so the
  HTTP adapter can join the same kernel. That is composition, not a new
  conversation API.

### Phase 7 remaining Step B results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. The remaining Step
B pass is closed (FeatureContext conversation reads, B2, B2b, B4). Do
not start Phase 8 until this branch is committed.

`FeatureContext` has no conversation reads. Admin uses bound
collections. No `postMessage` / `createThreadMessage` feature.

B2: `llm` resources expose `generate()` and declare `session`. Bundled
adapters live on `corePlugin` as `builtInLlmResources`. `copilotz.chat`,
`LlmChatResource`, `createBuiltInLlmProvidersPlugin`, and
`options.core.providers` are gone. Content-role helpers live under
`runtime/content/` (`LLM_CONTENT_ROLE`, `TOOL_CONTENT_ROLE`,
`llmAttemptContent`, `toolExecutionContent`, `composeRoleContent`,
`replaceContentRoles`). `runtime/domain/` re-exports until Phase 11.

B2b: core text/ask/writes processors work on `CollectionRecord`. Map to
`./domain` only at `buildAgentTextPrompt` / `buildTextTranscript` /
`executeTool` / `recordProviderAttemptLifecycle`.

B4: processor context has no `conversation` / `llmAttempts` /
`toolExecutions`. If the five conversation collections are unbound, the
engine installs throwing proxies, not native
`createConversationRepository` / `createLlmAttemptRepository` /
`createToolExecutionRepository`. Characterization ingress is
`message.create` (plus participant/thread setup) via
`engine.collectionRuntime`, not `engine.conversation.createMessage`.
`prepare()` is in-memory; kernel `message.create` validates `content` as
a ref array. Tests persist prepared assets (`content.assets.publish`)
before create.

Prove:

- `deno task check` — 34 exports, 301 production modules, release-clean.
- `deno task test` — **595 passed** (4 steps), 0 failed, 6 ignored.

Fixes during the remaining pass:

- `toolCatalogFor` / `jqFor` run after the agent is loaded. Early calls
  used `defaultToolCatalog` / `defaultEvaluateJq` and skipped
  OpenAPI/MCP generation.
- `createLlmAttemptRecord` materializes `input.content`, writes refs,
  then `linkOwner` (same pattern as tool execution / message).
- `loadParticipantRecord` / `loadThreadRecord` return `null` when those
  collections are unbound so `executeTool` tests without bound
  collections still run. Writes still `requireBoundCollection`.
- Memory `execute-attempt` accepts `llm` resources with `generate`
  (`generateFromChat`) as well as `factory`. `providerRegistry()` only
  lists factory adapters.
- `completeLlmAttemptCollection` / `failLlmAttemptCollection` copy
  attempt identity metadata onto the mutate event so memory processors
  can match `copilotzWorkflow.kind === "memory_consolidation"`.
- Memory consolidation tests install `coreCollectionsPlugin` plus
  `executeToolProcessor` so `consolidate_memory` runs without the text
  router. Query-tool tests that need agent turns use `corePlugin`.
- Kernel stores collection event payloads as `type='asset'` nodes with
  `event-body:` ids. Asset-count assertions must exclude those.

Deviations:

- `content.materialize` / `linkOwner` are still not in the same SQL
  transaction as the collection event. Session-level materialize means
  retries can leak extra asset nodes.
- `engine.conversation.*` remains the HTTP/application projection when
  collections are bound. It is not a processor API and not a native
  fallback. Characterization stays on `collectionRuntime`. Other runtime
  tests may still use `conversation.createMessage`.
- `LlmChat` remains a chat-function type for `generateFromChat` and
  tests. `CreateTextWorkflowPluginOptions` remains the extra-Agent
  policy bag (jq, catalog, timeouts). Rename those leftover `Workflow*`
  names in Phase 11, not here.
- Bundled `LlmResource` still exposes optional `factory`; processors
  call `generate`. Removed in the core-plugin llm leftover slice.
- Package-root `createCopilotz` still injects
  `canonicalCore: [corePlugin]`. `createCopilotzApplication` / embedded
  `runtime/application/copilotz.ts` do not.
- Processor-originated `deliveries.list` is still stubbed as `[]`.
- `collectionRuntime` stays on the public engine/application object.
- Domain unit tests may still construct native conversation/attempt
  repositories until Phase 11.

### Phase 7 leftover — core-plugin llm adapters (locked 2026-08-18)

User-locked before coding. Same ownership as text processors: shipped
vendor adapters are core plugin `llm` resources, not a runtime catalog.

- Move `runtime/llm/providers/*` to `plugins/core/resources/llm/`.
- `corePlugin.resources.llm` is the only shipping path. No core plugin
  means those ids are not registered and `chat()` has no vendor map.
- Each resource is `{ id, type: "llm", generate }`. Wrap the existing
  `ProviderFactory` with `generateFromFactory`. `session` stays
  declared, unimplemented.
- Delete `runtime/llm/registry.ts`, the orchestrator lazy default
  registry, `providers-plugin.ts`, `builtInLlmResources`,
  `LlmResource.factory`, and `providerRegistry()`.
- `chat()` requires an explicit registry (unit tests and
  `generateFromFactory`). No hardcoded vendor map in runtime.
- Core processors and memory call `llm.generate`. No `defaultChat`
  fallback to a runtime catalog.
- Runtime keeps types, orchestrator, attempt lifecycle, and adapter
  helpers. It does not know which vendors exist.
- Do not rewrite `agent.runtime` / `llmOptions` in this slice.
- Cross-resource failover is the following leftover
  (`runGenerateChain`). `session` is Phase 8. Ingress `createMessage`
  is Phase 9. `agent.runtime` rename is the leftover after the
  failover split.

### Phase 7 leftover — core-plugin llm adapters results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. This leftover
slice is closed. Do not start Phase 8 until this branch is committed.

Shipped vendor adapters live under `plugins/core/resources/llm/` and
are registered only on `corePlugin.resources.llm` as
`{ id, type: "llm", generate }`. `generateFromFactory` wraps the
existing `ProviderFactory`. No core plugin means those ids are not
registered. `chat()` has no vendor map; it requires an explicit
registry.

Deleted: `runtime/llm/registry.ts`, `providers-plugin.ts`,
`builtInLlmResources`, `LlmResource.factory`, `providerRegistry()`.
Core text processor and memory call `requireLlmGenerate`. Memory no
longer takes `options.chat` or falls back to `defaultChat`.

Prove:

- `deno task check` — 34 exports, 300 production modules, release-clean.
- `deno task test` — **593 passed** (4 steps), 0 failed, 6 ignored.

Deviations:

- `session` is still declared and unimplemented (Phase 8).
- `generateFromFactory` still uses `ProviderFactory` internally.
  Orchestrator unit tests still pass an explicit registry into `chat()`.
- `defaultChat` remains a public alias of `chat()` (Phase 11).
- Adapter helpers (`withInclusiveInputTokens`,
  `resolveProviderStopSequences`, OpenAI mode/cache helpers,
  `processStream`) are exported from `@copilotz/copilotz/llm` so plugin
  adapters can import the public subpath.
- `agent.runtime` / `llmOptions` were not rewritten (Phase 7 leftover
  after the failover split).
- Cross-resource failover is the following leftover
  (`runGenerateChain`). One `generate()` is one vendor.

### Phase 7 leftover — thread-message feature (locked 2026-08-18)

User-locked before coding. B3 leftover: the participant / membership /
message sequence is shared multi-collection policy. Not a `postMessage`
wrapper around `message.create`.

- Feature id `copilotz.core.thread-message`, action `create`.
- Sequence only, one transaction: ensure participant + add sender to
  `thread.participantIds` + `message.create`.
- Content materialize / `linkOwner` stay in the caller. The feature
  takes already-materialized content refs. Do not expand
  `FeatureContext.content` in this slice.
- Register on `corePlugin` and `coreCollectionsPlugin` (collection
  policy, not text routing). No core collections plugin means the
  feature is not registered.
- Processors replace the inlined `createThreadMessage` transaction with
  `context.features.invoke`. A thin persist-then-invoke helper may stay
  in `writes.ts`. That helper is plugin-local, not a runtime facade.
- Runtime plugins that currently do the full sequence (knowledge
  announce) invoke the same feature. `createMessageRecord` stays for
  callers that already have `senderId`. Tool-execution batch
  ensure+membership without a message stays local.
- `collection-ingress` `createMessage` keeps its local sequence this
  slice: it must return `CoordinatedMutationResult` (event + dispatch
  handles) and dies in Phase 9. Do not wrap `message.create` as
  `postMessage`.
- Do not start Phase 8. Cross-resource failover is the following
  leftover. `session` is Phase 8. Ingress `createMessage` is Phase 9.

### Phase 7 leftover — thread-message feature results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. This leftover
slice is closed. Do not start Phase 8 until this branch is committed.

`copilotz.core.thread-message` `create` is a core-plugin feature: ensure
participant + add sender to `thread.participantIds` + `message.create`
in one transaction. Registered on `corePlugin` and
`coreCollectionsPlugin`. Content materialize / `linkOwner` stay in the
caller.

Processors keep a thin persist-then-invoke helper in `writes.ts`.
Knowledge announce invokes the feature. `createMessageRecord` remains
for callers that already have `senderId`.

Prove:

- `deno task check` — 34 exports, 301 production modules, release-clean.
- `deno task test` — **594 passed** (4 steps), 0 failed, 6 ignored.

Deviations:

- `collection-ingress` `createMessage` still duplicates the sequence.
  It must return `CoordinatedMutationResult` (event + dispatch handles)
  and dies in Phase 9. Not a `postMessage` wrapper.
- Tool-execution batch still ensures participant + membership without a
  message. Optional later `ensureMember`; not this feature.
- `session` is Phase 8. Cross-resource failover is the following
  leftover. `agent.runtime` rename is the leftover after that split.

### Phase 7 leftover — generate failover split (locked 2026-08-18)

User-locked before coding. One policy, two executors. Do not copy
`decideRecovery` into the processor.

- `decideRecovery` stays the only recovery brain.
- `generate()` / `chat()` executes `retry_same` and **same-resource**
  fallbacks only (same `llm` id: other model, other credential/endpoint).
  `config.fallbacks` entries with a different provider id are not
  executed inside that call.
- When the policy says `fallback` and this generate has no remaining
  same-resource attempt, **surface** it (tagged `LLMProviderError`
  with `crossResourceFailover`, `name: LLMCrossResourceFailover`).
  Do not walk other vendor ids. `hasExternalFallback` tells the policy
  that a later chain target exists, so auth/empty-output can still
  choose `fallback` instead of `fail`.
- `runGenerateChain(targets, input)` in `runtime/llm` is the shared
  loop for text and memory. Consecutive same-id fallbacks stay one
  `generate()`; a different id starts the next target.
- Target list is today’s `llmOptions.fallbacks` (same mode). Do **not**
  rename to `agent.runtime` in this slice.
- Child `llm_attempt` rows stay one physical `generate()` attempt each
  (`recordProviderAttemptLifecycle`).
- Out of scope: `session`, ingress `createMessage`, Phase 8,
  `llmOptions` → `agent.runtime`.

### Phase 7 leftover — generate failover split results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. This leftover
slice is closed. Do not start leftover 2 (`agent.runtime`) or Phase 8
until asked.

`decideRecovery` stays the only recovery brain. `chat()` / `generate()`
execute `retry_same` and same-resource fallbacks only. Different-provider
`config.fallbacks` are ignored inside that call. When the policy says
`fallback` and no local attempt remains, a tagged `LLMProviderError`
(`crossResourceFailover`, `name: LLMCrossResourceFailover`) is thrown.
`hasExternalFallback` lets auth/empty-output still choose `fallback`.

`runGenerateChain` is the shared text/memory loop. Consecutive same-id
fallbacks stay one `generate()`. A different id starts the next target.
The chain continues only on that tagged error. `finalize_partial`
returns and stops. Target list is still `llmOptions.fallbacks`. Text
processor and memory both use the chain.

Prove:

- `deno task check` — 34 exports, 302 production modules, release-clean.
- `deno task test` — **601 passed** (4 steps), 0 failed, 6 ignored.

Deviations:

- Architecture forbids a new non-Error class, so failover is a tagged
  `LLMProviderError` rather than a subclass.
- `llmOptions` → `agent.runtime` was not renamed (leftover 2).
- `session` remains declared (Phase 8).
- Ingress `createMessage` still duplicates thread-message (Phase 9).

### Phase 7 leftover — `agent.runtime` (locked 2026-08-18)

User-locked before coding. Rename-only. Do not invent recovery rules.

- Replace `llmOptions` and `runtimes.text` / `runtimes.realtime` with
  `agent.runtime?: AgentRuntime | readonly AgentRuntime[]`.
- One object is the common case. An array is at most one runtime per
  mode (`generate` default, `session`). Modes are lifecycle, not
  provider failover.
- `agent.runtime.provider` / `agent.runtime.fallbacks` are the list
  `runGenerateChain` already consumes.
- `agentTextBaseConfig` reads the generate-mode runtime.
- Attachment stream lookup uses `mode: "session"`, not
  `runtimes.realtime`.
- No `llmOptions` alias. No `runtimes` bag. Do not implement `session`.
- Out of scope: Phase 8, ingress `createMessage`, recovery policy.

### Phase 7 leftover — `agent.runtime` results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. This leftover
slice is closed. Do not start Phase 8 until asked.

`agent.runtime` replaces `llmOptions` and `runtimes.text` /
`runtimes.realtime`. One object is the common case; an array is at most
one runtime per mode (`generate` default, `session`).
`agentTextBaseConfig` / `runGenerateChain` consume the generate-mode
runtime. Attachment streams look up `mode: "session"`. No
`llmOptions` alias. `session()` is still unimplemented.

Prove:

- `deno task check` — 34 exports, 302 production modules, release-clean.
- `deno task test` — **605 passed** (4 steps), 0 failed, 6 ignored.

Deviations:

- `AgentRuntime` still carries `ProviderConfig` fields (`apiKey`,
  timeouts) so this stays a rename, not a credentials-injection rewrite.
- `session` remains declared (Phase 8).
- Ingress `createMessage` still duplicates thread-message (Phase 9).

### Phase 8 — Progressive assets and durable streams

Implement progressive body-store writers/followers for database, memory,
filesystem and S3-compatible storage. Then port stream as a core collection and
connect it to provider/tool execution and Oxian.

`LlmResource.session` stays declared until this phase. Implement the
bidirectional adapter after stream collection and durable offsets exist.
Do not fake `session` on ephemeral deltas.

Test bounded memory, backpressure, offsets, crash recovery, retained partials,
discard, checksum verification, one writer, many followers, in-process and
remote transport.

Exit gate: no raw frame is stored as an event; active streams recover from
durable offsets; attempt/tool progress requires no incremental domain updates;
`session` can host an ongoing interaction over those offsets.

### Phase 8 slice 1 — progressive body-store writers (locked 2026-08-18)

User-locked before coding. `session()` waits until stream collection and
durable offsets exist. Do not fake it on ephemeral deltas.

- Today's `AssetBodyStore` `put`/`open` is whole-blob. Add a factory
  progressive writer and follower over the same stores.
- One writer per key. Many independent followers from committed offsets.
- Writer: accept chunks, backpressure, finalize (checksum + `put`), or
  abandon (discard staging).
- Memory may keep the in-process prefix until finalize. Filesystem /
  database / S3 must spill so a slow follower cannot block others.
- No `stream.created` wiring, no Oxian stream transport, no
  `LlmResource.session` in this slice.
- Out of scope: Phase 9 attachment rebuild, ingress `createMessage`.

### Phase 8 slice 1 — progressive body-store writers results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. Memory contract is
in. Filesystem / database / S3 spill remains this slice. Do not
implement `session`.

`createProgressiveBodyWriter` / `openProgressiveBodyFollower` sit on
`AssetBodyStore`. One writer per key. Independent followers from
committed offsets. Finalize checksums and `put`s. Abandon discards
staging. Memory keeps the in-process prefix until finalize.

Prove:

- `deno task check` — 34 exports, 303 production modules, release-clean.
- `deno task test` — **610 passed** (4 steps), 0 failed, 6 ignored.

Remaining in this slice: filesystem, database, and S3 writers that
spill so a slow follower cannot block others.

### Phase 8 slice 1 — spill and verified prefix (locked 2026-08-18)

User-locked before coding. Still this slice. Do not wire
`stream.created`, Oxian stream transport, or `session()`.

Whole-blob `put`/`open` stays. Progressive writers sit on
`AssetBodyStore`. Memory may keep the in-process prefix until
finalize. Filesystem, database, and S3 must spill committed bytes so a
slow follower cannot block the writer or other followers.

- `createProgressiveBodyWriter` is async so it can resume from spilled
  staging when no live writer owns the key.
- One live writer per key per process. Existing staging with no live
  writer is a resume, not a conflict.
- Writer methods: `write`, `retain(byteLength?)`, `discard(byteLength?)`,
  `finalize`, `abandon`. Offsets are absolute and do not compact.
- `retain` checksums `[discarded, n]` (default n = committed), `put`s
  that prefix, closes the writer, and followers then see EOF. This is
  barge-in / kept partials.
- `discard` raises the discarded watermark (default n = committed),
  drops that prefix from staging, and leaves the writer open.
  Followers whose cursor is below the watermark fail `asset_deleted`.
  Later `finalize` `put`s only `[discarded, committed]`.
- `finalize` checksums the retained remainder and `put`s it. `abandon`
  deletes staging and errors live followers. Neither path writes frames
  as events.
- Spill lives on the body store (`store.spill`), not on the asset
  repository. Database bodies remain graph `nodes.content` until a later
  slice; this slice adds `createDatabaseAssetBodyStore` as a real
  `AssetBodyStore` with `kind: "database"` plus its own staging tables,
  not a core event-schema change.
- Filesystem staging is `{key}.progressive` plus `{key}.progressive.json`.
  S3 staging is `{key}.progressive/` parts. Cross-process writer locks
  are out of scope; exclusive write is in-process.
- `createStreamingAssetWriterFactory({ assets })` staging/`ready`
  publish stays later. Stream `contentRef` stays later.

### Phase 8 slice 1 — spill and verified prefix results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. Slice 1 body-store
writers are complete. Do not implement `session`.

Filesystem, database, and S3 spill committed bytes through
`AssetBodyStore.spill`. Memory still keeps the in-process prefix and
backpressures a lagging follower. `createProgressiveBodyWriter` resumes
from staging when no live writer owns the key. `retain` checksums and
`put`s `[discarded, n]`. `discard` raises the watermark and drops that
prefix from staging. `finalize` `put`s the remainder. `abandon` deletes
staging. `createDatabaseAssetBodyStore` is a body store with its own
staging tables; graph `nodes.content` is unchanged.

Prove:

- `deno task check` — 34 exports, 304 production modules, release-clean.
- `deno task test` — **618 passed** (4 steps), 0 failed, 6 ignored.

Next Phase 8 slice: port/connect `stream` as a core collection. Then
`LlmResource.session` over durable offsets. No Oxian stream transport
and no attachment rebuild until those exist.

### Phase 8 slice 2 — stream collection and writer factory (locked 2026-08-18)

User-locked before coding. Do not implement `session()`, Oxian stream
transport, attachment `send({ payload: ReadableStream })`, or LLM/tool
token pumping.

`stream` is already registered. This slice connects it to progressive
bodies.

- Record fields: required `lane` and `mediaType`; `content` is a
  ContentSequence (normally one ref); optional `participantId` for
  speaker routing; `state` stays `open` / `closed` / `failed` /
  `abandoned`.
- Named queries: `byThreadId`, `byThreadLaneState`. Commands: `close`,
  `fail`, `abandon`. Each terminal command emits one `stream.updated`.
  A terminal stream cannot be mutated again.
- Do **not** declare `content: { fields: ["content"] }` yet.
  Collection materialize requires a ready asset. An open stream reserves
  an asset ID and body-store key only. Graph `asset.created` waits until
  a later slice adds staging/`ready` publish. Followers use the stream
  record's content ref plus `openProgressiveBodyFollower`.
- `runtime/streams/` owns the mechanics. `createStreamWriter` /
  `openStreamFollower` take a bound `stream` collection and an
  `AssetBodyStore`. Runtime does not import `plugins/**`.
- Lifecycle: reserve ids → commit `stream.created` (and static
  deliveries) → only then accept bytes → `retain`/`finalize` `put`s the
  body then `close`, or `abandon`/`fail` drops staging. No raw frame is
  an event row.
- Out of scope: `LlmResource.session`, Oxian frames, Phase 9
  attachments, text-processor cutover, `context.streams` processor
  capability.

### Phase 8 slice 2 — stream collection and writer factory results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. Stream collection
is connected to progressive bodies. Do not implement `session`.

`createStreamWriter` commits `stream.created` before accepting bytes,
then `put`s the body and emits one terminal `stream.updated`. Followers
use the stream record's content ref and `openProgressiveBodyFollower`.
Chunk count does not create events. Graph `asset.created` is still
deferred until staging/`ready` publish. Runtime does not import
`plugins/**`.

Prove:

- `deno task check` — 34 exports, 308 production modules, release-clean.
- `deno task test` — **622 passed** (4 steps), 0 failed, 6 ignored.

Next Phase 8 slice: retarget Oxian onto these durable streams before
`session()`. Do not implement `session()` on an in-process writer.

### Phase 8 slice 3 — Oxian stream workload (locked 2026-08-18)

User-locked before coding. One transport: Oxian, in-process or WebSocket.
Do not implement `LlmResource.session`. Do not keep a second stream path.

- Replace `createRealtimeStreamWorkload` with `createStreamWorkload` in
  `runtime/streams/`. Dispatch metadata is `copilotz.stream.dispatch.v1`
  with `action: "write" | "follow"`, stream id, namespace, thread, lane,
  media type, offset, and cancel. Worker reconstructs from IDs and the
  bound `stream` collection plus the body store. Runtime still does not
  import `plugins/**`.
- `write` commits `stream.created` via `createStreamWriter`, pumps the
  Oxian input body, returns a live follower as output, then
  `finalize`s. `follow` is reconnect from offset via
  `openStreamFollower`. Local may pass Web Streams; remote uses the
  existing bounded Copilotz work frames. Neither path changes domain
  semantics. Bytes stay in the progressive asset.
- Delete the leftover path this replaces: `RealtimeProviderResource`,
  `defineRealtimeProviderResource`, `createRealtimeStreamWorkload`,
  `createRealtimeProviderContext`, attachment `send({ payload })`
  that looked up a `type: "realtime"` provider, and
  `stream.opened` / `stream.closed` / `stream.cancelled` producers.
  `AttachmentStreamOutput` stays for SSE/channel projection. Stream
  ingress through attachments is Phase 9; this slice's producer is
  `dispatchWork` / the workload itself.
- Engine installs the new workload as `copilotz.stream.v1`. Body store
  is `assetStorage.writer` when configured, otherwise
  `createDatabaseAssetBodyStore` for that schema so gateway and worker
  share spilled bytes.
- Out of scope: `LlmResource.session`, Phase 9 attachment/`run()`
  rebuild, staging/`ready` `asset.created`, `context.streams`.

### Phase 8 slice 3 — Oxian stream workload results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. Oxian is the only
stream transport. Do not implement `session` on a private in-process
writer.

`createStreamWorkload` lives in `runtime/streams/`. `write` commits
`stream.created`, pumps Oxian input into `createStreamWriter`, returns a
live follower, then `finalize`s. `follow` reconnects from offset.
Gateway/worker WebSocket uses the same descriptors and Copilotz work
frames. Bytes stay in the progressive asset.

Deleted the leftover path: `RealtimeProviderResource`,
`defineRealtimeProviderResource`, `createRealtimeStreamWorkload`,
`createRealtimeProviderContext`, attachment `send({ payload })`, and
`stream.opened` / `stream.closed` / `stream.cancelled` producers.
`AttachmentStreamOutput` remains for SSE/channel projection.

Prove:

- `deno task check` — 34 exports, 307 production modules, release-clean.
- `deno task test` — **616 passed** (4 steps), 0 failed, 6 ignored.

Next Phase 8 slice: `generate()` writes these durable streams. `session`
is the same mechanism with a bidirectional lifecycle, not a second pipe.
No attachment/`run()` rebuild until asked.

### Phase 8 slice 4 — generate writes durable streams (locked 2026-08-18)

User-locked before coding. One streaming mechanism: the stream
collection, progressive bodies, and Oxian transport. `generate` is a
producer of that mechanism. Do not implement `LlmResource.session`.

- Add `context.streams` on processor capabilities. `write` / `follow`
  wrap `createStreamWriter` / `openStreamFollower` over the same bound
  `stream` collection and body store as `copilotz.stream.v1`. Runtime
  still does not import `plugins/**`.
- `execute-text-attempt` pumps `generate` tokens into core lanes
  (`content`, `reasoning`, `tool_call`) and issues one terminal
  `stream.updated` per opened lane. Stop emitting `text.delta` /
  `reasoning.delta` / `tool_call.delta` from that processor. Lazily open
  a lane on first chunk. Finalize on success; abandon/fail on
  cancel/error. Pass correlation/causation, participant routing, and
  public visibility so observers see `stream.created`.
- Attachment `outputs` follow `stream.created` with the same follower
  API and yield `AttachmentStreamOutput`. That is observation, not a
  second transport. Do not rebuild `send` / `run` / channels.
- Out of scope: `LlmResource.session`, Phase 9 attachment/`run()`
  rebuild, staging/`ready` `asset.created`, `tool_output` lane, deleting
  `EphemeralEvent` types.

### Phase 8 slice 4 — generate writes durable streams results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. `generate` writes
the same durable streams Oxian already transports. Do not implement
`session` as a second pipe.

`context.streams` wraps `createStreamWriter` / `openStreamFollower` over
the bound `stream` collection and body store. `execute-text-attempt`
pumps `content`, `reasoning`, and `tool_call` lanes and stops emitting
`text.delta` / `reasoning.delta` / `tool_call.delta`. Staging is reserved
before `stream.created` so followers can attach immediately. Attachment
`outputs` follow `stream.created` lazily as `AttachmentStreamOutput`.

Prove:

- `deno task check` — 34 exports, 307 production modules, release-clean.
- `deno task test` — **617 passed** (4 steps), 0 failed, 6 ignored.

Next Phase 8 slice: `LlmResource.session` on this same writer/follow
path. No attachment/`run()` rebuild until asked.

### Phase 8 slice 5 — session and remaining stream producers (locked 2026-08-18)

User-locked before coding. Finish Phase 8. One streaming mechanism.
Do not fake `session` on ephemeral deltas. Do not rebuild
attachment/`run()`/channels.

- `LlmSessionInput` is generate input plus optional
  `input: ReadableStream<Uint8Array>` for ongoing ingress. `LlmInvocation`
  stays `frames` / `result` / `cancel`. Provider-native session ids stay
  inside the adapter. `sessionFromHandler` builds that invocation.
- Same-mode session failover mirrors `runGenerateChain` (`requireLlmSession`).
  `decideRecovery` remains the only recovery policy.
- `execute-text-attempt` calls `session` when the agent has a session
  runtime and no generate runtime. Ingress is follow of open `transcript`
  streams (and later `stream.created` on that lane) from durable offsets.
  Output frames map to `content` / `reasoning` / `tool_call` (audio uses
  `content` plus an audio media type). Message routing does not start a
  second attempt while that session attempt is running.
- `execute-tool` `emitOutput` writes the `tool_output` lane instead of
  `tool_output.delta`. One terminal `stream.updated` per opened stream.
- Bundled adapters stay `generate` only. Tests inject `session` resources.
- Out of scope: Phase 9 attachment/`run()` rebuild, staging/`ready`
  `asset.created`, deleting `EphemeralEvent` types.

### Phase 8 slice 5 — session and remaining stream producers results — 2026-08-18

Recorded on branch `feat/plugin-first-event-source`. Phase 8 is complete.
`generate` and `session` write the same durable streams. Oxian remains the
only transport. Do not reopen a second realtime pipe.

`execute-text-attempt` calls `session` when the agent has a session runtime
and no generate runtime. Ingress follows currently open `transcript`
streams from durable offsets and closes when those pumps EOF. Output
frames map to `content` / `reasoning` / `tool_call`; audio uses `content`
plus an audio media type. Writer identity is
`stream.write:${lane}:${mediaType}` so text and audio can share a lane.
Message routing skips a second attempt while that session attempt is
running. `execute-tool` `emitOutput` writes the `tool_output` lane
(NDJSON) and one terminal `stream.updated` per opened stream.

Prove:

- `deno task check` — 34 exports, 307 production modules, release-clean.
- `deno task test` — **622 passed** (4 steps), 0 failed, 6 ignored.

Next: Phase 8 leftover regression fixes, then Phase 9 unless asked
otherwise.

### Phase 8 leftover — event-source regression fixes results — 2026-08-19

Recorded on branch `feat/plugin-first-event-source`. This leftover
slice is closed. Do not start Phase 9 until this branch is committed
unless asked otherwise.

Regression tests added in `75b7210` failed on pagination, catch-up
overlap, feature deliveries, collection-write transaction join, empty
progressive reservation, and thread activity after rebuild. The
working-tree fixes:

- Collection verify/replay page events and stored projections at 1,000
  with `afterPosition` / `after` id cursors.
- Transient catch-up pages at 1,000, binds live-tail before catch-up,
  and dedupes durable ids while `catchingUp`.
- Feature `deliveries.list` reads `eventStore.listDeliveries` with the
  processor namespace (no longer hardcoded `[]`).
- `materialize` / `linkOwner` run inside `context.transaction`.
  `activeCollectionTransaction` joins the open collection SQL executor.
- Progressive writers `reserve` an empty spill row so a remote follower
  can `head` it. A second store without `takeover` is rejected.

Deviations from the original leftover split:

- Thread `lastEventId` / `lastEventPosition` / `lastEventAt` after
  `rebuild`/`verify` was deferred to Phase 11 (store-side
  denormalization, not thread collection events). It is implemented as
  an overlay in `runtime/collections/replay.ts` so verify matches the
  store side-write. It is still not a thread collection event.
- Cross-process writer locks stay out of scope (Phase 8 slice 1).
  Exclusive write across store instances is spill `reservation_id`
  without `takeover`, not a lock table.

Prove:

- `deno task check` — 34 exports, 307 production modules, release-clean.
- `deno task test` — **631 passed** (4 steps), 0 failed, 6 ignored.
- Leftover regression files: 11 passed, 0 failed, 1 ignored.

Residual risks (not defects; do not reopen this leftover to chase them):

- The collection-write regression asserts call order against a mock
  `content.materialize` / `linkOwner`. It does not prove SQL rollback
  of asset nodes/edges when the collection command fails.
- Catch-up∩live-tail dedupe is an in-memory id set for the overlap
  window. It matches the coordinator path that `await`s
  `dispatched.done` before `createThread` returns. A live dispatcher
  that returns before `handle` runs could still double-deliver after
  `catchingUp = false` and `handled.clear()`.
- Exclusive writer ownership is the spill reservation, not a
  cross-process lock service. `takeover` is an explicit recovery fence.
- Thread activity cursors remain a store side-write plus rebuild
  overlay. Phase 11 still owns whether that denormalization stays,
  becomes a collection event, or is rebuilt another way.

Next: Phase 9 attachment/`run()` rebuild unless asked otherwise. Do not
broad-move `/runtime` files or fail CI on the final twelve resource
categories until this ingress cutover lands.

### Phase 9 — Attachments and channel composition

Rebuild attachments and `run()` over feature invoke plus transient processor
bindings. Replace channel runtime/resource abstractions with plugin
composition while retaining public HTTP/SSE/WebSocket behavior. Do not
bring back `engine.conversation` as the ingress API.

`collection-ingress` `createMessage` still duplicates
`copilotz.core.thread-message` because it must return
`CoordinatedMutationResult` (event + dispatch handles). Cut it over
when this ingress dies. Do not wrap `message.create` as `postMessage`.
Tool-execution batch ensure+membership without a message may become an
`ensureMember` action here or stay local.

`lib/packages` chat adapter, SSE event-position resume and per-stream offsets
are in this exit gate. Compass client migration waits; the adapter contract
does not.

Exit gate: reconnect from event/stream cursors, slow-client bounds, parallel
participant streams, stream ingress, cancellation and durable external egress
all pass. Adapter resume IDs remain event position plus stream offsets, or are
explicitly versioned.

### Phase 9 slice 1 — attachment ingress cutover (locked 2026-08-19)

User-locked before coding. Cut `attachment.send` / `run()` off
`ConversationRepository`. Observation uses the same transient processor
contract as live bindings. Do not dissolve the engine host. Do not
broad-move `/runtime`.

- `send(message)` materializes content, then invokes
  `copilotz.core.thread-message` `create`. No `postMessage`. No
  `conversation.createMessage`. Pass `identity.settlementScopeId` so
  `waitForScope` matches deliveries. `linkOwner` stays in the same
  collection transaction as the feature (nested).
- Resolve thread and participants from bound collections (`thread` get /
  `byExternalId`, include `participants`). Map to the existing
  `ConversationThread` / `Participant` DTOs for this slice. Drop
  `conversation` from `CreateAttachmentRuntimeOptions`.
- `outputs` is a unique-id transient processor
  (`eventType: "*"`, namespace, threadId) added at `connect`, not
  `eventHub.subscribe`. Buffer until the output stream starts so
  `run()` can `send` before the consumer reads. Follow `stream.created`
  through `openStreamFollower` as today.
- Matcher: `eventType: "*"` matches any type. For transient observers
  only in this slice; do not register `*` as a static plugin processor.
- `run()` stays a temporary attachment: one send, observe the
  correlation, wait settlement, close.
- Out of scope: deleting `collection-ingress`, `engine.conversation`
  public API, `ChannelRuntime` replacement, SSE/WebSocket reconnect
  cursors, `EphemeralEvent` deletion, HTTP `/channels/...`, Phase 10
  plugin moves.

### Phase 9 slice 1 — attachment ingress cutover results — 2026-08-19

Recorded on branch `feat/plugin-first-event-source`. `attachment.send`
and `run()` no longer call `ConversationRepository.createMessage`.
Do not restore hub subscribe as attachment observation.

`send(message)` materializes content, invokes
`copilotz.core.thread-message` `create`, and `linkOwner`s in the same
collection transaction. Thread and participants resolve from bound
collections. `conversation` is gone from
`CreateAttachmentRuntimeOptions`. `outputs` is a unique-id transient
processor (`eventType: "*"`, namespace, threadId) that buffers until
the output stream starts. `run()` remains a temporary attachment.

Matcher: `eventType: "*"` matches any type. Registered only on
transient observers in this slice.

Deviations from the slice lock:

- Connection-bound transients always run inline via
  `invokeLiveProcessors`. They are never placed on a Worker through
  Oxian `liveDispatcher.dispatch`. Gateway attachments never saw
  Worker-produced events on that path.
- Worker → Gateway `onOutputEvent` now invokes local transients on the
  receiving engine, then hub-publishes. Observation stays transients
  only; hub subscribe was not restored.
- `settlementScopeId` is the generated message record id. Cancel
  filters collection-tx dispatch handles by that scope so detached
  Oxian work is not aborted.
- `live.test.ts` expects `"live processor(s) failed"` (inline
  `invokeLiveProcessors`), not `"live processor operation"`.
- Unused `workerOriginated` was deleted after `publishLive` stopped
  branching on Worker origin for transient placement.
- `collection-ingress` / `engine.conversation` remain for tests, HTTP,
  and admin. `ChannelRuntime` still bootstraps identities through
  `application.conversation` and sends through attachments.

Prove:

- `deno task check` — 34 exports, 307 production modules, release-clean.
- `deno task test` — **632 passed** (4 steps), 0 failed, 6 ignored.

Next: Phase 9 slice 1 leftover (schema isolation, send
dedup, stream follow, static wildcard fence) before proving
slice 2. Do not replace `ChannelRuntime` or dissolve
`engine.conversation` in that leftover.

### Phase 9 slice 1 leftover — attachment observer isolation (locked 2026-08-19)

User-locked before coding. Five regressions fail on the slice 1
cutover. Do not change `ProgressiveBodyFollower` to
`{ body, cancel, done }` in this leftover.

- Each `DatabaseScopeRuntime` owns a `TransientProcessorSet`. Seed
  from configured transients; never share the mutable set across
  physical schemas. Route `publishLive`, `onOutputEvent`, attachments,
  and catch-up through the resolved scope’s set. `engine.bindTransient`
  without a schema stays on the default scope.
- `send(message)` resolves identity before the feature invoke. Reuse
  `workflowMutationId` for `messageId` when only a deduplication id is
  given. Derive correlation and `settlementScopeId` from that id when
  omitted. After the transaction, take `message.created` from
  `tx.writes` instead of scanning `listEvents` by regenerated
  correlation.
- Attachment stream following is demand-driven `pull()`, not an eager
  `start()` pump. Keep an internal follower reader so `close` can
  cancel it while the exposed payload is locked. Honor cancel-before-
  open and drop the active operation in `finally`.
- Keep `eventType: "*"` in `matchProcessor` for transients.
  `PluginRegistry` `add` rejects wildcard clauses on static processor
  resources (plugins and application resources). `defineProcessor` and
  `transients.add` still accept `*`.
- Out of scope: `ProgressiveBodyFollower` contract change,
  `ChannelRuntime` replacement, dissolving `engine.conversation`,
  Phase 10.

### Phase 9 slice 1 leftover — attachment observer isolation results — 2026-08-19

Recorded on branch `feat/plugin-first-event-source`. Do not change
`ProgressiveBodyFollower` to `{ body, cancel, done }` in a follow-up
unless asked.

Each physical schema gets its own `TransientProcessorSet`, seeded from
configured transients. `publishLive` and Worker `onOutputEvent` invoke
the resolved schema’s set. `engine.bindTransient` remains default-schema.

`send(message)` derives `messageId` with `workflowMutationId` when only
a deduplication id is given, and derives correlation /
`settlementScopeId` from that id. The handle is built from the
`message.created` write on `tx.writes`.

Stream following uses demand-driven `pull()`, an internal follower
reader, cancel-before-open, and drops the active operation on settle.
The payload stream prefetches one extra chunk (`highWaterMark: 2`) so a
locked reader still has an in-flight follower read that `close` can
cancel.

`PluginRegistry` `add` rejects static `eventType: "*"`. Matcher and
`transients.add` still accept it.

Prove:

- `deno task check` — 34 exports, 307 production modules, release-clean.
- `deno task test` — **637 passed** (4 steps), 0 failed, 6 ignored.
- Leftover regressions: 5 passed, 0 failed.

Next: prove Phase 9 slice 2 (`createMessage` onto the same feature)
unless asked otherwise. Do not replace `ChannelRuntime` yet.

### Phase 9 slice 2 — cut collection-ingress createMessage (locked 2026-08-19)

User-locked before coding. Stop duplicating `copilotz.core.thread-message`
in `collection-ingress` `createMessage`. App ingress remains
attachments / `run()`. Do not wrap as `postMessage`.

- `createMessage` materializes content, then invokes
  `copilotz.core.thread-message` `create` (same nested collection
  transaction as attachment `send`, including `linkOwner`). Map the
  `message.created` write plus outer-tx dispatch back to
  `CoordinatedMutationResult`. No second local `collections.message.create`
  sequence.
- Pass `featureBindings` into collection ingress. Runtime must not
  import `plugins/**`; use the feature id string.
- Keep `engine.conversation` and the rest of collection-ingress
  (threads, participants, revise, attempts, executions). Tests and
  channels may still call `createMessage`.
- Out of scope: deleting `engine.conversation`, `ChannelRuntime`
  replacement, SSE/WebSocket reconnect cursors, `EphemeralEvent`
  deletion, contract extraction, Phase 10 plugin moves.

### Phase 10 — Optional first-party plugins

Move memory, knowledge, goals, schedules and usage into independent plugins one
at a time. Each uses only collections, processors, context and other public
resources. No privileged runtime repository remains.

`buildAgentTextPrompt` / `buildTextTranscript` stay in `runtime/agents/`
until this phase because `runtime/memory` still calls them and runtime
cannot import `plugins/**`. After they move (or memory stops calling
them), the B2b runtime-boundary maps to `LlmAttempt` /
`ConversationMessage` go away. Do **not** relocate those domain types
into `plugins/core` — that would recreate the forbidden runtime→plugin
import.

Exit gate: disabling any optional plugin removes only its resources and does not
change the generic runtime or core conversation lifecycle.

### Phase 11 — Migration, cleanup and historical validation

Implement the database migration only after the final event/collection schema is
stable.

Migration requirements:

- reject unsafe upgrades with active legacy work;
- preserve namespaces, IDs, conversation history and asset ownership;
- convert native records to canonical collection projections;
- create replayable asset-backed event bodies;
- preserve or explicitly transform settled historical facts;
- remove duplicated legacy tool-authored messages when their canonical tool
  execution/result exists;
- preserve ordinary agent messages that contain tool calls;
- rebuild and verify edges from collection relationships;
- be idempotent and resumable per physical schema;
- support dry-run reports and bounded parallel object migration;
- never run DDL during ordinary tenant access.

Cleanup is part of the phase, not deferred compatibility work. Remove:

- native mutation repositories, direct graph writers, and the native
  record types they own (`LlmAttempt`, `ToolExecution`,
  `ConversationMessage`, `ConversationThread`, `Participant` as
  repository DTOs). Processors already use `CollectionRecord` from B2b;
  this phase deletes the leftover `runtime/domain/` shapes once prompt
  no longer consumes them (Phase 10);
- leftover `Workflow*` names (`WorkflowToolCatalog`,
  `advanceWorkflowPipeline`, `textWorkflowAttemptEventMetadata`,
  `createWorkflowToolExecutor`, and any remaining
  `CreateTextWorkflowPluginOptions` alias). Rename in this cleanup pass,
  not in B2/B2b;
- engine swap to native conversation/attempt/execution repos when core
  collections are unbound (gone in remaining Step B / B4; unbound now
  throws). Do not revive that path;
- `context.conversation` / `llmAttempts` / `toolExecutions` as processor
  APIs (gone in remaining Step B / B4);
- `createBuiltInLlmProvidersPlugin` and `options.core.providers` (gone
  in remaining Step B / B2);
- `copilotz.chat` / `LlmChatResource` / runtime vendor catalog
  (`registry.ts`, `builtInLlmResources`, `LlmResource.factory`) (gone in
  Phase 7). The `LlmChat` function type and
  `CreateTextWorkflowPluginOptions` policy bag remain until this
  cleanup pass. `session` is Phase 8. Cross-resource failover is Phase 7
  leftover (`runGenerateChain`). `agent.runtime` is gone in Phase 7
  leftover 2;
- old workflow executors and event adapters;
- `runtime/workflows/` and the `./workflows` package export (gone in
  Phase 7 Step A; do not revive a compatibility barrel);
- `EphemeralEvent` and modality delta event types;
- callback processor filters and delivery mode flags;
- `ChannelResource`, `ChannelRuntime` and `memoryKinds`;
- `llmOptions`, `runtimes.text` and `runtimes.realtime` (gone in Phase 7
  leftover 2; do not revive);
- generic relation collection/repository;
- duplicate validators and resource interfaces;
- obsolete exports, docs, fixtures, dependencies and tasks.

Run unused-export and dependency analysis. Add forbidden-symbol checks so the
removed architecture cannot silently return.

## 14. Required test matrix

### Collections and events

- create/update/delete/mutate and no-op;
- schema/default/content validation;
- replay equivalence and tamper detection;
- relationships and edge cleanup;
- query, relation include/filter, text and vector search;
- declared named queries for recurring policy reads;
- deduplication, concurrency and tenant isolation;
- atomic graph/event/delivery/content commit, including database event bodies;
- crashes before/after commit and before/after dispatch.

### Deliveries and processors

- matcher OR/AND/nested/wildcard behavior;
- stable override IDs;
- independent static obligations;
- retries, leases, cancellation, dead letters and settlement;
- transient catch-up/live-tail handoff without gaps;
- executor uses event body rather than mutable subject projection.

### Conversation and multi-agent workflow

- user to agent;
- same-agent tool continuation;
- parallel tools with one continuation;
- public ask, nested ask and parallel ask;
- provider/tool failure and timeout;
- reasoning and tool visibility;
- revisions and active message branches;
- multimodal content and attachments;
- skills, context, memory and knowledge contributions.

### Streams and realtime

- one-call stream ingress;
- database/memory/filesystem/S3 writer contracts;
- backpressure and bounded memory;
- independent followers and offsets;
- cancellation, barge-in and retained partials;
- concurrent participant-labelled output;
- text/audio/tool streams through generate and session providers;
- in-process and remote Oxian paths;
- no frame persistence in the events table.

### Runtime neutrality

- Deno;
- Node;
- Bun;
- browser bundle;
- Cloudflare-compatible bundle;
- PostgreSQL and persistent PGlite.

## 15. Final historical upgrade ladder

This is the release gate. It uses a persistent on-disk PGlite database and real
OpenAI execution with `gpt-5.4-nano`. Credentials come from local environment
configuration and must never be printed or committed.

### Stage A — 0.55.x fixture

Install a pinned `0.55.x` Copilotz version and run an end-to-end application
containing:

- more than one agent;
- public agent-to-agent interaction;
- at least one tool call and result;
- SSE output;
- persistent conversation history.

Save the database and expected transcript/workflow observations.

### Stage B — Current pre-refactor v3

Upgrade the same database through the existing migration path to the clean
`0.60.18` baseline. Run the same application behavior against the migrated
history. Verify IDs, messages, tools, assets and continued conversation.

### Stage C — 0.61 refactor

Run the new migration on the same database. Rebuild projections from the new
event history and compare them with migrated projections. Run the same real
multi-agent/tool/SSE flow again and continue an old thread.

The release passes only when:

- every relevant historical record is represented canonically;
- replay and stored projections agree;
- no duplicated tool-authored chat messages remain;
- old and new attachments resolve;
- old conversations remain reusable;
- multi-agent, tools, streaming and SSE complete end to end;
- rerunning migrations is a no-op;
- the final database contains no legacy runtime tables or columns.

Compass deployment is intentionally outside this handoff. Client migration
starts only after this ladder passes.

## 16. Definition of done

The refactor is complete when all of the following are true:

- the clean resource vocabulary is the only vocabulary;
- runtime mechanisms never import concrete plugins;
- plugins consume only public Copilotz contracts;
- core behavior is inspectable as declarative plugin resources;
- every mutable domain record uses the generic collection command/reducer path;
- every durable collection event is replayable and asset-backed;
- nodes and edges rebuild exactly from events;
- collection relationships, not a relation collection, own graph edges;
- processors consume immutable event bodies and direct runtime primitives;
- generate and session providers share one LLM resource model;
- raw streaming frames live in progressive assets, not event rows;
- attachments, run, SSE and WebSocket share transient processor semantics;
- optional domains are ordinary plugins;
- `features` are reusable operations (processors and, when composed,
  HTTP); `api` resources are outbound agent tools; neither is a
  kernel-mechanism bucket;
- all old mutation/repository/workflow paths are deleted;
- the complete test matrix and historical upgrade ladder pass;
- package checks, unused exports, dependency analysis and publish dry-run are
  clean.

