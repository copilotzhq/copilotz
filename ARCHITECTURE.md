# Copilotz Architecture — 30,000-Foot View

Copilotz is an event-driven runtime for building AI harnesses from small,
composable primitives. Rather than embedding agent behavior, model providers,
tools, and application state into a single execution loop, the runtime separates
them into independent components that communicate through events and
well-defined runtime interfaces.

At the center of the architecture is the **runtime**. The runtime owns the event
lifecycle, maintains the registries contributed by plugins, exposes shared
runtime context, and coordinates execution. Applications send inputs into the
runtime; those inputs cause state changes or actions to execute, which in turn
produce events. Events become the common language through which the rest of the
system observes what has happened and decides what should happen next.

The runtime is extended through **plugins**. A plugin is a package of
capabilities that contributes some combination of five primitives:

- **Collections** represent state and provide the operations for mutating and
  querying that state.
- **Actions** represent executable application capabilities or workflows. They
  contain the reusable logic for performing an operation and emit lifecycle
  events as they execute.
- **Processors** react to events and implement orchestration and business logic
  by deciding which actions or mutations should happen next.
- **Resources** are named, immutable process-local semantic definitions consumed
  by the runtime and its plugins, such as agents, tools, models, prompts, or
  routing policies. A Resource may carry a typed policy hook when that hook is
  part of its semantic definition.
- **Adapters** provide interchangeable implementations for variable external or
  infrastructural boundaries, such as different LLM providers, storage systems,
  search engines, or execution environments.

These primitives deliberately operate at different levels of abstraction.
**Collections describe what is**, **actions describe what the system can do**,
and **processors decide when those capabilities should be used**. Resources
provide the configuration that influences those decisions, while adapters
isolate the parts of an implementation that may vary depending on the external
system being used.

Events connect these components without requiring them to know about one another
directly. A collection mutation can emit lifecycle events such as created,
updated, or deleted. An action can emit events describing invocation, progress,
completion, failure, or cancellation. Processors subscribe to relevant events
and can respond by invoking another action or mutating another collection. More
complex behavior therefore emerges as a sequence of small event-driven
transitions rather than from one monolithic control loop.

An Action call may carry plugin-owned metadata. The runtime canonicalizes it
once and persists the same required metadata object in every lifecycle Event
Body; omission becomes `{}`. The executing Action receives it as
`context.action.metadata`. Metadata is not copied into the generic Event
envelope and is not inherited by nested Action calls: a caller that wants to
propagate it passes it explicitly. This makes provenance durable without making
the runtime interpret it or silently couple two capabilities.

Action input and output schemas may mark confidential subtrees with the raw
boolean extension `x-copilotz-secret: true`; `secret(schema)` is exact authoring
sugar for that marker. A process-local Secret Adapter encrypts those values into
BodyStore objects owned by internal `protected_value` projections. Lifecycle
Event Bodies contain only schema-shaped redaction markers, opaque references,
and keyed commitments. They are hydrated for trusted execution and replay, but
ordinary Processors, observation, Admin projections, and streams receive the
redacted lifecycle. Protected values are not Assets and create neither a
ContentRef nor `asset.created`. Secret-bearing Actions cannot publish progress,
and their durable failures are bounded rather than reflecting application error
text.

A durable Processor may use `eventType: "*"` only with a non-empty structural
guard in `subject`, Event-envelope `metadata`, or resolved `data`. Namespace,
thread, routing, or visibility alone are not sufficient guards, and empty
objects or arrays do not qualify. A Processor that reacts to a class of Action
lifecycle Events normally guards on `data.status` and `data.metadata`; it does
not require a second action registry or a special lifecycle-query API.

An AI harness is built on top of these generic primitives rather than being
hard-coded into the runtime. Messages, threads, and participants can be
represented as collections. LLM calls, tool invocations, or other capabilities
are Actions, and their durable lifecycle Events are their operational record;
they do not require parallel `llm_attempt` or `tool_execution` Collections. The
agent loop is expressed through Processors that react to conversation and Action
Events and determine the next operation to perform.

