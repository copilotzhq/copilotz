# Copilotz First-Principles Refactor Plan

Status: proposed implementation authority, pending review.

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
10. Each slice must leave the repository type-correct, testable, and free of dead
   production modules.

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

### 3.2 Composition is still domain-shaped

`runtime/plugins/types.ts` currently defines fixed buckets for `agents`, `llm`,
`embedding`, `tools`, `skills`, `storage`, `mcp`, `api`, `channels`, and
`memoryKinds`, alongside Collections, Features, and Processors.

This makes the runtime aware of one AI harness's vocabulary. It also conflates
three different things:

- executable primitives;
- declarative Resources;
- variable Adapters.

The registry then hard-codes how those buckets become context namespaces. That
logic must disappear.

### 3.3 Actions have two identities in the code

Actions are authored as grouped `Feature` definitions in `runtime/features/`,
while their durable lifecycle is implemented in `runtime/actions/`. The runtime
and plugins therefore use both “Feature action” and “Action” for the same
primitive.

The target has one public primitive named Action and one runtime module that owns
its definition, invocation, validation, transaction context, and lifecycle.

### 3.4 Runtime context contains plugin vocabulary

`runtime/features/types.ts`, `runtime/engine/types.ts`, and related context
builders directly name agents, tools, LLM providers, APIs, MCP servers, skills,
embeddings, prompt context, domain relations, and Feature aliases.

This creates the exact coupling the plugin architecture is meant to remove.
The runtime should separately compose unknown Resource and Adapter namespaces
and preserve their inferred TypeScript shape. Semantic packages define the
concrete interfaces; Action and Processor definitions carry their expected
context types without creating runtime dependency metadata.

### 3.5 Business plugins physically live under `runtime/`

Production `definePlugin(...)` calls currently exist under runtime modules for
admin, channels, knowledge, memory, schedules, skills, tools, and Deno tools.
LLM orchestration, agent prompt policy, tool execution, and domain repositories
also live under `runtime/`.

These are plugin business logic or plugin-owned adapters. Their current location
is not merely cosmetic: it permits runtime types and application assembly to
depend on their semantics.

### 3.6 Application assembly still knows a hidden product composition

The package root and `runtime/application/` currently construct a canonical Core
plugin plus optional built-in tools, memory, schedules, knowledge, and usage.
They expose `core`, `canonicalCore`, `toolCatalog`, `capabilities`, separate role
factories, and remnants of `connect`, `run`, attachments, and the raw Engine.

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

## 4. Target programming model

### 4.1 Action

An Action is one executable capability. Its context expectation is an ordinary
TypeScript interface:

```ts
interface SearchContext extends ActionContext {
  resources: {
    searchPolicies: Readonly<Record<string, SearchPolicy>>;
  };
  adapters: {
    search: Readonly<Record<string, SearchAdapter>>;
  };
}

const search = defineAction<SearchContext>({
  id: "search.query",
  inputSchema, // optional
  outputSchema, // optional
  async execute(input, context) {
    const policy = context.resources.searchPolicies[input.policy];
    const adapter = context.adapters.search[policy.adapter];
    if (!adapter) throw new Error(`Unknown search adapter '${policy.adapter}'.`);
    const result = await adapter.query(input);
    return result;
  },
});
```

Rules:

- `execute` may return any value. It is not required to return a Collection
  record.
- schemas only validate their corresponding value when supplied;
- every invocation persists input and its terminal output or normalized error;
- the runtime automatically emits `<actionId>.invoked`, `.completed`, `.failed`,
  and `.cancelled`;
- progress, when needed, is explicitly emitted as `<actionId>.progress` through
  `context.progress(value)` and does not require a second Action kind;
- lifecycle Event Bodies are self-contained: terminal and progress events carry
  the invocation input alongside their output, progress value, or normalized
  error, so Processors normally need no lifecycle-history query;
- Action calls use the composed direct-access surface:
  `context.actions.search(input, options?)`;
- the declared context interface is retained as phantom generic information so
  statically known plugin/application composition can be checked by TypeScript;
- TypeScript interfaces are erased, so dynamically loaded Resources and
  Adapters are still checked by the semantic code that consumes them;
- there is no `invoke(...)` locator API and no `requires` declaration;
- there is no transaction/workflow/query mode on the definition.

### 4.2 Transaction

An Action chooses its own atomic boundaries:

```ts
await context.transaction(async (transaction) => {
  await transaction.collections.messages.create({ ... });
  await transaction.collections.threads.update({ id, set: { ... } });
});
```

`context.transaction(...)` means “commit these graph mutations atomically,” not
“keep a SQL connection open while arbitrary user code executes.” The callback
builds a mutation plan. The runtime then:

1. validates the plan;
2. prepares declared durable content before opening SQL;
3. opens the graph transaction;
4. commits graph projections, Event Bodies, Events, and delivery obligations;
5. dispatches only after commit.

External calls such as LLM generation or HTTP requests stay outside the
transaction unless the developer deliberately places them before or after it.

### 4.3 Collection

A Collection owns state, queries, mutations, relations, and declared content:

```ts
const messages = defineCollection({
  name: "message",
  schema: messageSchema,
  content: { fields: ["content"] },
});
```

