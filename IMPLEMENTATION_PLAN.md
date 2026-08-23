# Copilotz First-Principles Refactor Plan

Status: active implementation authority.

This plan implements [`ARCHITECTURE.md`](./ARCHITECTURE.md). It replaces the
deleted phase implementation specifications. If this plan and the architecture
document disagree, the architecture document wins.

## 1. Objective

Make Copilotz a small, event-driven runtime that composes plugins from:

- Collections;
- Actions;
- Processors;
- Resources;
- Adapters.

The runtime must understand these primitives and the mechanics required to run
them. It must not understand agents, tools, models, prompts, memory, goals,
channels, schedules, or any other plugin's business meaning.

The refactor is complete when an AI harness is ordinary plugin composition over
the generic runtime, not a special execution path inside it.

## 2. Working rules

1. There is one target API at a time. When a slice replaces an unreleased API,
   it migrates every caller and deletes the previous implementation in the same
   slice. Do not add aliases, bridges, dual registries, or parallel execution
   paths.
2. Preserve released durable data through an explicit migration after the final
   storage model is frozen. Unreleased refactor code receives no preservation
   layer.
3. Prefer plain objects, direct property access, and ordinary TypeScript types.
   Optional semantic helpers are valid only when they add inference, defaults,
   normalization, or runtime validation. Do not make them required constructors.
4. Resources and Adapters are separate composition categories and separate
   context roots. Do not add locator APIs, dependency declarations, effect
   modes, resource selectors, or a general-purpose dependency-injection
   container.
5. Plugin code receives the complete composed context. Actions and Processors
   declare ordinary TypeScript interfaces for the narrower shape they expect.
   Missing dynamic values are handled by the plugin that needs them. There is no
   runtime `requires` declaration or context filtering.
6. Input and output schemas are optional. When present, they validate the value.
   They do not change Action lifecycle persistence or execution semantics.
7. Declarative definitions describe stable structure. Imperative code remains
   the right tool for business workflows and transaction boundaries.
8. Runtime source may never import a concrete plugin. A package composition root
   may import plugins and pass them to the runtime.
9. A plugin may depend on other plugins through `plugins: [...]`. Dependencies
   compose before the plugin that declares them.
10. Each slice must leave the repository type-correct, testable, and free of
    dead production modules.

## 3. Current-code audit

Audit date: 2026-08-22.

### 3.1 Foundations to keep

The current branch already contains several mechanisms that fit the target:

- immutable durable Events, Event Bodies, delivery obligations, retry, and
  settlement;
- graph-native Collections whose mutations automatically emit durable events;
- declared Collection content fields and automatic Asset materialization;
- Action lifecycle persistence for `invoked`, `completed`, `failed`, and
  `cancelled`, including durable input and output;
- runtime-owned BodyStore, Asset, and progressive Stream mechanics;
- processor matching and durable execution placement;
- plugin dependency composition and composable context values;
- runtime-neutral application ingress through `send` and output observation
  through `observe`;
- removal of `llm_attempt` and `tool_execution` as artificial operational
  Collections.

These are foundations, not reasons to retain their current directory or public
API shape.

### 3.2 Composition foundation has landed

`definePlugin` and the registry now compose only Collections, Actions,
Processors, Resources, and Adapters. Executable definitions use keyed maps;
Resources and Adapters use independent namespace maps. Fixed AI-specific
composition buckets and duplicated manifests have been removed.

The remaining work is physical and semantic extraction: several business plugins
still live under `runtime/`, and application assembly still exposes too much of
that transitional tree.

### 3.3 Actions are unified

`runtime/actions/` now owns Action definition, invocation, optional schema
validation, transaction context, and durable lifecycle Events. Plugins register
one Action per capability and callers use direct `context.actions.<alias>`
access. The former grouped executable module and its aliases have been deleted.

### 3.4 Context composition is runtime-neutral

Runtime context now composes unknown Resource and Adapter namespaces separately
under `context.resources` and `context.adapters`. Action and Processor
definitions carry their expected TypeScript context without runtime dependency
metadata or filtering. Both execute over one runtime-owned `RuntimeContext`.
Processors receive the resolved Event as the first argument to `handle`; it is
not injected as a context field.

`signal` and `streams` are required runtime primitives. Raw storage/database,
executor, Event, delivery, and schedule services are not plugin context. The
runtime may use those mechanisms to execute plugin work, but plugins interact
with them only through Actions, Collections, transactions, typed ingress, and
application observation.

Semantic context types still need to move beside their owning plugins as the AI
harness verticals leave `runtime/`.

### 3.5 Business plugin ownership has moved out of `runtime/`

No production semantic plugin definition remains under `runtime/`. LLM
orchestration, agent prompt policy, tool execution, and domain repositories also
live under `runtime/`.

Their semantic boundaries have started moving ahead of the physical extraction:

- schedules now use plugin-owned Actions and Processors driven by typed tick and
  manual-run ingress instead of an Engine schedule service;
- Admin derives activity from Message and Usage Collections and no longer
  exposes raw Event or delivery internals;
- Memory reads relations through Collection graph mechanics, and maintenance
  receives its source Event data explicitly rather than through a repository
  shortcut.

These are plugin business logic or plugin-owned adapters. Their current location
is not merely cosmetic: it permits runtime types and application assembly to
depend on their semantics.

### 3.6 Application assembly still knows a hidden product composition

The package root and `runtime/application/` currently construct a canonical Core
plugin plus optional built-in tools, memory, schedules, knowledge, and usage.
They expose `core`, `canonicalCore`, `toolCatalog`, `capabilities`, separate
role factories, and remnants of `connect`, `run`, attachments, and the raw
Engine.