Concepts such as **agents**, **tools**, and **models** primarily enter the
system as resources. An Agent can describe its identity, model preferences,
available tools, and an instructions policy hook. A Context Resource can
contribute prompt material and a Skill can provide its files through similarly
typed local hooks. These hooks are evaluated from the composed Resource; they
are not Action lifecycles, Event data, or persisted configuration. A Tool
Resource instead describes how an existing Action is exposed to an LLM: its
`action` field is the same alias used by both `resources.tools` and
`context.actions`. It does not carry an `execute` method or a second execution
lifecycle. A Model Resource describes one atomic model deployment. Ordered model
preference and fallback belong to the Agent or direct LLM call.

Provider-specific behavior is isolated behind adapters. For example, an
`llm.call` action may own the common workflow for preparing an LLM request,
consuming a streamed response, normalizing its output, and integrating the
result into the runtime. The portions that differ between OpenAI, Google, or
another provider are delegated to their respective LLM adapters. Consequently,
the orchestration and business logic remains unchanged when the underlying
provider changes. The LLM plugin installs the provider-neutral Action,
contracts, and built-in provider drivers. Applications explicitly contribute
Model Resources containing process-local provider configuration. A Model may
carry a simple inline key or reference a reusable, provider-bound
`llmCredentials` Resource; a custom provider is defined with `createLlmAdapter`
and referenced by its Model Resource. Credential resolver output and clients
never enter Action input, Action-call metadata, progress, output, or Usage
records.

Each reported provider request becomes one durable Usage ledger row identified
by the LLM Action run and attempt index. A completed logical call does not add a
second aggregate row. If Copilotz rejects a provider response locally and may
recover, it stops projecting that response but drains the provider transport and
awaits finalized attempt usage before the next candidate. External cancellation
is propagated immediately and records only accounting already reported by the
provider.

The runtime acts as the **composition boundary** for all of this. When plugins
are installed, their collections, actions, processors, resources, and adapters
are registered with the runtime. Resources and adapters remain separate
composition categories: resources are available under `context.resources`, while
adapters are available under `context.adapters`. Actions and processors declare
ordinary TypeScript interfaces for the context shape they expect. These
interfaces provide type inference and static composition checking; they do not
become runtime dependency declarations. The runtime passes the complete composed
context without filtering it or constructing per-capability proxies.

Actions and Processors share one runtime-neutral `RuntimeContext`. A Processor
receives its resolved immutable Event as the first argument to
`handle(event, context)`; the Event is not another context service. Cancellation
and progressive content production are always present as `context.signal` and
`context.streams`. The context contains composed primitives and generic runtime
mechanics, but never raw storage or database access, executor internals, Event
or delivery services, or scheduling services. Those mechanisms remain behind the
runtime boundary rather than becoming privileged plugin APIs.

A Stream is a runtime-owned progressive Body, not a conversation primitive.
Every `context.streams.open(...)` publishes one generic transient
`stream.output` observation. The lower-level Body primitive may be constructed
without observation wiring for internal storage and following. The emitted
descriptor contains content metadata and correlation only—never thread,
participant, routing, visibility, Collection, or plugin fields. Semantic plugins
may place opaque hints in metadata, but the runtime never interprets those
hints.

Application observation is bound by runtime correlation, never by semantic
thread or participant fields. A `send` operation installs its observation sink
before appending ingress. Its settlement waits for durable work to reach zero,
drains any relayed execution output, and then confirms durable settlement again
before closing the operation. Closing the observation preserves already-queued
events, so a final remote frame cannot disappear between Worker completion and
Gateway delivery. The application-wide `observe()` sink receives the same
application outputs independently of any active `send`. Normal Event outputs
retain their immutable envelope and expose resolved, deeply frozen `data`;
durable Events also retain the original `payload.dataRef`. Progressive
`stream.output` observations remain subscriber-owned byte streams.

The optional Server plugin compiles the composed Action, Collection, and Channel
registries into one immutable HTTP route table and OpenAPI document. Canonical
paths derive from stable primitive identity; application-owned include/exclude
globs and exact overrides control public presentation. A process-local guard
selects trusted namespace, physical schema, identity, and Action metadata before
work begins. The client never selects executable identity or persistence scope.
The package Server boundary is Fetch-native and Oxian-compatible; it does not
own a listener. Request observation uses one multipart response containing the
exact causal `ApplicationOutput` sequence and raw progressive bytes, while input
streaming remains a separate contract.