Declared content belongs only to Collection definitions. Actions merely call
the Collection API. The kernel canonicalizes content, materializes or verifies
Assets, creates ownership relations, and emits the Collection event in the same
logical mutation.

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
interface AnswerCompletedContext extends ProcessorContext {
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
They do not declare Feature aliases or runtime dependency requirements.

Processors normally use Resources to decide what to do, then invoke Actions or
mutate Collections. They may type and access an Adapter directly, but external
operations usually belong in Actions so they receive lifecycle Events, retry
identity, and durable input/output. This is architectural guidance rather than
runtime access control.

### 4.5 Resources and Adapters

Resources and Adapters are registered separately:

```ts
definePlugin({
  id: "@acme/assistant",
  version: "1.0.0",
  resources: {
    agents: { assistant },       // Resource
    tools: { search: searchTool }, // Resource
    models: { default: model },  // Resource
  },
  adapters: {
    llm: { default: openai },    // Adapter
  },
});
```

The runtime deep-composes each category and exposes only direct property access:

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
implicitly or produce a privileged representation that plain declarations
cannot satisfy. Cross-resource references such as a Model's Adapter name are
resolved and checked by the semantic Action that understands them; the generic
runtime does not encode those relationships.

A Tool is primarily a Resource describing how an existing Action is presented
to an LLM. It references the Action rather than carrying a second execution
implementation. An Agent is a Resource interpreted by the plugin whose
processors implement the agent loop. A Model is a Resource selecting an LLM
Adapter and configuration.

### 4.6 Plugin

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
- runtime-owned context names such as `actions`, `collections`, `transaction`,
  `content`, and `stream` are reserved and cannot be contributed by a plugin;
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

### 4.7 Application

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
    actions/ resources/ adapters/ plugin.ts
  memory/
  knowledge/
  schedules/
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

### Slice 2 — One Action and composition implementation

- merge `runtime/features/` and `runtime/actions/` into the final Action module;
- split every grouped Feature action into an Action definition;
- migrate every `defineFeature`, `context.feature(...)`, Feature alias, and
  Feature registry caller directly;
- replace fixed plugin resource arrays with the final Collection/Action/
  Processor maps plus separate Resource and Adapter maps;
- move Processor definition/matching out of the plugin registry;
- delete Feature terminology, fixed resource-type constants, manifests that
  duplicate definitions, and `requires`;
- preserve the current durable Action events and retry-stable results.

Exit: one composer, one Action invoker, one Processor registry, and no Feature
API or fixed AI resource bucket remains.

### Slice 3 — Make context and transactions runtime-neutral

- replace hard-coded Action/Processor context fields with composed Resource and
  Adapter generics;
- keep only runtime primitives—actions, collections, transaction, content,
  streams, cancellation, identity, and time—in the runtime-owned base context;
- move agent/tool/LLM/API/MCP/skill/prompt types to their semantic owners;
- implement transaction planning so external content preparation occurs before
  SQL while graph/Event/delivery writes remain atomic;
- remove direct runtime domain-relation and repository conveniences that are not
  generic Collection mechanics.

Exit: adding a new resource namespace or adapter kind requires no runtime edit.

### Slice 4 — Extract the AI harness as vertical plugins

Do this vertically so each behavior moves with its definitions, implementation,
tests, and exports:

1. LLM: common `llm.call` Action, Model Resources, the LLM Adapter contract,
   first-party OpenAI/Anthropic/Google-Gemini/Groq/DeepSeek/Ollama/MiniMax
   Adapter factories, prompt/response normalization, and usage output.
2. Tools: Tool Resources that point to existing Actions, optional concrete Tool
   Actions, OpenAPI/MCP adapters, validation, and tool host implementations.
3. Core harness: participant/thread/message Collections, Agent Resources, the
   typed message ingress helper, routing Processors, message projection, prompt
   policy, and the agent loop. `corePlugin.plugins` includes `llmPlugin`; Core
   contributes no hidden configured provider.

The application explicitly selects and configures its LLM Adapters. Concrete
tools, memory, knowledge, schedules, channels, goals, usage accounting, and admin
behavior remain optional first-party plugins. Only actual Skill Resources and
their loaders belong to the Skills vocabulary.

Delete the corresponding `runtime/llm`, `runtime/tools`, `runtime/agents`,
`runtime/context`, and `runtime/capabilities` code as each vertical cutover
closes. Do not create a mechanical Agents plugin or retain a runtime capability
resolver.

Exit: the generic runtime can run without importing or installing the AI
harness.

### Slice 5 — Extract the remaining semantic plugins

Move admin, channels, knowledge, memory, schedules, skills, usage, and goals into
ordinary plugin packages using only the five primitives. For each plugin:

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
- collapse embedded/Gateway/Worker public creation into the one
  `createCopilotz` contract with explicit role/infrastructure options;
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

- inventory the last released durable formats from the release tag, not from
  unreleased refactor code;
- migrate released Events, graph records, Asset bodies and ownership,
  filesystem/object-storage locations, and required projections;
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
- equivalent plain declarations and optional helpers produce values accepted by
  the same public Resource or Adapter interface;
- no `Feature`, `requires`, `context.feature`, locator, or hidden Core path
  remains;
- every Collection mutation and Action lifecycle transition persists the
  expected Event Body and durable Event;
- Action lifecycle input/output persistence is independent of schema presence;
- Processor retries reproduce or observe one stable Action result;
- Collection content fields assetize automatically;
- stream chunks are not durable Events, while settled content is durable;
- the final package surface and self-import map are exhaustive and intentional.

## 8. Immediate next slice

Do not begin another semantic move yet. Start with Slice 1 and review its golden
contract tests as an API lock. The first implementation change after approval is
Slice 2: replace Feature/fixed-bucket composition with the one final
Action/Collection/Processor/Resource/Adapter model. That foundation determines
every later LLM, Tool, Agent, Core, and application move.