The target application factory composes only what the caller supplies. Plugin
dependencies provide higher-level presets without making the runtime know what
“Core” means.

### 3.7 The package surface exposes the implementation tree

`deno.json` currently publishes 34 entry points, including `/engine`, `/domain`,
`/context`, `/attachments`, broad host adapters, semantic runtime modules, and
three versioned migration paths. This makes internal organization public and
prevents deletion.

The final surface should expose stable primitives, the application factory, and
deliberate plugin packages. Internal kernels and historical migration machinery
must not become permanent framework APIs.

### 3.8 Event retention and namespace rebuild are closed

Event maintenance now compacts only settled delivery obligations. Durable Events
and Event Bodies remain immutable replay and deduplication authority.
`CollectionRuntime.rebuild(namespace)` performs one atomic namespace-global
replay over all bound Collections, standalone Asset lifecycle Events, and
generic relation Events in global Event order. The former partial
Collection/relation rebuild and Event-deletion paths have been removed.

## 4. Target programming model

### 4.1 Action

An Action is one executable capability. Its context expectation is an ordinary
TypeScript interface:

```ts
interface SearchContext extends RuntimeContext {
  resources: {
    searchPolicies: Readonly<Record<string, SearchPolicy | undefined>>;
  };
  adapters: {
    search: Readonly<Record<string, SearchAdapter | undefined>>;
  };
}

const search = defineAction({
  id: "search.query",
  inputSchema, // optional
  outputSchema, // optional
  async execute(input: SearchInput, context: SearchContext) {
    const policy = context.resources.searchPolicies[input.policy];
    if (!policy) throw new Error(`Unknown search policy '${input.policy}'.`);
    const adapter = context.adapters.search[policy.adapter];
    if (!adapter) {
      throw new Error(`Unknown search adapter '${policy.adapter}'.`);
    }
    const result = await adapter.query(input);
    return result;
  },
});
```

The optional call envelope is generic runtime plumbing:

```ts
type ActionCallOptions = Readonly<{
  operationKey?: string;
  identity?: RuntimeIdentity;
  metadata?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}>;
```

Rules:

- `execute` may return any value. It is not required to return a Collection
  record.
- schemas only validate their corresponding value when supplied;
- every invocation persists input and its terminal output or normalized error;
- the runtime canonicalizes `options.metadata` once as durable data; every
  lifecycle Event Body has a required `metadata` object, using `{}` when the
  caller omits it;
- `context.action.metadata` is that same canonical invocation metadata, and a
  retry of one Action run must match both its original input and metadata;
- Action-call metadata lives only in lifecycle Event data. It is not mirrored
  into generic Event-envelope metadata, and a nested Action call receives `{}`
  unless its caller passes metadata explicitly;
- the runtime automatically emits `<actionId>.invoked`, `.completed`, `.failed`,
  and `.cancelled`;
- progress, when needed, is explicitly emitted as `<actionId>.progress` through
  `context.progress(value)` and does not require a second Action kind;
- `RuntimeContext` is the shared base; an Action that uses the lifecycle-only
  `action` identity or `progress` method may express that refinement through
  `ActionContext` without gaining another service bag;
- lifecycle Event Bodies are self-contained: terminal and progress events carry
  the invocation input alongside their output, progress value, or normalized
  error, so Processors normally need no lifecycle-history query;
- Action calls use the composed direct-access surface:
  `context.actions.search(input, options?)`;
- the declared context interface is retained as phantom generic information so
  statically known plugin/application composition can be checked by TypeScript;
- TypeScript interfaces are erased, so dynamically loaded Resources and Adapters
  are still checked by the semantic code that consumes them;
- there is no `invoke(...)` locator API and no `requires` declaration;
- there is no transaction/workflow/query mode on the definition.

### 4.2 Transaction

An Action chooses its own atomic boundaries:

```ts
await context.transaction(async (transaction) => {
  const message = await transaction.collections.messages.create({ ... });
  await transaction.collections.threads.update({
    id,
    set: { lastMessageId: message.id },
  });
  await transaction.relations.upsert({
    id: `${id}:contains:${message.id}`,
    source: { type: "thread", id },
    target: { type: "message", id: message.id },
    type: "contains",
  });
});
```

`context.transaction(...)` means “commit these graph mutations atomically,” not
“keep a SQL connection open while arbitrary user code executes.” The callback
builds an immutable mutation plan outside SQL. `transaction.collections`
contains mutation operations only; it has no `get`, `list`, or `search` API.
Planned calls return stable `{ id }` references, never speculative Collection
records. State-dependent behavior belongs in Collection commands that the
runtime evaluates once against a planning snapshot and then verifies under the
commit lock. A conflicting snapshot rejects the transaction; the runtime never
reruns developer code or a command implicitly.

The callback still closes over the complete Action or Processor context. Reads
through `context.collections` are allowed, but they are ordinary planning-time
reads and do not silently become transaction preconditions. If a decision must
be protected from a concurrent record change, it belongs in a Collection
command. This is an explicit developer contract, not hidden effect filtering or
an AsyncLocal restriction on otherwise valid Actions.

Every successful planned Collection call has one durable semantic Event
identity, including an update or command whose resulting record is unchanged.
The Event Body carries both a canonical state-independent intent—create input,
update patch, command name/input, or delete ID—and the resulting immutable
record. Raw bytes are represented in the intent only by digest and length.
Before reading a mutable record during a retry, the planner checks that call's
stable event identity; when it already exists, it validates the intent and
reconstructs the overlay/reference from the immutable Event Body. This is the
idempotency record: there is no separate transaction receipt ledger, and a
no-change call cannot turn into a new mutation after a later call in the
original batch has committed.