Durable delivery failures have an explicit disposition. Unknown failures are
retryable by default and the recovery-owning Gateway executor requeues them at
their persisted availability time until success or bounded dead-letter
exhaustion. A deterministic failure may be marked non-retryable at the throw
site; it dead-letters on that attempt. JavaScript error classes are never used
as retryability heuristics. An inherited `send` therefore reaches success or a
terminal rejection rather than remaining indefinitely in `retry_wait`.

`context.transaction(callback)` records an atomic graph-mutation plan; it does
not open SQL around arbitrary plugin code. Its Collection surface is
mutation-only and returns stable `{ id }` references rather than speculative
records. The runtime prepares declared content before opening SQL, then adopts
the prepared Bodies and Assets inside the same commit as graph projections,
Event Bodies, Events, and delivery obligations. Work is dispatched only after
that commit succeeds.

Every BodyStore Adapter declares its durability, reach, minimum protection, and
Ready-GC capability. On an Adapter with `readyGarbageCollection: true`, `put` is
acquire-or-create: reusing a matching Ready Body renews non-shortening
protection and advances its maintenance version, while deletion performs an
exact state/version/idle/protection compare-and-delete. An Adapter that cannot
guarantee that protocol sets `readyGarbageCollection: false`; its `put` remains
immutable and integrity-checking but need not renew protection. The built-in S3
Adapter follows this conservative model.

The filesystem Adapter is crash-durable through its atomic manifest/tombstone
protocol, but its declared coordination reach is one process. Its Ready-GC
guarantee therefore applies only within that deployment reach.

Body liveness uses one schema-wide advisory read/write barrier. Asset adoption
and projection rebuild hold the shared side through graph commit; physical Body
deletion holds the exclusive side while it rechecks the indexed Ready Asset
nodes. The graph transaction validates the captured protection deadline but
performs no external BodyStore I/O. A Ready Asset node's indexed `bodyId` is the
sole durable liveness authority. Collections have no `bodyRefs` declaration, and
no `body_references` table exists.

Asset provenance is runtime-neutral. It is one opaque provenance identity
`{ type, id }`; semantic plugins may use values such as `thread`, while
standalone runtime publication may use the namespace. The runtime neither
enumerates those types nor gives them special storage behavior.

LLM materialization honors the existing ContentRef disposition boundary.
`attachment` projects a deterministic Asset descriptor without resolving its
body, while `inline` permits provider materialization; an unspecified `file`
defaults to attachment. This keeps arbitrary files addressable through Asset
Tools without silently copying their bodies into provider requests.

The transaction callback remains ordinary code. Action or Adapter calls made in
it run during planning, before SQL, and are neither rolled back nor implicitly
retried by the runtime. Only the staged graph mutations are atomic. This keeps
the boundary explicit without reintroducing declarative Action modes.

The complete outer context is still available: a Collection read made through
that context is an ordinary planning-time read, not an implicit commit
precondition. When a decision must be checked atomically against record state,
the developer expresses it as a Collection command; the runtime does not hide,
proxy, or effect-police the rest of the context.

Each successful planned Collection call owns one durable semantic Event
identity, even when an update or command leaves the record unchanged. Its Event
Body contains a canonical state-independent intent and the immutable result. A
retry restores that call from the Event Body before consulting mutable graph
state. This makes no-change calls, deletes, and several sequential mutations of
the same record retry-safe without a separate transaction receipt ledger. The
same rule applies to any standalone no-change mutation carrying a durable
deduplication identity; an unkeyed local no-op may return without an Event.

Transactions do not nest. Reusable business helpers receive the current
transaction context explicitly; an Action that owns another transaction runs
before or after the outer transaction. This avoids a second savepoint, scope
merge, and identity model. Within one root callback, every mutation call is
registered when invoked and drained before commit, so an unawaited or rejected
Promise cannot leak a late plan or make callback timing change the write set.
Calls touching the same record or relation plan in invocation order; disjoint
calls may prepare concurrently. Any started mutation failure aborts the whole
plan even when callback code catches its Promise, because the planner has no
hidden partial-savepoint semantics.

Graph relations that are not owned by a single Collection mutation use the same
planner through `transaction.relations.upsert(...)`. Each upsert emits a generic
durable `relation.upserted` Event whose metadata-only body contains the complete
normalized relation. Replay therefore rebuilds edges from immutable event data;
it does not inspect current graph state or hide the relation inside an arbitrary
Collection event.

