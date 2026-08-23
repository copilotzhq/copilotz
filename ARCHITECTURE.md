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
- **Resources** are named, declarative definitions and configuration consumed by
  the runtime and its plugins, such as agents, tools, models, prompts, or
  routing policies.
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

An AI harness is built on top of these generic primitives rather than being
hard-coded into the runtime. Messages, threads, participants, and execution
records can be represented as collections. LLM calls, tool invocations, or other
capabilities can be actions. The agent loop itself is expressed through
processors that react to conversation and execution events and determine the
next operation to perform.

Concepts such as **agents**, **tools**, and **models** primarily enter the
system as resources. An agent resource can describe its identity, instructions,
model preferences, available tools, and policies. A tool resource can describe
how an existing action should be exposed to an LLM: its `action` field is the
same alias used by both `resources.tools` and `context.actions`. It does not
carry an `execute` method or a second execution lifecycle. A model resource can
describe which model and adapter should be used for an LLM operation. These
definitions remain declarative; the actual behavior comes from actions and
processors.

Provider-specific behavior is isolated behind adapters. For example, an
`llm.call` action may own the common workflow for preparing an LLM request,
consuming a streamed response, normalizing its output, and integrating the
result into the runtime. The portions that differ between OpenAI, Google, or
another provider are delegated to their respective LLM adapters. Consequently,
the orchestration and business logic remains unchanged when the underlying
provider changes. The LLM plugin installs only the provider-neutral Action and
contracts; applications explicitly contribute Model Resources and provider
Adapters, including credentials and clients, through ordinary composition.

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
participant, routing, visibility, Collection, or plugin fields. Semantic
plugins may place opaque hints in metadata, but the runtime never interprets
those hints.

Application observation is bound by runtime correlation, never by semantic
thread or participant fields. A `send` operation installs its observation sink
before appending ingress. Its settlement waits for durable work to reach zero,
drains any relayed execution output, and then confirms durable settlement again
before closing the operation. Closing the observation preserves already-queued
events, so a final remote frame cannot disappear between Worker completion and
Gateway delivery. The application-wide `observe()` sink receives the same
generic durable and transient Events independently of any active `send`.

`context.transaction(callback)` records an atomic graph-mutation plan; it does
not open SQL around arbitrary plugin code. Its Collection surface is
mutation-only and returns stable `{ id }` references rather than speculative
records. The runtime prepares declared content before opening SQL, then adopts
the prepared Bodies and Assets inside the same commit as
graph projections, Event Bodies, Events, and delivery obligations. Work is
dispatched only after that commit succeeds.

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
sole durable liveness authority. Collections have no `bodyRefs` declaration,
and no `body_references` table exists.

Asset provenance is runtime-neutral. Its scope is one opaque provenance
identity `{ type, id }`; semantic plugins may use values such as `thread`, while
standalone runtime publication may use the namespace. The runtime neither
enumerates those types nor gives them special storage behavior.

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

Graph nodes and edges are projections of those facts.
Projection rebuild is therefore one namespace-wide reduction over the complete
registered Collection set, never a destructive rebuild of one Collection in
isolation. It folds every Collection Event Body and every historical Asset
manifest, reconstructs Assets and nodes before their derived edges, and replaces
the namespace's complete authoritative edge set. Generic relation events are
folded in global Event order: deleting either endpoint retires the relation,
recreating that endpoint does not resurrect it, and a later `relation.upserted`
Event is required to make it live again.

Plain typed objects are the canonical way to declare resources and adapters.
Semantic plugins may export optional helpers such as `defineAgent`,
`defineModel`, or provider-adapter factories when those helpers add useful
inference, defaults, normalization, or runtime validation. A helper must not
create a privileged object form: an equivalent plain object satisfying the same
public interface remains valid. Dynamic configuration is validated by the
semantic plugin that understands it, not by the generic runtime.

Both actions and processors may consume the composed resources and adapters
through their declared context interfaces. Their architectural roles still guide
usage: actions normally use adapters to implement capabilities, while processors
normally consume resources, invoke actions, and mutate collections. Calling an
external adapter directly from a processor is possible but should prompt the
author to consider whether that operation belongs in an action so it receives
the normal action lifecycle, retry identity, and durable input/output.

The reference AI harness follows the same composition rules. The minimal Core
plugin owns conversation state, agent resources, ingress helpers, and the
processors that implement the agent loop. Core depends on the first-party LLM
plugin through ordinary plugin composition. The LLM plugin owns the common
`llm.call` action, model-resource contract, LLM-adapter contract, and
first-party provider adapter factories. Applications choose and configure
provider adapters explicitly. Memory, knowledge, schedules, channels, concrete
tools, goals, usage accounting, and admin behavior remain optional first-party
plugins rather than hidden Core behavior.

Optional semantic plugins receive no runtime back doors. The base Schedules
plugin, for example, owns only timing/status, opaque JSON payload, optional
assetized content, its Scheduled Job Collection, tick/manual-run Actions,
Processors, and typed ingress helpers; a clock sends an opaque envelope through
the ordinary application boundary. Its due Event persists the exact occurrence.
A separate plugin depending on both Schedules and Core owns the typed
scheduled-message payload and due-to-message workflow. Jobs contain a semantic
payload discriminator, never an Action alias or executable locator. The runtime
has no schedule service. Admin derives its views from semantic Message and Usage
state rather than Event or delivery internals. Memory uses Collection graph
relations and carries its triggering Event data explicitly in maintenance Action
input rather than reaching into a domain repository.

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