The same durable no-change rule applies to a standalone Collection mutation
whenever it carries a deduplication identity. A truly unkeyed local update or
command may still return a local no-op without manufacturing an Event.

The planner has one root scope and rejects nested transactions. Reusable helpers
accept the existing transaction context; an Action that owns another transaction
executes outside the root callback. Every mutation Promise is registered
synchronously and drained before the plan closes. Parallel calls get stable
invocation ordinals and commit in that order. Calls for one record or relation
serialize their planning overlays in invocation order, while disjoint keys may
prepare concurrently. Any started mutation failure aborts the root plan even if
callback code catches that Promise; partial savepoints are deliberately not part
of the contract.

`transaction.relations.upsert(...)` is the corresponding mutation-only graph
primitive for an edge that is not owned by one Collection mutation. It stages a
canonical relation intent, returns only `{ id }`, and produces the generic
durable `relation.upserted` Event in the same batch. Its metadata-only Event
Body contains the complete normalized relation, so replay can rebuild the edge
without consulting mutable graph state or guessing which Collection event owns
it.

The Event and its Event Body remain together as immutable source data. The
Event's unique deduplication identity is the retry receipt; there is no second
ledger that would make deleting it safe. Runtime maintenance compacts only
settled delivery obligations. It does not compact durable Events or Event
Bodies.

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

One schema-wide advisory read/write barrier closes the liveness race without
moving storage into SQL. Asset adoption and rebuild hold the shared side until
graph commit; physical deletion holds the exclusive side while rechecking the
indexed Ready Asset nodes. After acquiring the shared side, commit validates the
captured protection deadline in memory. It never calls an external BodyStore
from the graph transaction.

The runtime then:

1. lets the callback finish and validates the resulting plan;
2. prepares declared content and external Body bytes before opening SQL;
3. opens the graph transaction, locks the affected records, and verifies every
   planning snapshot or create-absence expectation;
4. adopts prepared Bodies and Assets;
5. commits those records with graph projections, Event Bodies, Events, and
   delivery obligations;
6. dispatches only after commit.

Retry dispatch also follows that boundary: an already-committed batch does not
republish its Events, but any still-pending durable deliveries are dispatched
again from their persisted obligations.

The callback is ordinary developer code and may call Actions or Adapters, but
those calls still execute before SQL and are not made atomic or rollbackable by
the transaction. Only the staged graph mutations are committed atomically. The
runtime never reruns the callback automatically after a commit conflict, so an
external effect is not silently repeated; the Action decides whether and how to
retry the whole operation. Keeping external calls visibly before the callback is
usually clearest, but it is a DX convention rather than a second declarative
Action mode.

### 4.3 Collection

A Collection owns state, queries, mutations, relations, and declared content:

```ts
const messages = defineCollection({
  name: "message",
  schema: messageSchema,
  content: { fields: ["content"] },
});
```

Declared content belongs only to Collection definitions. Actions merely call the
Collection API. The kernel canonicalizes content, materializes or verifies
Assets, creates ownership relations, and emits the Collection event in the same
logical mutation.

Collections do not declare `bodyRefs`, and no `body_references` table exists. A
Ready Asset node's indexed `bodyId` is the sole durable Body-liveness authority.
Asset provenance uses one opaque scope `{ type, id }`; a semantic plugin may use
`thread`, while standalone publication may use the namespace. Storage and the
kernel neither enumerate nor branch on those values.

Projection rebuild is namespace-global and receives every bound Collection
definition. In one locked transaction it clears the namespace projections and
folds durable Events in global position order. Each Collection Event restores
its historical Asset manifest before projecting that record and its derived
edges; standalone Asset and generic relation lifecycle Events fold at their own
historical positions. Starting from an empty namespace projection ensures stale
nodes and edges cannot survive.

Generic relations have an event-ordered lifecycle. `relation.upserted` makes the
relation live; deleting either endpoint removes it; recreating an endpoint alone
does not restore it. Only a later upsert does. Per-Collection destructive
rebuild is not part of the target API because an edge has two endpoints and may
be owned by another Collection or by the generic relation planner.

Scoped Collection calls keep one input object and one optional options object:

```ts
messages.create(input, options?);
messages.update({ id, set, unset }, options?);
messages.delete({ id }, options?);
messages.get({ id }, options?);
messages.list(query?, options?);
messages.search(query, options?);
```

Namespace and trusted storage scope come from the runtime scope, not mutation
input.

### 4.4 Processor

A Processor is one durable Event subscription and may declare its expected
context with the same TypeScript mechanism:

```ts
interface AnswerCompletedContext extends RuntimeContext {
  resources: {
    agents: Readonly<Record<string, AgentResource>>;
  };
  actions: {
    callLlm: ActionCaller<typeof callLlm>;
  };
}

const answerCompleted = defineProcessor<AnswerCompletedContext>({
  id: "core.answer-completed",
  on: [{ eventType: "llm.call.completed" }],
  async handle(event, context) {
    await context.transaction(async (transaction) => {
      await transaction.collections.messages.create({
        content: event.data.output.content,
      });
    });
  },
});
```

Processors receive the resolved immutable Event Body as `event.data`. The
runtime passes Actions and Processors the same complete composed context; their
declared interfaces present the narrower static view each implementation wants.
They do not declare runtime dependency aliases or requirements. The Event is the
first `handle` argument, not a context field or a general Event-query API.

Processors normally use Resources to decide what to do, then invoke Actions or
mutate Collections. They may type and access an Adapter directly, but external
operations usually belong in Actions so they receive lifecycle Events, retry
identity, and durable input/output. This is architectural guidance rather than
runtime access control.