A durable Event and its optional Event Body are one immutable source fact. The
Event row is also the deduplication record used to restore a completed call, so
neither half is compacted independently or removed by ordinary maintenance. Only
settled delivery obligations are compactable. Event retention can change only
with an explicit snapshot and deduplication-receipt model that preserves replay
and retry semantics; the current architecture has no such second model.

Graph nodes and edges are projections of those facts. Projection rebuild is
therefore one namespace-wide reduction over the complete registered Collection
set, never a destructive rebuild of one Collection in isolation. It folds every
Collection Event Body and every historical Asset manifest, reconstructs Assets
and nodes before their derived edges, and replaces the namespace's complete
authoritative edge set. Generic relation events are folded in global Event
order: deleting either endpoint retires the relation, recreating that endpoint
does not resurrect it, and a later `relation.upserted` Event is required to make
it live again.

Resources are immutable process-local semantic definitions. Their declarative
fields are ordinary typed data; a semantic Resource may additionally retain a
typed, read-only policy hook where its own contract defines one. Those hooks are
pure and deterministic over their supplied snapshot because durable Processor
delivery is at least once and may evaluate the hook again. Hooks are never
serialized into Event Bodies, Action input/output, or Collection records:
recovery uses the Resource composed in the current process. They may return only
their policy value. A hook that needs a durable lifecycle, retry identity,
external side effect, or independently observable execution is an Action
instead.

An LLM credential resolver is a narrower operational boundary: it resolves or
refreshes authentication for the current trusted Action context, not semantic
application behavior. Resolution is lazy and memoized once per credential alias
inside one `llm.call`; `{ available: false }` skips that Model without provider
I/O. Any scoped refresh write must use the supplied stable operation identity so
at-least-once Action execution remains safe. Only the configured Resource and
sanitized availability cross composition; resolved keys and headers remain
ephemeral.

Adapters own interchangeable custom external or infrastructural implementations.
A semantic Resource may instead carry process-local credentials and transport
policy for a built-in implementation. Neither is a policy hook. Semantic helpers
such as `defineAgent`, `defineModel`, `defineContextResource`, `defineSkill`,
and `defineApi` validate and freeze their corresponding Resource definition;
they do not create a privileged runtime representation. In contrast,
`createToolsPlugin` and `createOpenApiToolsPlugin` are explicit compilers: each
creates one or more native Actions plus matching data-only Tool Resources. The
compiled maps remain inspectable, and there is still only one Action lifecycle
and one executor. Generic runtime code never invents or interprets semantic
hooks.

Both actions and processors may consume the composed resources and adapters
through their declared context interfaces. Their architectural roles still guide
usage: actions normally use adapters to implement capabilities, while processors
normally consume resources, invoke actions, and mutate collections. Calling an
external adapter directly from a processor is possible but should prompt the
author to consider whether that operation belongs in an action so it receives
the normal action lifecycle, retry identity, and durable input/output.

The reference AI harness follows the same composition rules. The minimal Core
plugin owns conversation state, agent resources, ingress helpers, and the prompt
policy and Processors that implement the agent loop. Core depends on the
first-party LLM plugin through ordinary plugin composition. The LLM plugin owns
the common `llm.call` Action, Model Resource contract, LLM Adapter contract, and
first-party provider drivers. Applications choose and configure every Model
explicitly; only genuinely custom providers require an Adapter. Neither LLM nor
Core installs a default Model, client, or credential.

Core exposes an LLM tool by mapping a data-only Tool Resource to an existing
Action alias. An object-form `defineTool({ ... execute })` is authoring sugar:
`createToolsPlugin` compiles `execute` into that native Action and publishes a
separate data-only Tool Resource under the same alias. Core invokes the Action
directly, so its ordinary durable lifecycle is the only tool-execution
lifecycle. Core marks these calls with plugin-owned Action metadata whose
discriminator is `schema: "copilotz.core.tool-action.v1"`; lifecycle Processors
match that durable body data. Multiple tool calls from one LLM result form one
deterministic durable plan. Top-level calls are ordered parallel branches. A
branch may contain a pipeline: Tool stages and deterministic `jq` transforms
execute sequentially, with each Tool result transformed and merged into the next
Tool's explicit input. Branch roots execute concurrently through their ordinary
Actions, while Core persists each branch/stage cursor and a retry-stable fan-in
barrier. Each branch projects only its final value or failure, associated with
the root provider Tool-call ID; intermediate stage lifecycles remain durable but
do not manufacture unmatched transcript calls. Branch results are projected in
deterministic provider order regardless of completion order, and the completed
plan produces exactly one subsequent LLM continuation.