Static durable Processors may use `eventType: "*"` only when that same clause
contains at least one non-empty plain structural matcher in `subject`, generic
Event-envelope `metadata`, or resolved `data`. Namespace, `threadId`, routing,
and visibility do not qualify by themselves; `{}` and arrays are not guards. The
canonical cross-Action lifecycle subscription is therefore guarded in the
resolved body, for example:

```ts
on: [{
  eventType: "*",
  data: {
    status: "completed",
    metadata: { schema: "copilotz.core.tool-action.v1" },
  },
}];
```

This rule permits semantic lifecycle orchestration without registering an
unbounded static catch-all. Transient observation may retain its own wildcard
rules because it creates no durable delivery fan-out.

### 4.5 Resources and Adapters

Resources and Adapters are registered separately:

```ts
definePlugin({
  id: "@acme/assistant",
  version: "1.0.0",
  resources: {
    agents: { assistant }, // Resource
    tools: { search: searchTool }, // Resource
    models: { default: model }, // Resource
  },
  adapters: {
    llm: { default: openai }, // Adapter
  },
});
```

The runtime composes each category by namespace and key and exposes only direct
property access:

```ts
context.resources.agents.assistant;
context.resources.tools.search;
context.resources.models.default;
context.adapters.llm.default;
```

There is no `resource(...)`, `resources(...)`, locator, selector, binding token,
or dependency declaration. The two composed namespace/key maps are the runtime
registries; there is no second lookup API beside the injected context.

Plain typed objects are canonical:

```ts
const model = {
  adapter: "openai",
  model: "gpt-5",
} satisfies ModelResource;
```

Equivalent helpers are optional:

```ts
const model = defineModel({
  adapter: "openai",
  model: "gpt-5",
});
```

A helper is justified only by useful inference, defaults, normalization,
branding, or runtime validation of dynamic input. It must not register the value
implicitly or produce a privileged representation that plain declarations cannot
satisfy. Cross-resource references such as a Model's Adapter name are resolved
and checked by the semantic Action that understands them; the generic runtime
does not encode those relationships.

A Tool is primarily a Resource describing how an existing Action is presented to
an LLM. It references the Action rather than carrying a second execution
implementation. An Agent is a Resource interpreted by the plugin whose
processors implement the agent loop. A Model is a Resource selecting an LLM
Adapter and configuration.

The exact Tool shape is deliberately small:

```ts
type ToolResource<TAction extends string = string> = Readonly<{
  action: TAction; // alias under context.actions
  name: string;
  description: string;
  inputSchema?: ActionSchema;
  outputSchema?: ActionSchema;
  history?: Readonly<{
    visibility?: "requester_only" | "public_status" | "public";
  }>;
  metadata?: Readonly<Record<string, unknown>>;
}>;
```

For `resources.tools.search`, the invariant is
`resource alias === tool.action === action alias`. Core validates that invariant
when building an LLM request and executes the Tool through the already-composed
`context.actions[tool.action](input, options)` function. This is ordinary direct
map access, not a locator API. `defineTool(alias, action, presentation)` may
copy the Action schemas for inference, but its result is structurally equivalent
to the plain object. A Tool has no `execute` method, host context, independent
validator, wrapper Action, catalog entry, or second lifecycle.

`resources.tools` is the complete composed Tool set; there is no second catalog
or resolver. Agent policy may select a deterministic subset of that map, but
selection never manufactures another executable definition. A model-produced
tool call invokes its Action directly with Core provenance in
`ActionCallOptions.metadata`, including the canonical discriminator
`schema: "copilotz.core.tool-action.v1"`; the resulting Action Events are the
sole durable execution record.

The provider-neutral LLM boundary follows the same reference rule:

```ts
type ModelResource<TOptions = unknown> = Readonly<{
  adapter: string; // context.adapters.llm alias
  model: string;
  mode?: "generate" | "session";
  options?: TOptions;
  fallbacks?: readonly string[]; // context.resources.models aliases
}>;

type LlmAdapter = Readonly<{
  call(input: LlmAdapterCallInput): LlmInvocation;
}>;

type LlmInvocation = Readonly<{
  frames: ReadableStream<LlmAdapterFrame>;
  result: Promise<LlmAdapterResult>;
}>;
```

The common Action boundary is provider-neutral and JSON-safe:

```ts
type LlmCallInput = Readonly<{
  model: string; // context.resources.models alias
  request: LlmRequest;
  stream?: LlmStreamDescriptor;
  inputStreamId?: string;
  options?: Readonly<Record<string, unknown>>;
}>;

type LlmCallOutput = Readonly<{
  model: string; // selected Model Resource alias
  adapter: string; // selected LLM Adapter alias
  providerModel: string;
  content: ContentSequence;
  reasoning?: ContentSequence;
  toolCalls?: readonly LlmToolCall[];
  usage?: LlmUsage;
  attempts?: readonly LlmAttemptUsage[];
  finishReason?: string;
}>;
```

`LlmAdapterCallInput`, `LlmAdapterFrame`, and `LlmAdapterResult` are the
provider-neutral normalized contracts owned by the LLM plugin. An Adapter call
returns the frame stream and final-result promise together; `llm.call` consumes
both before its own completion. Core correlation such as thread, agent,
participant, originating message, and tool-plan position is passed only through
`ActionCallOptions.metadata`; it is not part of `LlmCallInput` or LLM semantics.
Raw tokens and provider frames are Stream output, not Action progress.
`llm.call` closes/materializes those Streams and awaits final usage before
completing, so its lifecycle output contains neither a live Stream nor a
Promise.

`llm.call` resolves the requested Model Resource and Adapter, emits the one
Action lifecycle, uses `context.streams` for raw frames, and returns a fully
settled JSON-safe result containing canonical content, tool calls, usage, and
provider/model identities. Provider credentials, clients, endpoints, and
protocol quirks exist only in Adapter construction and must never enter a Model
Resource, `LlmCallInput`, Action-call metadata, or lifecycle input/output.
`llmPlugin` installs no configured model or provider; applications add every
`resources.models` value and `adapters.llm` value explicitly. Optional provider
plugins/factories are composition conveniences around the same plain Adapter
values and never install a hidden default Model or Adapter.

### 4.6 Reference AI harness

Core owns participant/thread/message Collections, the Agent Resource contract,
prompt construction, typed message ingress, and the Processors that implement
the agent loop. Its dependency is explicit and ordinary:

```ts
const corePlugin = definePlugin({
  id: "@copilotz/core",
  plugins: [llmPlugin],
  // Core Collections, Actions, Processors, and Resources
});
```

Neither plugin contributes a configured Model or LLM Adapter. The application
must provide `resources.models` and `adapters.llm`; Core resolves its selected
Agent and prompt policy, then calls `context.actions.callLlm(...)` with semantic
provenance in `ActionCallOptions.metadata`.

When `llm.call` returns multiple tool calls, Core derives one deterministic plan
from their provider order. It invokes each referenced Action sequentially with a
stable operation key and plan/call provenance in Action metadata. Retries run
the same ordered plan and recover already-terminal Action calls rather than
duplicating effects. Parallel `Promise.all` execution is not part of this
contract because tool order and preceding mutations may be semantically
significant.

A normal tool result is projected from that Action's terminal Event and the plan
continues. The Core-owned ask Action durably creates its question and completes
normally with its plugin-owned `{ status: "deferred" }` output. Core's terminal
Processor recognizes that semantic output and neither projects a result nor
advances the plan. The later answer or failure Event supplies the durable resume
trigger. The originating Action lifecycle data plus Core-owned Message metadata
must preserve the plan identity and cursor needed to resume remaining calls and
issue exactly one next `llm.call`. No Action promise stays open across that
wait; the generic runtime has no deferred settlement or Tool-executor status.

### 4.7 Plugin

The target plugin shape is:

```ts
const plugin = definePlugin({
  id: "@acme/search",
  version: "1.0.0",
  plugins: [httpPlugin],
  collections: { documents },
  actions: { search },
  processors: { indexDocument },
  resources: {
    tools: { search: searchTool },
  },
  adapters: {
    search: { default: searchAdapter },
  },
});
```

Exact composition rules:

- dependencies compose first, in declaration order;
- root plugins compose in caller order;
- executable aliases in `collections`, `actions`, and `processors` must be
  unique across the final composition;
- Resource namespaces merge by key in composition order, like object spread;
- Adapter namespaces merge independently by key in composition order;
- application Resources and Adapters are the final overlays in their respective
  categories;
- Resource and Adapter namespaces never collide with runtime-owned context
  members because they remain nested under `context.resources` and
  `context.adapters`;
- runtime identity comes from each definition's stable ID, while the map key is
  the ergonomic context alias;
- `context.collections.<alias>` and `context.actions.<alias>` are generated from
  the plugin maps;
- Processors are registered for delivery but are not exposed as a callable
  context API.

No `plugins/agents` package is implied by the presence of Agent resources.
Directories follow ownership of behavior, not names of resource kinds. The
initial Agent contract and policies belong to the Core harness plugin unless a
genuinely reusable behavioral plugin later justifies its own package.

### 4.8 Application

The public application boundary remains runtime-neutral:

```ts
const copilotz = await createCopilotz({
  plugins: [corePlugin, applicationPlugin],
  resources: {
    agents: { assistant },
    models: { default: model },
  },
  adapters: {
    llm: { openai },
  },
});

const operation = await copilotz.send(core.message({ ... }));

for await (const output of readable(copilotz.observe())) {
  // durable Events and transient Stream output
}

await operation.done;
await copilotz.close();
```

`send` accepts a runtime-neutral typed envelope. Plugins export helpers such as
`core.message(...)` for stronger semantic input types. The runtime does not know
what a message or thread is.

`core.message(...)` validates and encodes the Core ingress payload; it does not
validate downstream Resources or Adapters. Action and Processor context
interfaces type those dependencies independently.

The public application does not expose `connect`, `run`, a raw Event store,
Engine internals, an attachment service, a capability resolver, or a special
Core surface. One `createCopilotz` composition path supports the selected
deployment role through options and injected infrastructure.

`observe()` emits a generic output union. Durable graph and Action events remain
Events; live Body/Stream chunks remain transient stream observations and never
pretend to be durable Events.

Each `send` correlation sink is installed before ingress is appended. Operation
settlement waits for durable obligations, drains generic relayed execution
output, and confirms durable settlement again before closing the sink. Closing
preserves its queued Events. `observe()` is an application-wide subscription to
the same generic publish boundary; it is not implemented by teeing active
request streams or by filtering on plugin-owned thread fields.

## 5. Target ownership

The exact filenames may evolve during a vertical move, but ownership may not.

```text
runtime/
  actions/       Action definition, invocation, validation, lifecycle
  application/   createCopilotz, send, observe, close, role assembly
  collections/   graph Collection definition, query, mutation, replay
  composition/   plugin normalization and context composition
  content/       BodyStore, Asset mechanics, EventBodyStore
  events/        Events, delivery obligations, settlement, observation
  execution/     local/distributed durable Processor execution
  processors/    Processor definition, matching, consumer identity
  streams/       progressive Body production and transient observation
  persistence/   runtime-owned persistence contracts and SQL adapters
  plugins/       plugin definition contract only, if not folded into composition

plugins/
  core/
    collections/ actions/ processors/ resources/ plugin.ts
  llm/
    actions/ resources/ adapters/ plugin.ts
  tools/
    contracts.ts and concrete Action/resource integration plugins
  memory/
  knowledge/
  schedules/
    collections/ actions/ processors/ plugin.ts
    core/        optional Core message integration plugin
  skills/
  channels/
  admin/
  usage/
  goals/

server/
  transport projection over the public application boundary
```