A Core-owned ask Action durably creates its question and completes normally with
the plugin-owned semantic output `{ status: "deferred" }`. That Action terminal
does not settle its plan member. The member settles only when the asked Agent
eventually produces its final answer or failure, after any number of its own
Tool pipelines or nested asks. Nested asks compose the same local durable
barrier recursively, so sibling Agents and their descendant work may progress
concurrently while completion propagates upward one durable plan at a time. No
in-memory Action stays open, and the generic runtime gains no deferred
settlement or Tool-outcome concept.

There is consequently no `Tool.execute`, Tool catalog, Tool executor, Tool host
context, Core wrapper Action, or second validation/lifecycle path. The composed
`resources.tools` and `context.actions` maps are the one definition and
execution path. Memory, knowledge, schedules, channels, concrete tools, usage
accounting, and admin behavior remain optional first-party plugins rather than
hidden Core behavior.

Goals are a Core authoring helper over this existing application boundary, not a
plugin primitive or durable workflow of their own. `runGoal` serially alternates
ordinary `send()` operations between explicit target and lead threads. Each
`send().done` is the complete causal-turn barrier; the next turn receives the
exact canonical Message ContentRefs observed from the settled scope. Messages
and Action lifecycles remain durable and restart-visible, while the local loop
deliberately does not auto-resume after process loss.

Optional semantic plugins receive no runtime back doors. The base Schedules
plugin, for example, owns only timing/status, opaque JSON payload, optional
assetized content, its Scheduled Job Collection, tick/manual-run Actions,
Processors, and typed ingress helpers; a clock sends an opaque envelope through
the ordinary application boundary. Its due Event persists the exact occurrence.
A separate plugin depending on both Schedules and Core owns the typed
scheduled-message payload and due-to-message workflow. Jobs contain a semantic
payload discriminator, never an Action alias or executable locator. The runtime
has no schedule service. Admin derives its views from semantic Message and Usage
state rather than Event or delivery internals.

Core also offers one semantic-neutral private Agent-turn cursor. A trusted
plugin may create an internal Message with an opaque transcript scope, an owner
Agent, and an optional successful-Action completion condition. Core routes that
Message through the exact ordinary prompt, Model, credential, Tool, Ask, and
continuation machinery, while excluding the private scope from ordinary prompt
and HTTP history. Core never interprets the caller's domain task.

Memory uses that cursor to dispatch consolidation to the owning Agent. Memory
alone owns checkpoint reservation, frozen evidence, source authorization,
ontology validation, graph mutation, bounded repair, and atomic settlement.
`consolidate_memory` remains an ordinary granted Tool outside that private turn;
only the Memory-owned cursor changes whether its successful call ends the turn.

At a high level, the architecture can therefore be thought of as:

```text
                   Plugins
                      │
    ┌─────────────────┼─────────────────┐
    │                 │                 │
Resources         Processors         Collections
    │                 │                 │
    │ configures      │ reacts to      │ represents
    ▼                 ▼                 ▼
                  Runtime / Events
                        │
                        │ invokes
                        ▼
                     Actions
                        │
                        │ uses variable boundaries
                        ▼
                     Adapters
                        │
                        ▼
               External Systems
```

The resulting architecture keeps the runtime intentionally general. Copilotz
itself provides the execution model and composition mechanisms; AI-specific
concepts emerge from plugins built on top of those primitives. This allows the
same runtime to support different agent architectures, model providers, tool
ecosystems, persistence strategies, and orchestration patterns without coupling
the core to any one of them.

The core conceptual model is:

**Events describe what happened. Collections describe what is. Processors decide
what happens next. Actions implement what can be done. Resources describe how
the system should be configured. Adapters determine how interchangeable external
boundaries are implemented. Plugins compose these pieces into higher-level
behavior.**