True runtime adapters—for example SQL sessions, BodyStore backends, Event Body
storage, and execution transports—may remain runtime-owned. An adapter for an
LLM provider, a search provider, a tool host, a channel, or another semantic
contract belongs beside the plugin that defines that contract.

## 6. Implementation order

### Slice 1 — Freeze executable contracts

Implement contract tests for the exact target shapes before moving business
code:

- `defineAction` with optional `inputSchema` and `outputSchema`;
- automatic durable lifecycle input/output/error behavior;
- explicit durable progress with the same self-contained lifecycle envelope;
- typed Action and Processor context interfaces carried without runtime
  dependency metadata;
- separate Resource and Adapter maps on `definePlugin` and `createCopilotz`;
- plain-object/helper equivalence for Resource and Adapter values;
- `definePlugin` maps, dependency order, composition overlays, and duplicate
  rules;
- direct `context.actions.<alias>` and `context.collections.<alias>` access;
- complete context injection without filtering or `requires`;
- Action-selected `context.transaction(...)`;
- runtime-neutral `send`, `observe`, and `close`.

Exit: the target contracts are executable and no test encodes a deleted spec.

### Slice 2 — One Action and composition implementation (complete)

- consolidated executable definitions and durable lifecycle in the Action
  module;
- split grouped executable capabilities into individual Action definitions;
- migrated callers to direct Action aliases;
- replaced fixed plugin resource arrays with final Collection/Action/Processor
  maps plus separate Resource and Adapter maps;
- separated Processor definition and matching from composition;
- deleted the retired executable API, fixed resource-type constants, duplicated
  manifests, and `requires`;
- preserved durable Action Events and retry-stable results.

Exit: one composer, one Action invoker, one Processor registry, and no retired
executable API or fixed AI resource bucket remains.

### Slice 3 — Make context and transactions runtime-neutral (complete)

- use one runtime-neutral `RuntimeContext` for Actions and Processors, with the
  Processor Event supplied as the first `handle` argument;
- keep only composed actions, collections, resources and adapters plus generic
  transaction, content, required streams/cancellation, identity, and time
  primitives in that context;
- remove raw storage/database, executor, Event, delivery, and schedule services
  from plugin context;
- move agent/tool/LLM/API/MCP/skill/prompt types to their semantic owners;
- make `transaction.collections` mutation-only and return `{ id }` references;
- make relation upserts first-class planned graph mutations with replayable
  `relation.upserted` Events instead of attaching them to an arbitrary
  Collection mutation;
- replace Event deletion with delivery-only compaction so Event Bodies, replay,
  and deduplication identities have one lifecycle;
- replace partial Collection/relation rebuilds with one atomic namespace-global
  projection reduction over every bound Collection and all historical Asset
  manifests;
- execute the transaction callback outside SQL, prepare external content first,
  and adopt Bodies/Assets inside the atomic graph/Event/delivery commit;
- make BodyStore `put` acquire or renew Ready-Body protection and make
  maintenance deletion a state/version/idle/protection compare-and-delete for
  each Adapter that advertises Ready GC; require other Adapters to disable it;
- serialize Asset adoption/rebuild and physical deletion through one schema-wide
  advisory read/write barrier, with no external Body I/O in graph SQL;
- remove the Collection `bodyRefs` declaration and the speculative
  `body_references` table; indexed Ready Asset `bodyId` is the sole durable Body
  liveness authority;
- express schedule ticking, manual runs, and dispatch through plugin-owned
  Actions, Processors, Collections, and typed ingress;
- keep the base Schedules record generic: timing/status, opaque JSON `payload`,
  optional top-level declared `content`, and a persisted occurrence. Put the
  typed scheduled-message payload, due Processor, dispatch Action, and Tool in a
  separate Core+Schedules plugin; persisted jobs never contain an Action alias;
- keep Admin on semantic Message/Usage projections and Memory on Collection
  graph relations rather than runtime persistence shortcuts;
- delete the legacy `EventCollections` and `DomainRelationRepository` engine
  paths and the `collectionRuntime`/`relations` aliases; `CollectionRuntime`,
  exposed as `.collections`, is the sole active engine graph path. The legacy
  semantic `ConversationRepository` is also deleted; semantic projections use
  the canonical Collection surface.

Exit: adding a Resource namespace, Adapter kind, or semantic service requires no
runtime context edit, and transaction callbacks hold no SQL connection open.

### Slice 4 — Extract the AI harness as vertical plugins (complete)

The ownership evacuation, generic Action-metadata prerequisite, LLM vertical,
and Tool+Core checkpoints are closed. Admin, Channels, Knowledge, Memory,
Schedules, Skills, Usage, Goals, concrete Tool integrations, and their semantic
adapters live beneath `plugins/` without a forwarding barrel or compatibility
layer. Every Tool is a native Action paired with a data-only Resource, Core
orchestrates those Actions from durable lifecycle facts, and `runtime/` imports
no concrete plugin.

The concrete Tool-integration portion of this checkpoint is closed. Built-in,
web, finance, persistent-terminal, OpenAPI, MCP, and Deno host code now lives
only under `plugins/tools/**`, with deliberate `/tools/*` package exports. Each
Tool is a native Action plus a matching data-only Resource. OpenAPI and MCP
factories complete generation and collision checks before composition, and
applications inject the MCP stdio connector explicitly. The retired catalog,
executor, host contexts, and internal pipelines have been deleted rather than
forwarded.

The Admin and Knowledge ownership moves are also closed. Their complete
implementations, tests, and public entrypoints now live only under
`plugins/admin/**` and `plugins/knowledge/**`; the runtime has no forwarding
module and the runtime-neutral root does not re-export either optional plugin.

The Channels ownership move is closed as one vertical. Shared dispatch and
identity behavior, Web, Discord, Telegram, WhatsApp, Zendesk, their transports,
tests, and the `/channels` entrypoint now live only under `plugins/channels/**`.
The server consumes that plugin entrypoint explicitly; neither `runtime/` nor
the runtime-neutral root imports or re-exports Channels.

The Skills ownership move is closed with its host boundary intact. Portable
Skill definitions, disclosure Tools, tests, and the `/skills` entrypoint live
under `plugins/skills/**`; the Deno build packer moved with them to the explicit
`/skills/deno` entrypoint. Generic `/adapters/deno` no longer imports or exports
Skill behavior.

The Memory ownership move is closed. Collections, ontology, consolidation
Actions and Processors, tests, and the `/memory` entrypoint now live only under
`plugins/memory/**`. The shared context evidence source union is the neutral
`ContextSourceRef`; no runtime module imports Memory and the optional plugin is
not re-exported from the runtime-neutral root.

The root ownership cleanup is closed for extracted semantic packages. Core,
Goals, Usage, Schedules, Core-Schedules, Memory, Admin, Channels, Knowledge, and
Skills are available only through their explicit package subpaths. Core has one
public path, `/core`; the transitional `/plugins/core` path and every caller of
it were removed without an alias.

0. **Generic prerequisite (closed):** add canonical durable
   `ActionCallOptions.metadata`, required lifecycle `data.metadata`, and
   `context.action.metadata`; reject retry metadata drift and do not inherit
   metadata into nested calls. Replace the blanket static wildcard prohibition
   with the guarded structural rule from section 4.4. This checkpoint changes no
   AI semantics.
1. **LLM vertical (closed):** move the common `llm.call` Action, Model Resource
   and LLM Adapter contracts, provider normalization/recovery, usage output, and
   first-party OpenAI/Anthropic/Google-Gemini/Groq/DeepSeek/Ollama/MiniMax
   Adapter factories to `plugins/llm/**`. The application remains the only owner
   of configured Models, Adapters, clients, and credentials. Migrate Core's LLM
   callers to the one `llm.call` Action, make `corePlugin.plugins` include
   `llmPlugin`, and delete `runtime/llm/**`, the old Core LLM wrapper Actions
   and provider directories, and their obsolete exports before closing this
   checkpoint. This checkpoint introduced no parallel Tool execution path.
2. **Tool + Core checkpoint (closed):** make every concrete Tool an Action
   and every Tool Resource a data-only Action presentation. OpenAPI and MCP
   generate Actions plus Tool Resources, not executable Tool objects. In the
   same atomic cut, move Agent Resources and prompt policy fully into Core;
   implement deterministic sequential tool planning, the
   `schema: "copilotz.core.tool-action.v1"` lifecycle Processors, and ask
   continuation; and migrate all callers. Then remove `Tool.execute`, the
   executable Tool object type, catalog, executor, host/execution contexts,
   generic deferred result protocol, independent validation, and Core wrapper
   Actions. Also delete `runtime/tools/**`, `runtime/agents/**`,
   `runtime/context/**`, and `runtime/capabilities/**` plus their obsolete
   exports before this checkpoint closes.

Each semantic checkpoint migrates every affected production caller, test,
package export, and self-import before deleting its replaced path. No
compatibility forwarder, alias, wrapper, empty marker plugin, or temporarily
published second LLM or Tool executor is allowed.

The application explicitly selects and configures its LLM Adapters. Concrete
tools, memory, knowledge, schedules, channels, goals, usage accounting, and
admin behavior remain optional first-party plugins. Only actual Skill Resources
and their loaders belong to the Skills vocabulary.

At the end of both semantic checkpoints, `/llm`, `/tools`, and `/core` point
directly to their plugin-owned implementations; `/agents`, `/context`, and
`/capabilities` no longer exist. Do not create a mechanical Agents plugin or
retain a runtime capability resolver.

Exit: the generic runtime can run without importing or installing the AI
harness.

### Slice 5 — Finish the remaining semantic plugins

With ownership already moved in Slice 4's opening checkpoint, finish admin,
channels, knowledge, memory, schedules, skills, usage, and goals as ordinary
plugin packages using only the five primitives. For each plugin:

- move semantic types and adapters with it;
- replace repository/manager calls with Collections or Actions;
- make orchestration Processors react to durable Collection or Action events;
- delete its runtime module and old export in the same change.

Exit: no production `definePlugin(...)` call exists under `runtime/`.

### Slice 6 — Consolidate runtime mechanisms

- split `runtime/domain`: move generic graph behavior into Collections/Events,
  move semantic records to plugins, and delete obsolete repositories/managers;
- fold private attachment plumbing into generic application ingress and stream
  observation, then delete the attachment API;
- keep Asset/Body/EventBody/Stream lifecycle runtime-owned and domain-neutral;
- make every `context.streams.open(...)` emit one generic `stream.output`
  observation and keep thread, participant, routing, visibility, Collection, and
  plugin vocabulary out of the Stream contract and runtime emitter; the
  lower-level Body primitive may omit observation wiring;
- make Asset-manifest replay storage-neutral and prove that rebuilt Assets
  remain readable through database, filesystem, and object BodyStores;
- ensure Stream close yields prepared durable content that a Collection mutation
  can assetize; Streams create no semantic graph record by themselves;
- isolate physical persistence and execution transports from semantic adapters;
- enforce runtime-to-plugin import prohibition over both relative and package
  self-imports.

Exit: every remaining runtime module is justified by a generic lifecycle or
composition invariant.

### Slice 7 — Replace application assembly and public surface

- delete implicit Core and built-in plugin construction;
- make plugin dependencies the only preset/composition mechanism;
- collapse embedded/Gateway/Worker public creation into the one `createCopilotz`
  contract with explicit role/infrastructure options;
- retain only `send`, `observe`, `close`, and operation cancellation/settlement
  on the public application;
- remove public `run`, `connect`, raw `events`, Engine, attachment, capability,
  and special Core APIs;
- reduce package exports and self-imports to stable primitive and plugin
  entrypoints;
- make all production modules reachable from a deliberate export without using
  exports merely to keep obsolete code alive.

Exit: a caller can understand the public package without knowing the internal
directory tree.

### Slice 8 — Published-data migration

Only after target schemas and ownership are frozen:

- inventory the last released durable formats from `v0.60.18`, not from
  unreleased refactor code;
- `v0.60.18` never had `body_references`; final schema v4 neither creates nor
  migrates it;
- advance the final storage schema from released version 3 to version 4; normal
  provisioning must never turn a released v3 database into a partially upgraded
  final schema;
- migrate released Events, graph records, Asset nodes, BodyStore data and
  locations, and required projections;
- treat released live graph and Asset state as migration baseline authority,
  because v0.60.18 could already have compacted its non-authoritative Event
  history; synthesize final source Event Bodies rather than pretending that old
  history is complete;
- preserve any retained released Events as historical data without interpreting
  their legacy payloads as final projection-source Events;
- make the migration resumable, idempotent, verifiable by digest/count, and
  isolated from the normal runtime;
- delete historical migration entrypoints that are not part of this one release
  migration.

Exit: released durable data opens in the final runtime without a normal-runtime
fallback reader.

### Slice 9 — Documentation and release closure

- rewrite README from `ARCHITECTURE.md` and the final executable APIs;
- replace or delete stale architecture, API, resilience, and workflow documents;
- update `REPO.md` to the final tree;
- update examples and downstream contract tests;
- run the complete verification ladder and a publish dry run.

## 7. Verification ladder

Every slice runs the narrow tests it changes, then:

```sh
deno task check
deno test --allow-all --no-run
deno task test
deno publish --dry-run --allow-dirty
```

Architecture-specific closure checks must prove:

- runtime production code imports no concrete plugin;
- no production plugin implementation remains under `runtime/`;
- no fixed semantic resource kind exists in runtime composition;
- Resources and Adapters remain separate through plugin definition, application
  composition, type inference, and injected context;
- Actions and Processors receive the same runtime-neutral context, Processors
  receive their Event as the first argument, and no raw storage, executor,
  Event/delivery, or schedule service is injected;
- equivalent plain declarations and optional helpers produce values accepted by
  the same public Resource or Adapter interface;
- no retired executable API, `requires`, locator, or hidden Core path remains;
- every Collection mutation and Action lifecycle transition persists the
  expected Event Body and durable Event;
- ordinary maintenance compacts only settled deliveries and preserves Events,
  Event Bodies, and their deduplication identities;
- Action lifecycle input/output persistence is independent of schema presence;
- Action lifecycle metadata is canonical, required as `{}` when omitted,
  retry-stable, visible as `context.action.metadata`, absent from the generic
  Event envelope, and never implicitly inherited;
- a static `eventType: "*"` Processor is accepted only with a non-empty plain
  structural `subject`, Event-envelope `metadata`, or resolved `data` guard;
- Processor retries reproduce or observe one stable Action result;
- Tool Resources are data-only Action aliases, and no Tool executor, catalog,
  wrapper Action, host context, or second lifecycle remains;
- Core Tool Action lifecycle metadata uses the stable
  `schema: "copilotz.core.tool-action.v1"` discriminator;
- multi-tool plans run sequentially in stable provider order, retry without
  repeating terminal Actions, and resume ask continuations from durable data;
- `llm.call` settles its frame stream and final result before completion, while
  Models and LLM Adapters are application-configured and no credential or client
  enters durable Action data;
- Collection content fields assetize automatically;
- namespace-global replay restores all historical Asset manifests, declared
  cross-Collection edges, and live generic relations while removing stale edges;
- endpoint deletion followed by recreation does not resurrect a generic relation
  without a later `relation.upserted` Event;
- rebuilt Assets remain readable through every supported BodyStore;
- transaction planning prepares external content before SQL and adopts its
  durable records atomically with graph, Event, and delivery state;
- idempotent Body puts renew protection where Ready GC is advertised, stale
  maintenance versions cannot delete, and idle/protection guards are enforced by
  every enabled maintenance backend;
- Asset adoption/rebuild and maintenance races never commit a live reference to
  a missing Body, and graph SQL performs no external BodyStore call;
- custom BodyStore adapters declare truthful deployment guarantees, and unsafe
  Ready-Body garbage collection stays disabled;
- stream chunks are not durable Events, while settled content is durable;
- the final package surface and self-import map are exhaustive and intentional.

## 8. Immediate next slice

Slices 1 through 4 are closed. Audit and finish Slice 5's already plugin-owned
semantic verticals, then proceed to the generic runtime consolidation in Slice
6. Do not preserve a semantic repository, manager, or runtime export merely to
keep a moved plugin working.
