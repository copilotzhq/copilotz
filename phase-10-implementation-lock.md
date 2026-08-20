# Phase 10 implementation lock — declarative collections, resources, plugins, and streams

Status: **simplified implementation lock; implementation not started**

Locked: 2026-08-19

Simplification review: 2026-08-19

First-principles rewrite: 2026-08-19

Repository: `lib/copilotz`

Branch context: `feat/plugin-first-event-source`

## 1. Authority and intent

This lock is incorporated by reference into the canonical
[complete-refactor handoff](plugin-first-event-sourced-refactor-handoff.md). It
is the detailed implementation contract for Phase 10 only. The handoff remains
authoritative for completed-phase facts, cross-phase ordering, Phase 11, release
gates, and the final definition of done.

The premise review is non-normative history. Earlier phases are implementation
evidence, not miniature released versions. The canonical handoff remains
authoritative for completed behavioral facts and acceptance tests; unreleased
implementation shapes survive only when this lock names them as final. When the
final design replaces code introduced on this refactor branch, the owning slice
migrates every caller and test and deletes the replaced path. It does not
preserve that path through an alias, shape adapter, dual reader, or fallback.

Phase 10 should make Copilotz easier to understand:

- Collections declare durable graph behavior.
- Features declare reusable business behavior.
- Processors declare event reactions.
- Typed resources supply adapters and other reusable capabilities.
- Plugins compose those declarations.
- The runtime executes them without knowing optional-domain names.

The first implementation task is **10A only**. No later slice starts without a
green checkpoint and explicit user approval.

## 2. Simplicity rules

These rules are normative for Phase 10:

1. **Prefer declarations to wrapper families.** A plain descriptor is preferred
   over `query(...)`, `transaction(...)`, `one(...)`, `many(...)`, or a helper
   unique to each resource type.
2. **Reuse before generalizing.** Extend the existing collection kernel, evolve
   the body-store implementation into the final `BodyStore`, and reuse the asset
   repository, plugin registry, and operation identity. Do not build parallel
   implementations.
3. **Implement vertical behavior.** A primitive is introduced with a real
   consumer and its complete proof. The same slice migrates every in-repository
   caller and deletes the superseded implementation.
4. **Keep local values local.** Live clients, credentials, sessions, closures,
   and storage paths never become portable descriptors.
5. **Do not make every concern generic.** Body durability belongs to the body
   contract. SQL transactions belong to Collections and transaction Features.
   Neither requires a universal lifecycle or placement container.
6. **Do not encode hypothetical flexibility.** No version-range solver, selector
   language, factory DAG, transitive composition fingerprint, cross-backend
   promoter, or storage-class router is added without a current consumer.
7. **One mechanism per invariant.** Assetization, including stream settlement,
   uses one kernel path. Resource resolution uses one binding path. Plugin
   selection uses one root composition path.
8. **One final API.** Do not retain an old operation name, input shape, schema,
   or protocol merely because it was implemented in an earlier refactor phase.
9. **Physical layout stays behind adapters.** A public contract describes body
   behavior, not database columns, object keys, or host paths.
10. **A slice should remove more special knowledge than it adds.** Moving a
    domain without deleting its runtime branch is not closure.
11. **Migration is not a runtime mode.** Published persisted data is translated
    by isolated migration code. Normal execution understands only the target
    model after the migration gate closes.

When two designs satisfy the same intended behavior, choose the one with fewer
concepts, fewer states, fewer public methods, and fewer retained superseded
paths.

## 3. Target architecture

### 3.1 Executable plugin resources

Copilotz has three executable plugin resource kinds:

- **Collection** — schema, relations, indexes, declared content and operational
  Body references, pure commands, named queries, graph projection, and canonical
  mutation events.
- **Feature** — reusable business policy expressed as named actions with
  declared dependencies and one execution effect per action.
- **Processor** — a durable or live reaction to events with declared
  dependencies.

A plugin is a versioned composition unit containing any combination of these
declarations and typed resource bindings. “Plugin” does not mean “optional”: an
explicitly supplied `corePlugin` is ordinary plugin composition.

### 3.2 Typed resources

Everything that is not a Collection, Feature, or Processor is either ordinary
code or a typed resource value. Examples include an LLM adapter, embedding
adapter, memory-kind implementation, conversation runner, body store, clock, or
workload handler.

Phase 10 needs only:

- one stable typed resource contract;
- one stable binding ID plus a concrete local value; and
- plain dependency declarations on Feature actions and Processors.

It does not need a generalized dependency-injection container. The code that
constructs or injects a value continues to own its lifecycle.

### 3.3 Runtime boundary

The runtime owns domain-neutral execution mechanics:

- collection transactions and event/delivery atomicity;
- namespace and invocation scope;
- IDs, clocks, cancellation, dispatch, backpressure, and byte transport;
- resource resolution and narrow context construction; and
- generic body persistence ports.

Plugins own domain semantics, including optional-domain collections, actions,
processors, retention policy, prompts, tools, and projections. Runtime
production code must not branch on `memory`, `knowledge`, `schedule`, `goal`, or
`stream` after the corresponding plugin slice closes.

### 3.4 Content, assets, bodies, and event bodies

These concepts remain separate:

- a `ContentRef` is a safe semantic reference in a record;
- an Asset is protected graph metadata for immutable semantic content;
- a Body is physical byte persistence addressed privately by the asset layer;
- an Event Body is mandatory replay data owned by the event runtime.

Collections opt into assetization declaratively with `content.fields`.
Configured database persistence synthesizes the sole kernel-infrastructure
default, `(@copilotz/body-store-adapter/v1, default)`, at lowest precedence. An
explicit application binding with that exact identity replaces it with
filesystem, S3-compatible, memory, or custom storage. No semantic plugin is
defaulted. There is no per-call enable switch, backend choice, credential, or
silent inline fallback.

Exactly one BodyStore is mandatory kernel infrastructure for every composed
application because the scoped content API is always present. Missing or
ambiguous resolution fails composition. `requires.content` controls only which
workflow actions and Processors receive a protected content handle; it does not
make physical storage optional or expose the protected contract to plugins.

Semantic asset metadata remains protected graph state managed through the kernel
asset capability. It is not a freely mutable public collection and does not
become a fourth executable resource kind. The scoped content API exposes the
small protected standalone surface defined in section 4.

Event bodies never become semantic assets. They remain SQL-transactional and
replayable even when an adapter implementation shares low-level byte code.

### 3.5 Stream, Body, and Asset

`streamId`, `bodyId`, and `assetId` identify different things:

- Stream is the semantic production session and remains a Collection plus
  Feature owned by the stream plugin.
- Body is operational byte state owned by the configured body store.
- Asset is immutable semantic content produced by successful settlement.

A Stream is not an Asset. An open Stream has no canonical content ref. A
successfully settled Stream obtains exactly one canonical asset ref through the
same declared-content path used by every other collection.

## 4. Canonical operation call contract

Phase 10 deliberately keeps one calling convention:

```ts
await context.collections.message.create({ ... }, options?)
await context.collections.message.update({ id, set, unset }, options?)
await context.collections.message.delete({ id }, options?)
await context.collections.llm_attempt.commands.complete({ id, ... }, options?)
await context.collections.message.get({ id }, options?)
await context.collections.message.queries.history({ threadId, ... }, options?)
await context.features.threadMessage.create({ ... }, options?)
```

- Every operation receives one domain args object and an optional typed
  execution-options object. An operation with no domain fields receives `{}`.
- Namespace comes only from the scoped context.
- Domain data never moves into execution options.
- Read options contain only cancellation/observation concerns. Workflow and
  transaction Feature options may additionally carry stable operation identity;
  only Collection mutations carry event-envelope metadata. No options type
  contains `namespace`.
- Feature and Processor contexts expose no raw transaction, application object,
  unrestricted registry, or undeclared dependency.
- A Collection command is a pure, synchronous one-record patch evaluator.
- A named query is a read and emits no event.
- Features own multi-collection and non-trivial reusable policy.
- Graph mutation, its immutable event body/event, ownership edges, and durable
  delivery obligations commit atomically.

Application callers obtain that scope once and select declarations by typed
reference:

```ts
const scope = await app.scope({
  namespace: "acme",
  databaseSchema: "copilotz_acme",
  principal,
});

const messages = scope.collection(messageCollection);
const threadMessages = scope.feature(threadMessageFeature);

await messages.update({ id, set }, options);
await threadMessages.create(input, options);

const prepared = await scope.content.prepare(
  { input: rawContent, idempotencyKey, origin },
  options?,
);
```

`scope.collection(definition)` and `scope.feature(definition)` are the direct
application API. They preserve the declaration's inferred types and fail if the
declaration is not in the selected composition. Internal Feature/Processor
contexts instead receive only the consumer-local aliases declared in `requires`.
There is no global Feature alias registry or unrestricted Collection map.

`scope.content.prepare({ input, idempotencyKey?, origin? }, options?)` is the
single raw-content ingress operation. Namespace comes from the scope. It returns
`PreparedContent` without making an Asset visible; a declared content mutation
performs body preflight and publication. Its second argument is `ReadOptions`. A
workflow action or Processor receives `context.content` only when it declares
`requires.content`. `"assets"` injects the high-level operations below;
`"bodies"` injects those operations plus the protected scoped `bodies` facade
defined in 9.2. Application callers never receive `bodies`; undeclared, query,
and transaction handlers receive no content handle. Transaction actions instead
use declarative `content.fields` when their input owns content.

The remaining scoped content operations are deliberately small:

```ts
await scope.content.publish({ prepared }, options?)
await scope.content.get({ assetId }, options?)
await scope.content.resolve({ ref }, options?)
await scope.content.resolveMany({ refs }, options?)
await scope.content.open({ ref, offset?, length? }, options?)
await scope.content.delete({ assetId }, options?)
```

`publish` accepts only `PreparedContent`, reuses the same BodyStore preflight,
and returns its canonical `ContentSequence`; raw input goes through `prepare`
first. It emits one `asset.created` event per newly visible Asset and is
retry-stable. `get` returns immutable Asset metadata; `resolve` returns one
bounded materialized value; `resolveMany` applies one bounded ordered parallel
resolver; and `open` returns a promised byte stream. `delete` emits
`asset.deleted`, rejects an Asset that still has owner edges, and leaves
physical Body cleanup to grace-based maintenance. Reads/open accept
`ReadOptions`; `resolveMany` accepts `ContentResolveOptions`, and publish/delete
accept `OperationOptions` on the application scope or inherit the current
workflow root inside `context.content`. Collection-owned assetization uses the
same internal kernel capability but emits only the owning Collection event.
There is no public `materialize`, `linkOwner`, Asset Collection, or raw Asset
repository.

A workflow action or Processor that declares `requires.content: "bodies"` also
receives one protected conversion operation:

```ts
type PrepareBodyInput = Readonly<{
  assetId: AssetId;
  body: ReadyBody;
  kind: ContentKind;
  role: string;
  name?: string;
  alt?: string;
  language?: string;
  disposition?: "inline" | "attachment";
  origin?: AssetOrigin;
  metadata?: Readonly<Record<string, unknown>>;
}>;

const prepared = await context.content.prepareBody({
  assetId,
  body: readyBody,
  kind: "audio",
  role: "output",
  origin,
  metadata,
});
```

`prepareBody` accepts only a protected `ReadyBody` produced by the same scoped
BodyStore. It re-verifies that ready head, returns an invocation-local
`PreparedContent` carrier with its canonical ref, and registers the metadata-
only candidate in the existing private sidecar. It writes no graph state, emits
no event, and is neither available on `scope.content` nor serializable outside
that invocation root. The next declared-content mutation consumes it. This is
the sole bridge from a Body already made ready by workflow code into ordinary
kernel assetization.

`app.scope({ namespace, databaseSchema?, principal? })` is the sole trusted
boundary for logical namespace, physical-schema selection, and invocation
authority. Application configuration may supply `databaseSchema` and a
`defaultPrincipal`; otherwise the corresponding scope field is required. There
is no implicit system principal. An embedded host may deliberately configure its
own system principal; a server authenticates a request and passes the resulting
principal through the application projection. No operation options object can
override scope or principal.

A connection may observe committed events through the same Processor descriptor
without creating durable deliveries:

```ts
await using observer = await scope.bindTransient(
  { processor: outputProcessor, afterPosition },
  options?,
);
```

Static Processors come only from selected plugins. `bindTransient` is the one
scoped observation API and returns an `AsyncDisposable` handle. Its Processor
descriptor is connection-owned, is not added to static composition, and creates
no durable delivery; its declared dependencies must resolve against the selected
composition before observation begins. The API does not expose the engine.

Attachment and one-shot ingress stay on the same scope:

```ts
await using attachment = await scope.connect(
  { thread, participant },
  options?,
);
await attachment.send({ type: "message", content, recipientIds }, options?);

await using run = await scope.run(
  { thread, participant, content, recipientIds },
  options?,
);
```

`connect` returns an `AsyncDisposable` attachment with `outputs`, `send`, and
`close`; `send` accepts typed domain/stream commands, never caller-authored
events. `run` creates a temporary attachment, sends one message, exposes
`events`, `done`, and `cancel`, and disposes the attachment. Both inherit scope
and principal. Their second argument is `OperationOptions`; a direct root call
is optional like every other operation. `/attachments` exports these handle and
input types, not a second application factory.

`connect` does not leave an invocation root ambient on its returned handle. Each
later `attachment.send(..., options?)` starts a fresh root; supplying the same
`operationKey` retries that send, while an unkeyed later send is new work. `run`
owns one root and derives its internal connect/send/settlement operations from
it, so the one-shot helper remains one retryable invocation.

## 5. Minimal declaration model

### 5.1 Feature actions

Use one effect vocabulary:

```ts
type OperationEffect = "query" | "transaction" | "workflow";

type DependencyDeclaration = Readonly<{
  collections?: Readonly<Record<string, CollectionDefinition>>;
  features?: Readonly<Record<string, AnyFeatureDefinition>>;
  resources?: Readonly<Record<string, ResourceRequirement<unknown>>>;
  content?: "assets" | "bodies";
}>;

type ContentDeclaration = Readonly<{ fields: readonly string[] }>;

type DependenciesFor<E extends OperationEffect> = E extends "workflow"
  ? DependencyDeclaration
  :
    & Omit<DependencyDeclaration, "content">
    & Readonly<{ content?: never }>;

type ActionCallInput<
  S extends JsonSchema,
  C extends ContentDeclaration | undefined,
> = C extends ContentDeclaration
  ? WithDeclaredContent<FromSchema<S>, C["fields"], DurableContentInput>
  : FromSchema<S>;

type CanonicalActionInput<
  S extends JsonSchema,
  C extends ContentDeclaration | undefined,
> = C extends ContentDeclaration
  ? WithDeclaredContent<FromSchema<S>, C["fields"], ContentSequence>
  : FromSchema<S>;

type FeatureAction<
  S extends JsonSchema,
  E extends OperationEffect,
  R extends DependenciesFor<E>,
  C extends ContentDeclaration | undefined,
  TOutput,
> = Readonly<{
  input: S;
  effect: E;
  requires?: R;
  content?: E extends "transaction" ? C : never;
  execute(
    input: CanonicalActionInput<S, C>,
    context: FeatureContext<R, E>,
  ): TOutput | Promise<TOutput>;
}>;

type ErasedFeatureAction = Readonly<{
  input: JsonSchema;
  effect: OperationEffect;
  requires?: DependencyDeclaration;
  content?: ContentDeclaration;
  execute: (...args: never[]) => unknown;
}>;

type FeatureActionMap = Readonly<Record<string, ErasedFeatureAction>>;

type FeatureDefinition<TActions extends FeatureActionMap> = Readonly<{
  id: string;
  actions: TActions;
}>;

type AnyFeatureDefinition = FeatureDefinition<FeatureActionMap>;
```

The descriptor is data. `defineFeature()` infers each action's input from its
existing JSON Schema vocabulary, its output from `execute`, and its context from
`requires` plus `effect`. Do not add one wrapper function per effect or maintain
a second handwritten domain validator. `WithDeclaredContent` is the one
framework mapped type used by Collection, command, and Feature declarations,
including declared dot paths. The public invoker receives
`ActionCallInput<S, C>`: declared content paths accept `DurableContentInput`,
preflight replaces them with canonical `ContentSequence`, and `execute` receives
`CanonicalActionInput<S, C>`. Other domain input is JSON-schema representable.
Live clients, streams, signals, and closures arrive through declared resources,
execution options, or returned handles—not embedded in action input.
`defineFeature()` also runtime-rejects `requires.content` on query or
transaction actions; only workflow actions and Processors may request that
protected handle.

Validation has one schema and one order. The invocation boundary first verifies
that each declared carrier is `ContentSequence | PreparedContent`, extracts its
canonical refs without body I/O, and substitutes those refs. It then validates
the resulting `CanonicalActionInput` against `S`, performs BodyStore preflight,
and only then calls `execute`. `PreparedContent` itself is never validated as if
it were `ContentSequence`, and no second domain schema exists. Collection and
command inputs use the same order.

- `query` opens no write transaction and may call query actions and reads.
- `transaction` opens or joins one short same-namespace SQL transaction and may
  call query or transaction actions.
- `workflow` has no ambient SQL transaction and may call any action. Each
  mutation it invokes is a short query/transaction action.

A query cannot mutate. A transaction cannot call a workflow or perform provider
calls, sleeps, body pumping, or other unbounded/external work. A workflow never
carries a transaction across a wait.

Those restrictions shape the injected types as well as runtime validation:

| Action effect | Collection handles         | Feature handles             | Content handle | Resources       |
| ------------- | -------------------------- | --------------------------- | -------------- | --------------- |
| `query`       | reads and named queries    | query actions               | no             | query-safe only |
| `transaction` | reads, commands, mutations | query + transaction actions | no             | query-safe only |
| `workflow`    | all declared operations    | all declared actions        | declared only  | all declared    |

Processors receive workflow-capable handles for exactly their declarations. They
still perform each graph mutation through a short Collection or
transaction-Feature call.

`content.fields` on a transaction action declares input paths to preflight
before SQL. It reuses the same path extractor as Collection content. It is not a
second content system.

For the one-time source rewrite:

- every action gains one JSON Schema for its domain input;
- `mode: "read"` becomes `effect: "query"` for every plain action;
- absent mode or `mode: "write"` becomes `effect: "transaction"`.

10A rewrites every in-repository Feature definition and deletes runtime support
for the resource-wide `mode` and raw-action shape. There is no normalizer and no
old/new selectable path. Cancellation uses the invocation `AbortSignal`;
returned long-lived handles use standard `AsyncDisposable` semantics. Phase 10
does not add a custom handle-lifecycle framework.

Nested operation identity reuses the existing parent/child operation-key
composition. The callee Feature/action ID is included automatically. Repeated
sibling calls require an explicit stable suffix; completion order is never an
identity.

### 5.2 Typed resource contracts and bindings

The target is intentionally small:

```ts
declare const resourceValue: unique symbol;

type ResourceAccess = "plugin" | "runtime-protected";

type ResourceContract<
  T,
  A extends ResourceAccess = "plugin",
> = Readonly<{
  readonly [resourceValue]: T;
  id: string;
  effect: "query-safe" | "workflow-only";
  access: A;
}>;

type ResourceBinding<
  T,
  A extends ResourceAccess = "plugin",
> = Readonly<{
  contract: ResourceContract<T, A>;
  id: string;
  value: T;
}>;

type ResourceRequirement<T> = Readonly<{
  contract: ResourceContract<T, "plugin">;
  binding?: string;
  cardinality?: "one" | "optional" | "many";
}>;

type PluginResourceBinding<T> = ResourceBinding<T, "plugin">;
type ApplicationResourceBinding<T> = ResourceBinding<T, ResourceAccess>;
```

The one generic `defineResource<T>(...)` constructor supplies the type-only
brand and `access: "plugin"`; plugins do not hand-author contract objects. The
runtime-internal `defineProtectedResource()` constructor supplies
`access: "runtime-protected"` for kernel ports such as the BodyStore adapter. It
is not exported as a plugin-authoring API. A protected contract may be bound
only by the application layer and cannot appear in `ResourceRequirement` or
`PluginDefinition.bindings`; both the types and composer reject it.

A breaking contract revision uses a different stable ID, for example
`@copilotz/embedding/v2`. Phase 10 adds no version-range negotiation.

Contract effect is cohesive:

- `query-safe` resources perform no durable mutation, external/unbounded work,
  or wait and may be supplied to any action or Processor;
- `workflow-only` resources are supplied only to workflow actions and
  Processors.

A mixed service is split into cohesive contracts. SQL-coupled mutation belongs
in a Collection, transaction Feature, or internal kernel port—not a generic
resource effect.

Cardinality is plain data:

- `one` is the default and resolves exactly one binding;
- `optional` resolves zero or one;
- `many` resolves one or more in effective declaration order.

The injected shapes are exact:

```ts
type BoundResource<T> = Readonly<{ id: string; value: T }>;

// one     -> T
// optional -> T | undefined
// many    -> readonly BoundResource<T>[]
```

`many` retains binding IDs because policy such as Agent-selected LLM routing
needs stable identity without a locator. An exact `binding` selector applies to
`one` or `optional`, not `many`.

An exact binding ID is the only Phase 10 selector. There are no selector
expressions, min/max ranges, version-constraint solvers, or dynamic fallback.

Binding values are already-constructed local values. The application/host that
constructs a lifecycle-bearing value also disposes it; composition only injects
it. Only contract and binding IDs may enter portable descriptions; values,
secrets, closures, sessions, and paths may not. Within one composition, a
contract ID must refer to the same canonical exported `ResourceContract` object.
A distinct object reusing that ID fails even when its effect agrees; the phantom
value type must never be trusted by string equality alone. IDs remain the
portable description. Binding uniqueness and override identity are
`(contract.id, binding.id)`.

### 5.3 Dependency declarations and context

Every Feature action and Processor declares aliases as plain data:

```ts
requires: {
  collections: {
    messages: messageCollection,
    threads: threadCollection,
  },
  features: {
    threadMessage: threadMessageFeature,
  },
  resources: {
    embeddings: {
      contract: embeddingV1,
      binding: "default",
    },
  },
}
```

Declaration references preserve inferred types. Runtime/portable descriptions
store only the referenced Collection name, Feature ID, resource-contract ID, and
optional binding ID—not imported code or values.

The invocation receives only those aliases through `context.collections`,
`context.features`, and `context.resources`. Features additionally receive
namespace, operation identity, retry-stable external `idempotencyKey`,
principal, signal, and applicable correlation/causation. Processor context adds
delivery and settlement state. Its immutable event remains the first `handle`
argument and is not duplicated on context.

Workflow actions and Processors receive the runtime-owned scoped
`context.content` handle defined in section 4 only through their literal
`requires.content` declaration. This protected dependency is resolved by the
composer but is not a public `ResourceRequirement` or locator; query and
transaction actions do not receive it.

The declaration is the Feature action or Processor's maximum internal
delegation. The runtime authorizes the entry, scopes handles to the invocation
namespace, and carries the same principal into nested calls. Each callee
receives its own declared dependencies. Contract-specific authorization remains
with the contract or existing capability resolver.

For static Processors, the durable delivery carries only a stable `principalRef`
needed by the capability resolver—not a credential or live value. Delivery
creation stamps that opaque runtime-owned field from the trusted scope
principal; caller identity/options/event metadata cannot set it. Child
deliveries inherit it unless a separately authorized boundary deliberately
changes principal. A worker resolves it locally before constructing context. A
missing or revoked principal fails authorization; it never falls back to an
implicit system principal. Transient processors use the live scope principal and
create no durable `principalRef`.

Concretely, the durable delivery contract adds
`principalRef: PrincipalReference` and its SQL row adds non-null
`principal_ref`. The field is written in the same transaction as the delivery,
is copied by retry/lease operations without reinterpretation, and is an input to
the worker's existing capability resolver before handler construction. It is
runtime invocation state, not part of `DurableEvent` or its Event Body.

Shared dependency objects may be ordinary constants/spreads. Do not add a
framework merge or inheritance API.

Do not add delegation-token algebra, authority-aware provider reselection, a
global resource locator, a global Feature map, or an unconditional collection
map to ordinary invocation contexts.

A migrated definition may depend only on real typed contracts. If it still needs
a fixed-bucket value, the owning slice defines the target contract, migrates its
providers and consumers, and removes that bucket path. Do not wrap a fixed
bucket in a temporary contract or create a second lookup path.

### 5.4 Composition

Composition has two simple passes:

1. collect declarations and static bindings from supplied plugin values, add the
   one synthesized database BodyStore infrastructure binding at lowest
   precedence, then append explicit application bindings;
2. apply stable binding override precedence, resolve requirements, and reject
   missing, ambiguous, or effect-invalid matches.

Requirements are references, not constructors. Do not build a constructor DAG,
scope cache, capture matrix, reverse-disposal graph, or generalized composition
fingerprint.

Semantic composition accepts concrete plugin values and concrete bindings only.
The package root passes both once to the composer; it does not install a hidden
core set, expand first-party shorthand, accept string plugin sources, or resolve
modules. The database BodyStore described above is the only synthesized binding,
not a plugin selection. Applications that load code dynamically do so in host
code and pass the resulting plugin value normally.

Plugin IDs are globally unique and duplicates fail. Executable declaration IDs
must be unique within their kind after plugin selection. Binding replacement
uses only `(contract.id, binding.id)`. Omission means only that a plugin is not
selected; a still-selected dependent with a missing requirement fails
composition.

Effective binding order is deterministic: supplied plugin order, declaration
order inside each plugin, then explicit application-binding order. The first
occurrence of a tuple fixes its position; a later occurrence with that tuple
replaces only its value. No priority field or capability-specific precedence
rule exists.

A plugin is an atomic composition unit. Phase 10 removes partial resource
imports and presets. If two selections are independently useful, define two
plugins or let one explicit plugin factory select its declarations. The composer
does not prune or infer dependency closures.

Distributed work continues to use explicit versioned workload/protocol IDs.
Phase 10 does not add a hash of the transitive composition graph.

### 5.5 Declared Collection content

```ts
content: {
  fields: ["content", "run.content"];
}
```

means:

- each declared value accepts `DurableContentInput`, which is exactly
  `ContentSequence | PreparedContent`;
- each declared content field in the stored record and Collection Event Body
  contains only a canonical `ContentSequence`; the Event Body may additionally
  carry the metadata-only Asset replay manifest defined in 9.3;
- the kernel materializes or verifies Assets;
- ownership edges derive from the final stored record; and
- composition requires the protected asset catalog and default body store.

Raw `ContentInput` such as strings or bytes is prepared at ingress first.
Prepared bytes, locators, credentials, and storage handles never enter records,
events, or deliveries.

Field semantics remain:

- omitted create values follow schema/default behavior;
- omitted update fields preserve their current value;
- `set` replaces a value after canonicalization;
- `unset` uses the existing top-level patch semantics and then schema
  validation;
- `null` is invalid;
- `[]` is an explicit empty sequence;
- duplicate refs produce one ownership edge; and
- removing one owner never deletes a still-shared body synchronously.

Dot paths such as `run.content` declare discovery in the final record. Phase 10
does not turn `unset` into a new nested-path mutation language: callers replace
the parent object or use a pure Collection command.

A Collection command that accepts prepared content declares its input paths on
the command descriptor with the same shape:

```ts
commands: {
  complete: {
    input: completeSchema,
    content: { fields: ["content"] },
    mutate,
  },
}
```

The kernel keeps one private per-attempt Asset-candidate sidecar. In 10C a
candidate contains prepared bytes or a verified external body head. In 10D5 the
same internal shape receives a verified sealed Body head through the protected
`prepareBody` operation in section 4. This is an internal union, not another
public content type or persistence protocol.

### 5.6 Operational Body references

A Collection that stores an operational Body ID declares its liveness fields:

```ts
bodyRefs: {
  fields: ["bodyId"];
}
```

This is not assetization. A declared field stores an optional branded `BodyId`,
not a `ContentRef`, and never causes body bytes, chunks, or locators to enter a
record or event. Presence in the final record means that record currently pins
the Body against physical cleanup; omission means it does not.

The reducer projects final declared values into the protected, rebuildable
`body_references` table in the same graph transaction as the node, event, and
deliveries. It derives rows from the final record, never the incoming patch.
Protected Asset metadata projects its Body through the same table. Update and
replay use the same deterministic projection; delete projects zero live
references even though its Event Body retains the final deleted record for
authority. These rows carry no writer token, receipt, hold, adoption state, or
event of their own.

This one declaration lets generic maintenance prove liveness without knowing a
Collection or plugin name. Phase 10 adds it only for the current Stream need; it
does not invent a general physical-reference language.

Any Body that must outlive the invocation that created it must become referenced
by protected Asset metadata or a declared `bodyRefs` field before its
store-clock protection expires. Otherwise it is intentionally an orphan and
becomes eligible for generic grace-based cleanup.

## 6. Target source and code shape

This section is normative. Phase 10 is not complete because declarations work
while the old ownership tree remains beside them. The source tree, imports,
exports, declarations, and invocation patterns must all express the same model.

### 6.1 Phase 10 closure tree

```text
lib/copilotz/
├── index.ts
├── create-copilotz.ts
├── deno.json
├── dependencies/         # Audited external dependency facades only
│
├── runtime/
│   ├── application/       # Embedded/Gateway/Worker assembly over composed input
│   ├── engine/            # Private domain-neutral kernel assembly
│   ├── plugins/           # Plugin validation, selection, precedence, composition
│   ├── resources/         # defineResource and generic binding resolution only
│   ├── collections/       # Definition, query, transaction, reducer, replay
│   ├── features/          # Definition, effects, narrow invocation
│   ├── processors/        # Definition, matching, durable/transient invocation
│   ├── events/            # Events, EventBodyStore, deliveries, settlement, replay
│   ├── content/           # ContentRef, protected Assets, BodyStore, resolution
│   ├── execution/         # Oxian workload protocols and placement
│   ├── attachments/       # Generic persistent ingress and transient observation
│   ├── capabilities/      # Principal and agent authority
│   ├── adapters/          # Implementations of runtime-owned contracts only
│   ├── testing/           # Unpublished shared conformance fixtures
│   └── tokens/            # Ordinary runtime-neutral token utilities
│
├── plugins/
│   ├── core/              # Conversation graph and orchestration
│   ├── agents/            # Agent definitions, prompt/context policy
│   ├── llm/               # LLM Feature/contract and adapter factories
│   ├── embedding/         # Embedding Feature/contract and adapter factories
│   ├── tools/             # Tool Feature/contracts; API and MCP adapters
│   ├── skills/            # Skill declarations and loading policy
│   ├── channels/          # Channel Features, Processors, transport contracts
│   ├── admin/             # Admin Features and projections
│   ├── usage/
│   ├── knowledge/
│   ├── memory/
│   ├── schedules/
│   ├── streams/
│   └── goals/
│
├── server/                # Internal Fetch projection over ApplicationProjection
├── contracts/             # Package and cross-boundary acceptance contracts
├── docs/
└── scripts/
```

Directories are responsibilities, not a template checklist. Omit an empty
directory. A two-file plugin stays a two-file plugin.

At Phase 10 closure these superseded ownership paths are absent:

```text
runtime/admin/
runtime/agents/
runtime/channels/
runtime/context/
runtime/domain/
runtime/goals/
runtime/knowledge/
runtime/llm/
runtime/memory/
runtime/schedules/
runtime/skills/
runtime/streams/
runtime/tools/
runtime/usage/
plugins/core/resources/
utils/
runtime/cli.ts
runtime/http.ts
runtime/thread-metadata.ts
runtime/application/public.ts
runtime/adapters/module-plugin-resolver.ts
```

Moving code is not sufficient. Each owning slice migrates imports and tests,
removes the old application/engine construction branch, and deletes the old
directory before it closes.

### 6.2 Ownership and import direction

```text
runtime mechanisms  X--> concrete plugins
plugins             ---> exported runtime contracts
caller plugin values ---> package root ---> runtime application
server              ---> application projection contract
Phase 11 migration  ---> isolated old-schema readers + target schema writers
```

The rules are exact:

- `runtime/**` never imports `plugins/**` or branches on a plugin/domain name.
- A plugin imports Copilotz through public package subpaths, as an external
  plugin would. It never imports `/engine`, application assembly, SQL sessions,
  another plugin's implementation, or private runtime files.
- A plugin consumes another capability through an exported Collection/Feature
  declaration reference or typed resource contract—not by importing that
  plugin's handler, adapter, or private implementation.
- `create-copilotz.ts` is the sole public composition entry. Concrete
  first-party plugins are explicit values in the caller's `plugins` list; no
  runtime module imports or installs them implicitly.
- `runtime/application/**` accepts an already composed plugin/binding input and
  infrastructure options. It knows no `CreateMemoryPluginOptions`, knowledge,
  schedule, channel, goal, or similar domain configuration type.
- `runtime/adapters/**` implements runtime-owned infrastructure contracts only.
  A Deno/Node/browser adapter for a Tool, Skill, Channel, LLM, or other semantic
  contract lives with that plugin even though it uses a host API.
- `server/**` projects the narrow internal `ApplicationProjection` into Fetch.
  It does not reach into engine assembly or plugin internals and is not a second
  public application factory.
- Phase 11 `migration/**` may read a named published schema and write the final
  schema. Normal runtime modules never import it.

The gateway seam is one narrow internal contract in
`runtime/application/projection.ts`. Application assembly returns the public
scoped application plus an `ApplicationProjection` that can create a trusted
scope from `{ namespace, databaseSchema, principal }` and, within that scope,
invoke a selected Collection/Feature by stable ID, use content/attachment/run,
and bind transient event observation. Only transport adapters receive this
ID-based projection; ordinary application callers and plugins do not. It uses
the same composed declarations and invocation paths as the typed selectors, not
a second registry or mutation API.

The import graph is exact:

```text
create-copilotz.ts -> runtime/application/assemble.ts
create-copilotz.ts -> server/create-fetch.ts
server/create-fetch.ts -> runtime/application/projection.ts (contract only)
runtime/application/** X-> server/**
```

For Gateway role, the root passes the projection returned by assembly into the
server Fetch factory. Authentication/schema resolution occurs at that boundary
before `ApplicationProjection.scope` is called.

```ts
type ResolvedRequestScope = Readonly<{
  namespace: string;
  databaseSchema?: string;
  principal?: Principal;
}>;

type ResolveRequestScope = (
  input: Readonly<{ request: Request }>,
) => ResolvedRequestScope | Promise<ResolvedRequestScope>;
```

Every Gateway configuration supplies `resolveRequestScope`; a trusted
single-tenant host may pass a constant resolver. The resolver is the request
authentication boundary. Assembly applies explicitly configured schema/principal
defaults, then rejects a missing namespace, physical schema, or principal
according to section 4; it never invents a system principal or reads authority
from operation options.

The boundary checker enforces these directions, including rejection of plugin
imports from `@copilotz/copilotz/engine` or private application modules. It
allows declaration/contract imports only through deliberate semantic public
subpaths.

### 6.3 Canonical plugin directory

```text
plugins/<name>/
├── index.ts              # Deliberate public exports; no side effects
├── plugin.ts             # One composition declaration or factory
├── collections/          # Only Collections owned by this plugin
├── features/             # Only Features owned by this plugin
├── processors/           # Only Processors owned by this plugin
├── contracts.ts          # Optional typed resource contracts this plugin defines
├── adapters/             # Optional concrete implementations shipped here
├── types.ts              # Optional public domain types
├── <named-policy>.ts     # Optional pure business logic with a precise name
└── *.test.ts             # Co-located unit and plugin acceptance tests
```

Do not create empty folders. Do not create default `services/`, `managers/`,
`repositories/`, `providers/`, `container/`, or generic `utils.ts` layers.
Recurring persistence reads are named Collection queries. Multi-record policy is
a Feature. External reaction is a Processor. Adapter code implements a typed
contract. Small pure helpers are named for the business rule they implement.

Use `contracts.ts` while the contract surface is small; replace it with a
`contracts/` directory only when several cohesive contract modules genuinely
need separate files.

`plugins/core/resources/` is deleted. Everything inside a plugin is already a
plugin contribution, while `resource` now has the precise meaning in 5.2.

### 6.4 Collection declaration and API

One file normally owns one Collection declaration. The schema is the record
validator and inferred-type source.

```ts
export const documentCollection = defineCollection({
  name: "knowledge_document",
  schema: documentSchema,
  indexes: [
    { fields: ["contentHash"], unique: true },
    ["status", "updatedAt"],
  ],
  relations: {
    thread: relation.belongsTo("thread", "threadId", "has_document"),
  },
  content: { fields: ["source"] },
  commands: {
    complete: {
      input: completeDocumentSchema,
      content: { fields: ["source"] },
      mutate({ current, input }) {
        if (current.status !== "pending") {
          throw new Error("Only a pending document can complete.");
        }
        return {
          set: {
            status: "indexed",
            source: input.source,
            chunkCount: input.chunkCount,
          },
        };
      },
    },
  },
  queries: {
    byHash: {
      input: documentByHashSchema,
      filter({ input }) {
        return { contentHash: input.contentHash };
      },
    },
  },
});
```

The scoped invocation API is:

```ts
await documents.create({ id, threadId, source }, options?)
await documents.update({ id, set, unset }, options?)
await documents.delete({ id }, options?)
await documents.get({ id }, options?)
await documents.list({ where, order, after, limit }, options?)
await documents.search({ text, limit }, options?)
await documents.commands.complete({ id, source, chunkCount }, options?)
await documents.queries.byHash({ contentHash }, options?)
```

Commands are synchronous pure one-record patch evaluators. Queries are reads.
Neither receives a resource, another Collection, a Feature, a clock, an ID
factory, or a live runtime context. `defineCollection()` validates and freezes
the descriptor; callers do not surround it with freeze ceremony.

Command and named-query inputs are inferred from their required `input` schemas;
an operation with no fields uses the shared empty-object schema. Create/select
types are inferred from the Collection schema. Update `set`/`unset` accept only
mutable record fields: never `id`, `namespace`, or kernel timestamps. `unset`
remains limited to mutable top-level keys.

The shared `WithDeclaredContent` mapping from 5.1 applies to Collection create,
update, and command call types. Public declared paths accept
`DurableContentInput`; hooks, command `mutate`, stored records, and event bodies
see only canonical `ContentSequence`. Named queries have no content transform.

The returned declaration also exposes typed immutable event match references:

```ts
documentCollection.events.created;
documentCollection.events.updated;
documentCollection.events.deleted;
```

They carry the canonical event type and record-body type for Processor
inference; they do not create additional event names or dispatch paths.

### 6.5 Feature declaration and API

`defineFeature()` validates and freezes one static definition. Effects and
dependencies belong to each action, never to the Feature as a whole.

```ts
const createMessageRequires = {
  collections: {
    messages: messageCollection,
    threads: threadCollection,
    participants: participantCollection,
  },
} as const;

export const threadMessageFeature = defineFeature({
  id: "copilotz.core.thread-message",
  actions: {
    create: {
      input: threadMessageInputSchema,
      effect: "transaction",
      requires: createMessageRequires,
      content: { fields: ["content"] },
      async execute(input, context) {
        const { messages, threads, participants } = context.collections;
        const thread = await threads.get({ id: input.threadId });
        const sender = await participants.get({ id: input.senderId });
        if (!thread || !sender) throw new Error("Unknown thread or sender.");
        return await messages.create({
          id: input.id,
          threadId: input.threadId,
          senderId: input.senderId,
          recipientIds: input.recipientIds,
          content: input.content,
          metadata: input.metadata ?? {},
        });
      },
    },
  },
});
```

`id` is the Feature's only global identity. Consumer-local names come from the
keys in `requires.features`; there is no second global alias registry. A caller
uses the alias it declared:

```ts
await context.features.threadMessage.create({ ...domainArgs }, options?)
```

The second argument of `execute(input, context)` is injected context, not a
second caller-supplied args object. The context contains only declared aliases
and the invocation facts listed in 5.3.

### 6.6 Processor declaration and API

One Processor is one independent reaction and therefore has one top-level
dependency declaration.

```ts
type ProcessorEvent<TData = unknown> =
  & DurableEvent
  & Readonly<{ data: DeepReadonly<TData> }>;

type ProcessorDefinition<
  TEvent extends ProcessorEvent = ProcessorEvent<unknown>,
  R extends DependencyDeclaration = {},
> = Readonly<{
  id: string;
  on: readonly EventMatch<TEvent>[];
  settlement?: "inherit" | "detached";
  requires?: R;
  handle(event: TEvent, context: ProcessorContext<R>): void | Promise<void>;
}>;

type AnyProcessorDefinition = ProcessorDefinition<
  ProcessorEvent<unknown>,
  DependencyDeclaration
>;
```

`defineProcessor()` infers `TEvent` from typed Collection event references in
`on`. The executor resolves and verifies `dataRef` once before matching or
handling, so the typed reference carries `ProcessorEvent<TCanonicalBody>` and a
raw envelope matcher falls back to `ProcessorEvent<unknown>`.
`AnyProcessorDefinition` is the explicit erased registry/plugin storage type; it
never contextually types an author's descriptor. `AnyFeatureDefinition` serves
the same storage-only role for Features. `defineFeature()` and
`defineProcessor()` retain each concrete declaration's exact inferred type, and
authors never write generic arguments.

```ts
export const indexDocumentProcessor = defineProcessor({
  id: "copilotz.knowledge.index-document",
  on: [documentCollection.events.created],
  settlement: "inherit",
  requires: {
    collections: {
      chunks: chunkCollection,
    },
    features: {
      embeddings: embeddingFeature,
    },
  },
  async handle(event, context) {
    const document = event.data.record;

    const result = await context.features.embeddings.embed({
      texts: [document.text],
    });

    await context.collections.chunks.create({
      id: `${document.id}:0`,
      documentId: document.id,
      embedding: result.embeddings[0],
    });
  },
});
```

`handle(event, context)` keeps immutable event authority distinct from injected
dependencies; context does not contain a second copy of the event. Processors
are at-least-once. A workflow Feature that calls an external adapter propagates
the supplied retry-stable `context.idempotencyKey`. Processors return neither
replacement events nor global-chain control values.

### 6.7 Resource contract, adapter, and binding

A capability-defining plugin owns its semantic contract. Adapter modules export
factories; the application owns lifecycle-bearing concrete values and their
bindings. A plugin may contribute static binding values with no owned lifecycle.

```ts
export type EmbeddingAdapter = Readonly<{
  embed(
    input: Readonly<{
      texts: readonly string[];
      model?: string;
      dimensions?: number;
      signal: AbortSignal;
      idempotencyKey: string;
    }>,
  ): Promise<EmbeddingResult>;
}>;

export const embeddingAdapterV1 = defineResource<EmbeddingAdapter>({
  id: "@copilotz/embedding-adapter/v1",
  effect: "workflow-only",
});

const embeddingBinding = {
  contract: embeddingAdapterV1,
  id: "default",
  value: createOpenAIEmbedding({ apiKey }),
} satisfies ResourceBinding<EmbeddingAdapter>;
```

Do not add `defineEmbeddingProvider`, `bindEmbedding`, `registerEmbedding`, or a
constructor per capability. The binding is plain data. The application/host that
constructs a lifecycle-bearing value also disposes it; composition only injects
that already-constructed value. A contract file contains no credentials,
session, path, client instance, or environment lookup.

`runtime/resources/` owns only `defineResource`, the generic types in 5.2, and
resolution. It is not a mirror of every semantic contract. `BodyStore` remains
in `runtime/content/` because it is a runtime asset/body mechanism. Contracts
such as LLM adapter, embedding adapter, agent definition, tool, skill,
conversation runner, and channel transport live with the plugin that defines
their semantics and are re-exported through that capability's public subpath.

### 6.8 Plugin declaration and composition

The public authoring shape is flat and declares each value once:

```ts
export const knowledgePlugin = definePlugin({
  id: "@copilotz/knowledge",
  version: "0.61.0",
  collections: [documentCollection, chunkCollection],
  features: [knowledgeFeature],
  processors: [indexDocumentProcessor],
});
```

```ts
type PluginDefinition = Readonly<{
  id: string;
  version: string;
  collections?: readonly CollectionDefinition[];
  features?: readonly AnyFeatureDefinition[];
  processors?: readonly AnyProcessorDefinition[];
  bindings?: readonly PluginResourceBinding<unknown>[];
}>;
```

`definePlugin()` validates and freezes once, derives introspection metadata,
rejects duplicate IDs, and returns the canonical plugin value. Authors do not
maintain `manifest.provides` beside the actual declarations. `manifest.ts` and
the `{ manifest, resources }` authoring shape are deleted after every plugin is
source-migrated. There is no runtime normalizer for that removed shape.

Use a constant when composition is static. Use one `createXPlugin(options)`
factory only when options genuinely select declarations or bind plugin policy.
It may accept an already-constructed adapter value, but it creates a value only
when that value has no owned lifecycle. Do not wrap a static plugin in a
factory.

The root composition API is:

```ts
const app = await createCopilotz({
  role: "embedded",
  plugins: [corePlugin, knowledgePlugin, embeddingPlugin],
  bindings: [embeddingBinding, bodyStoreBinding],
});
```

`plugins` accepts only concrete Plugin definitions. `bindings` accepts
`ApplicationResourceBinding<unknown>[]` as the final application-owned layer and
joins plugin bindings in the same resolver. `runtime/application/` never
reconstructs optional-domain plugins. The final public configuration has no
implicit core, shorthand, `PluginSource`, `PluginResolver`, `canonicalCore`, or
fixed-bucket `resources` escape hatch.

One discriminated factory owns all deployment roles:

```ts
createCopilotz({ role: "embedded", plugins, bindings, ...infrastructure });
createCopilotz({ role: "gateway", plugins, bindings, ...infrastructure });
createCopilotz({ role: "worker", plugins, bindings, ...infrastructure });
```

The overloads are exact: `embedded` returns the scoped application API;
`gateway` returns that API plus `fetch(request): Promise<Response>`; both expose
`shutdown(reason?)` and `AsyncDisposable`. `worker` returns a handle with
`closed`, `stop(reason?)`, and `AsyncDisposable`; the async factory resolves
only after workload registration and readiness, so it needs no second `ready`
promise. All returned values expose their literal `role`. Persistence and
execution transport remain role-specific infrastructure fields, not semantic
plugin options. Delete separate Gateway/Worker factories. `resolveRequestScope`
is the Gateway infrastructure field defined in 6.2.

### 6.9 Operation convention

All caller-supplied domain values live in one first argument. Optional execution
metadata lives in the second argument.

```ts
type ReadOptions = Readonly<{ signal?: AbortSignal }>;

type ContentResolveOptions = Readonly<
  & ReadOptions
  & { concurrency?: number }
>;

type OperationIdentity = Readonly<{
  causationId?: string;
  correlationId?: string;
  deduplicationId?: string;
  settlementScopeId?: string;
}>;

type OperationOptions = Readonly<
  & ReadOptions
  & {
    operationKey?: string;
    identity?: OperationIdentity;
  }
>;

type CollectionMutationOptions = Readonly<
  & OperationOptions
  & {
    threadId?: string; // queryable event-envelope routing, not record data
    routing?: EventRouting;
    visibility?: EventVisibility;
    eventMetadata?: Readonly<Record<string, unknown>>;
  }
>;
```

| API                | Canonical call                                                   |
| ------------------ | ---------------------------------------------------------------- |
| Create             | `create({ ...fields }, options?)`                                |
| Update             | `update({ id, set?, unset? }, options?)`                         |
| Delete             | `delete({ id }, options?)`                                       |
| Get                | `get({ id }, options?)`                                          |
| List/search        | `list({ ...query }, options?)`, `search({ ...query }, options?)` |
| Collection command | `commands.name({ id, ...args }, options?)`                       |
| Named query        | `queries.name({ ...args }, options?)`                            |
| Feature action     | `features.alias.action({ ...args }, options?)`                   |

Reads, searches, named queries, and query Feature actions accept `ReadOptions`.
Collection mutations and commands accept `CollectionMutationOptions`.
Transaction and workflow Feature actions, `connect`, `send`, and `run` accept
`OperationOptions`; the second argument remains optional. A nested workflow call
inherits the current root when it omits that argument. Processor roots derive
their root from the durable delivery identity.

`context.idempotencyKey` is derived from namespace, the root invocation
identity, action path, and the stable nested-call suffix described in 5.1. The
root is the explicit `operationKey` when supplied, the durable delivery ID for a
Processor, or an invocation ID generated once for an otherwise unkeyed direct
call. It is stable for all retries performed within that invocation. A caller
that wants a new API call to retry/deduplicate an earlier one supplies the same
`operationKey`; an unkeyed later call is intentionally a new operation.
`OperationIdentity` is invocation lineage, not event metadata. Only
`CollectionMutationOptions.eventMetadata` enters an event envelope, and a
Feature passes it deliberately on the nested Collection mutation. Options never
carry namespace, principal, or domain fields.

### 6.10 Required implementation patterns

- Export static declarations at module scope.
- Keep mutable runtime state inside factory closures; public values remain plain
  frozen records and functions.
- Let `define*` constructors validate and freeze. Avoid repeated manual freeze
  ceremony.
- Reuse dependency constants and ordinary object spread. Add no inheritance or
  merge framework.
- Keep pure policy as ordinary functions beside the owning Feature. Do not make
  it a service, manager, repository, coordinator, or lifecycle object.
- Keep Collection commands pure and transaction Features short. Provider calls,
  waits, stream pumping, and other external work belong in workflow actions.
- Make Processors thin, idempotent reactions over immutable event authority.
- Put physical persistence behind adapters and semantic policy in plugins.
- Never inject the application, engine, SQL session, plugin registry, or all
  installed resources into a Feature or Processor.
- Fail missing, ambiguous, or inadmissible dependencies at composition. Do not
  repeat availability guards in action code.
- Move tests with their target declaration. Delete tests that assert only a
  removed API or schema; rewrite tests that protect an intended invariant.
- A slice is closed only when forbidden-import/symbol checks prove that the
  superseded path cannot return.

### 6.11 Package subpaths and move map

Public subpaths describe semantics, not physical nesting. Repoint a semantic
subpath to its final owner; do not add a second `/plugins/<name>` spelling.

| Public subpath                                                                                                                                            | Final owner                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| package root `.`                                                                                                                                          | `index.ts` → `create-copilotz.ts`    |
| `/collections`                                                                                                                                            | `runtime/collections/index.ts`       |
| `/features`                                                                                                                                               | `runtime/features/index.ts`          |
| `/processors`                                                                                                                                             | `runtime/processors/index.ts`        |
| `/plugins`                                                                                                                                                | `runtime/plugins/index.ts`           |
| `/resources`                                                                                                                                              | `runtime/resources/index.ts`         |
| `/content`, `/events`, `/attachments`, `/capabilities`                                                                                                    | corresponding generic runtime module |
| `/core`                                                                                                                                                   | `plugins/core/index.ts`              |
| `/agents`, `/llm`, `/embedding`, `/tools`, `/skills`, `/channels`, `/admin`                                                                               | corresponding first-party plugin     |
| `/usage`, `/knowledge`, `/memory`, `/schedules`, `/streams`, `/goals`                                                                                     | corresponding first-party plugin     |
| `/tools/deno`, `/tools/mcp-stdio`, `/skills/deno`, `/channels/node`                                                                                       | host adapters owned by those plugins |
| `/adapters/body-store/database`, `/adapters/body-store/memory`, `/adapters/body-store/filesystem`, `/adapters/body-store/s3`, `/adapters/body-store/deno` | deliberate BodyStore adapter modules |
| `/tokens`                                                                                                                                                 | `runtime/tokens/index.ts`            |
| `/server/deno`                                                                                                                                            | `server/adapters/deno.ts`            |

This table is exhaustive. Every existing export key not listed here is deleted.
In particular, remove `/application`, `/plugins/core`, the broad `/adapters`,
`/adapters/deno`, and `/adapters/node` keys. `/core` replaces `/plugins/core`;
it is not an alias. `server/create-fetch.ts` and `ApplicationProjection` remain
internal to package-root Gateway assembly; `/server/deno` only hosts an
already-created public Gateway value exposing `fetch`.

The package self-import map in `deno.json.imports` mirrors these same final
semantic subpaths for first-party source. It contains no old `/plugins/core`,
`/engine`, `/domain`, or other removed alias. The boundary checker derives its
allowed `@copilotz/copilotz/*` imports from that map and the exhaustive export
table; it has no hard-coded exception for `/plugins/core` or any other retired
spelling.

Remove the public `/engine`, `/domain`, and `/context` implementation surfaces
after every in-repository caller moves to the package root or owning semantic
contract. Do not keep re-export barrels for them.

The package root exports only `createCopilotz` and its top-level application
types. Descriptor constructors and semantic contracts have one direct subpath.
`/plugins` exports plugin definition/composition types, not Processor APIs;
those live only at `/processors`. `/adapters/stdio` and the versioned
`/migration/v1`, `/migration/memory-v4`, and `/migration/content-v2` subpaths
are removed in Phase 10. Phase 11 creates the sole final `/migration` entrypoint
after the target schema freezes; Phase 10 does not publish an empty migration
facade.

There is no broad public adapter barrel. Each BodyStore/host subpath imports
only the runtime APIs it actually supports; browser-safe roots never re-export
Deno, Node, filesystem, or server-listen code.

The source migration is direct:

| Current owner                                                                                             | Final owner                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins/core/resources/collections`                                                                      | `plugins/core/collections`                                                                                                                                                                               |
| `plugins/core/resources/features`                                                                         | `plugins/core/features`                                                                                                                                                                                  |
| `plugins/core/resources/processors`                                                                       | `plugins/core/processors`                                                                                                                                                                                |
| `plugins/core/resources/llm`                                                                              | `plugins/llm/adapters`                                                                                                                                                                                   |
| ask Tool value currently beside a core Processor                                                          | `plugins/core/ask-tool.ts`                                                                                                                                                                               |
| `runtime/plugins/{processor,match,transient,event-data}`                                                  | `runtime/processors`                                                                                                                                                                                     |
| Processor members of `runtime/plugins/types.ts`                                                           | `runtime/processors`                                                                                                                                                                                     |
| `runtime/{usage,knowledge,memory,schedules,streams,goals}`                                                | `plugins/<same-domain>`                                                                                                                                                                                  |
| `runtime/{agents,llm,tools,skills,channels,admin}`                                                        | corresponding capability plugin                                                                                                                                                                          |
| fixed types in `runtime/resources/types.ts`                                                               | the semantic owner's `contracts.ts`                                                                                                                                                                      |
| `runtime/application/core-plugins.ts`                                                                     | deleted; callers pass concrete plugins                                                                                                                                                                   |
| separate `runtime/application/{copilotz,gateway,worker}.ts` factories                                     | `runtime/application/assemble.ts`; Fetch projection stays in `create-copilotz.ts`/`server`                                                                                                               |
| `runtime/application/{public,index}.ts` and the public `/application` barrel                              | deleted; private callers import `assemble.ts` or `projection.ts` directly and neither imports package root                                                                                               |
| server imports and Fetch construction currently inside `runtime/application/gateway.ts`                   | `server/create-fetch.ts` over `runtime/application/projection.ts`                                                                                                                                        |
| `server/{event-native,fetch,v1-fetch,v1-sse}.ts`                                                          | retain required published request/SSE mechanics in `server/create-fetch.ts`; delete the parallel EventNativeApp façade and old modules                                                                   |
| `server/{collection-projections,history,assets}.ts`                                                       | `server/routes/{collections,history,assets}.ts`; core record DTOs come from `/core`, protected Asset transport metadata from `/content`, and route-only envelopes from internal `server/routes/types.ts` |
| `server/index.ts` and old server tests                                                                    | delete the barrel; rewrite behavior tests against package-root Gateway `fetch` and the final route modules                                                                                               |
| `runtime/adapters/openapi-tools.ts`                                                                       | `plugins/tools/adapters/openapi.ts`                                                                                                                                                                      |
| `runtime/adapters/mcp-tools.ts`                                                                           | `plugins/tools/adapters/mcp.ts`                                                                                                                                                                          |
| `runtime/adapters/stdio-mcp.ts`                                                                           | `plugins/tools/adapters/mcp-stdio.ts`, exported only as `/tools/mcp-stdio`                                                                                                                               |
| `runtime/adapters/{server-tool-catalog,stdio}.ts` and catalog tests/exports                               | deleted with the parallel server workflow-tool catalog in 10E3                                                                                                                                           |
| `runtime/adapters/deno/tools.ts` and `runtime/adapters/deno/tools/**`                                     | `plugins/tools/adapters/deno`                                                                                                                                                                            |
| `runtime/adapters/deno/skills.ts`                                                                         | `plugins/skills/adapters/deno`                                                                                                                                                                           |
| MCP descriptor/connection/connector and MCP adapter-factory option members of `runtime/adapters/types.ts` | `plugins/tools/adapters/mcp/contracts.ts`                                                                                                                                                                |
| `CreateServerWorkflowToolCatalog*` members of `runtime/adapters/types.ts`                                 | deleted with the parallel server workflow-tool catalog in 10E3                                                                                                                                           |
| `runtime/adapters/deno/persistent-terminal.ts`                                                            | `plugins/tools/adapters/deno`                                                                                                                                                                            |
| `runtime/adapters/node/cli.ts`                                                                            | `plugins/channels/adapters/node`; accept injected run/inspect operations and delete the application convenience overload                                                                                 |
| `runtime/adapters/deno/listen.ts`                                                                         | `server/adapters/deno.ts`                                                                                                                                                                                |
| `runtime/adapters/deno/assets.ts`                                                                         | `runtime/adapters/body-store/deno.ts`                                                                                                                                                                    |
| `runtime/adapters/deno/index.ts`                                                                          | deleted after its members move to their semantic/runtime owners                                                                                                                                          |
| `runtime/adapters/module-plugin-resolver.ts`                                                              | deleted; hosts import plugin values                                                                                                                                                                      |
| `runtime/cli.ts`                                                                                          | `plugins/channels/cli`; terminal I/O stays in the channel's host adapter                                                                                                                                 |
| `runtime/http.ts`                                                                                         | `plugins/llm/adapters/http.ts`; migrate its LLM stream/model-catalog consumers and delete the runtime file                                                                                               |
| provider/model policy in `runtime/tokens/{chat,estimate,calibration}.ts`                                  | `plugins/llm`; only provider-neutral token primitives remain in `runtime/tokens`                                                                                                                         |
| final contract/scoping code evolved from `runtime/content/body-store.ts`                                  | `runtime/content`; delete legacy Asset options/key/config vocabulary                                                                                                                                     |
| memory/filesystem factories in `runtime/content/body-store.ts`                                            | `runtime/adapters/body-store/{memory,filesystem}.ts`                                                                                                                                                     |
| `runtime/content/{database-body-store,s3-body-store}.ts`                                                  | `runtime/adapters/body-store/{database,s3}.ts`                                                                                                                                                           |
| `utils/{document-parser,chunker}.ts`                                                                      | `plugins/knowledge`                                                                                                                                                                                      |
| `utils/unicode.ts`                                                                                        | `plugins/tools/history.ts`                                                                                                                                                                               |
| `runtime/thread-metadata.ts`                                                                              | core thread schema/commands plus owning plugin policy; published-shape translation only in the Phase 11 migration                                                                                        |
| `migration/{v1,memory-v4,content-v2}` and every code/config/documentation reference                       | deleted in 10F after their published-source obligations are recorded; Phase 11 creates the final isolated migration                                                                                      |
| broad fields in `runtime/engine/context.ts`                                                               | exact aliases derived from `requires`                                                                                                                                                                    |
| generic graph machinery in `runtime/{domain,engine/collection-graph.ts}`                                  | `runtime/collections`; domain DTO/projection policy moves to its plugin and old repositories delete                                                                                                      |
| hand-authored `manifest.ts` files                                                                         | derived metadata from `definePlugin()`                                                                                                                                                                   |

For thread metadata, the final thread schema stores only the canonical shape.
Core owns public/runtime thread fields and repeated tag mutations as Collection
commands; memory and channels own their own nested policy; agent prompt policy
reads the canonical public field directly. The current `LEGACY_*` key sets and
`normalizeThreadMetadata()` do not enter normal runtime. Phase 11 translates the
named published stored shapes once.

Tests move with their target. Contract tests for public boundaries remain in
`contracts/`; the current versioned-migration tests delete with their
implementations, and Phase 11 co-locates its new tests with the sole isolated
migration; server projection tests remain in `server/`.

## 7. Ordered implementation program

Implement Phase 10 in this order:

1. **10A — Feature action descriptors and effects.**
2. **10B — typed resource requirements, narrow injection, root plugin
   composition, final BodyStore, mandatory EventBodyStore, and replay-manifest
   cutover.**
3. **10C — canonical declared content.**
4. **10D1–10D6 — first-party domain plugins**, one vertical slice at a time:
   1. usage;
   2. knowledge;
   3. memory;
   4. schedules;
   5. Stream semantic/plugin cutover over the shared BodyStore;
   6. goals.
5. **10E1–10E5 — remaining first-party capability families**, one vertical slice
   at a time:
   1. agents and context policy;
   2. LLM and embedding;
   3. tools, API, and MCP;
   4. skills; and
   5. channels and admin.
6. **10F — production convergence and old-tree deletion.**
7. **Phase 10 closure — schema freeze and Phase 11 published-data migration
   inventory.**

The dependency shape is:

```text
10A action effects
  |
10B typed requirements + flat plugins + BodyStore + EventBodyStore
  |
10C declared content
  |
10D1 usage -> D2 knowledge -> D3 memory -> D4 schedules
                                            |
                                        D5 streams
                                            |
                                         D6 goals
                                            |
                              10E1-E5 capability families
                                            |
                                      10F convergence
                                            |
                                       schema freeze
                                            |
                                         Phase 11
```

Streams precede goals so the ordinary `ConversationRunner` binding can compose
over the plugin-owned Stream implementation. Goals depend on
`ConversationRunner`, not Stream internals.

## 8. Slice 10A — Feature action descriptors and effects

### 8.1 Implementation scope

- Change Feature definitions from a resource-wide read/write mode to action
  descriptors with one input schema, `effect`, Collection/Feature `requires`,
  and `execute`.
- Source-rewrite every Feature definition through the mapping in 5.1, migrate
  all callers/tests, and delete the resource-wide shape.
- Build the final effect-specific Collection/Feature handle types and inject
  only each action's declared aliases: query actions cannot mutate, transaction
  actions receive no workflow-only operation, and workflow actions receive no
  ambient transaction. 10B adds typed resource aliases to these same context
  types; it does not replace them.
- Reuse current same-namespace transaction joining and operation identity.
- Add `content.fields` to the action descriptor but activate its preflight in
  10C.

Do not inventory source strings such as provider/sleep/body-pump method names.
That is brittle. 10A rejects invalid Collection/Feature calls structurally.
Existing fixed resource buckets remain only until their one global 10B cutover;
10A adds no adapter or second context path for them.

### 8.2 Exit proof

Create one reusable operation-effect conformance suite proving:

- the permitted query/transaction/workflow call matrix;
- no mutation from query actions;
- one joined SQL scope for nested same-namespace transaction actions;
- rejection of cross-namespace joining;
- no ambient SQL across workflow waits;
- exact Collection/Feature alias membership with no sibling/global access;
- stable nested operation identity; and
- cancellation/disposal without an active transaction leak.

The same suite proves schema-derived input typing/runtime validation and
schema-free invocation rejection.

Use an admin query and a content-free transaction Feature as real descriptor
consumers. Prove every Feature is source-migrated, the old shape is rejected,
and no normalizer remains. Record that 10B has not started.

## 9. Slice 10B — typed resources and composition

### 9.1 Global cutover

Implement 5.2–5.4 as one global cutover before any new consumer uses it:

- extend the existing plugin registry rather than creating another registry;
- change plugin authoring to the flat shape in 6.8, source-migrate every plugin,
  derive introspection metadata, and delete `manifest.provides`, `manifest.ts`,
  and `{ manifest, resources }` input support;
- delete partial-resource imports/presets and migrate callers to whole plugins
  or explicit configured plugin factories;
- define the real target contracts for every installed fixed-family value,
  migrate every provider and consumer to bindings, and delete
  `PLUGIN_RESOURCE_TYPES` plus type/id-based `list/get/require` lookup;
- resolve requirements after stable binding-ID override precedence;
- complete typed resource `requires` on every Feature action, add all `requires`
  to Processors, and construct their exact effect-shaped aliased contexts using
  the handle types already established in 10A, subject only to the Stream
  sequencing exception below;
- remove broad registry/context access from every definition except that one
  inventoried Stream handle; and
- delete `PluginSource`, `PluginResolver`, module resolution, hidden semantic
  plugin selection, and first-party shorthand.

10B defines no temporary bucket contracts. When a definition depends on a
fixed-family value, introduce that family's real target contract and migrate its
provider and consumer together. Physical/domain moves that do not affect
injection remain in 10D/10E.

One sequencing exception is explicit. The core text Processor and current Tool
executor still call the sole pre-existing `context.streams.write/follow` handle;
attachment fixtures exercise that same path. The final Stream Feature cannot
exist before 10C assetization. Until 10D5 closes, that single inherited field
remains on workflow Processor contexts, but static inventory permits only those
callers to use it; no selective legacy injector, target Stream Feature, or
second lookup path is added, and no new caller may use it. 10D5 introduces the
final Feature, migrates those callers to their declared Feature alias, rewrites
the fixtures, and deletes `context.streams` in the same slice.

### 9.2 Protected BodyStore adapter and scoped facade

BodyStore is the first real protected runtime consumer of the final resolver.
Evolve the useful implementation code—deterministic IDs, conditional writes,
integrity validation, progressive append/follow/seal, fencing, and grace-based
orphan maintenance—into one final contract. In the same 10B slice, migrate every
Asset and Stream byte caller and adapter, then delete `AssetBodyStore`,
`AssetStorageOptions`, `retain`/`discard`, `asset_bodies`, `asset_body_staging`,
and their tests/schema assumptions. There is no adapter, option, table, or read
bridge between the unreleased and final body shapes.

10B also implements 5.6 and moves protected Asset liveness plus the current
Stream's `bodyId` onto the one `body_references` projection. An open Stream and
the interim successfully closed Stream pin their Body. `fail`/`abandon` unset
`bodyId` only with their abort/cleanup transition. This liveness cutover belongs
to physical Body correctness. After 10B the sole interim Stream writer surface
is `write`, implemented over `append` with an internally retry-stable append ID,
plus `finalize`/`fail`/`abandon` over `seal`/`abort`. `retain`, `discard`,
physical `key`, provisional writer `assetId`, and their tests/types are deleted.
10B adds no target Stream API, alias, re-export, normalizer, or second protocol
path. 10D5 migrates handle `write` to Feature `open`, handle `follow` to Feature
`follow`, writer `write` to `append`, and the three terminal methods to
`settle`; it atomically swaps the closed Stream pin to the Asset pin and deletes
the whole interim surface.

Do not introduce parallel `ImmutableBodyStore`, `ProgressiveBodyStore`,
promoter, receipt, reader, writer, follower, recovery, or maintenance contract
families. Every Phase 10 BodyStore implements the same cohesive workflow-only
surface:

```ts
type BodyWriteOptions = Readonly<{
  signal?: AbortSignal;
  operationKey?: string;
}>;

type BodyProtection = Readonly<{ remainingMs: number }>;

type BodyState = "open" | "sealing" | "ready" | "aborted";

declare const readyBodyAuthority: unique symbol;
declare const writerAuthority: unique symbol;

type ReadyBody = Readonly<{
  readonly [readyBodyAuthority]: true;
  bodyId: BodyId;
  state: "ready";
  mediaType: string;
  byteLength: number;
  digest: `sha256:${string}`;
  maintenanceVersion: number;
  protection: BodyProtection;
}>;

type MutableBodyHead =
  & Readonly<{
    bodyId: BodyId;
    mediaType: string;
    byteLength: number;
    digest?: `sha256:${string}`;
    maintenanceVersion: number;
  }>
  & (
    | Readonly<{
      state: "open" | "sealing";
      writerGeneration: number;
      writerLeaseRemainingMs: number;
    }>
    | Readonly<{
      state: "aborted";
      writerGeneration?: never;
      writerLeaseRemainingMs?: never;
    }>
  );

type BodyHead = ReadyBody | MutableBodyHead;

type WriterCapability = Readonly<{
  readonly [writerAuthority]: string;
  bodyId: BodyId;
  generation: number;
  protection: BodyProtection;
}>;

type PutBodyInput = Readonly<{
  bodyId: BodyId;
  mediaType: string;
  bytes: Uint8Array;
  byteLength: number;
  digest: `sha256:${string}`;
}>;

type ReserveBodyInput = Readonly<{
  bodyId: BodyId;
  mediaType: string;
  expectedGeneration?: number;
}>;

type AppendBodyInput = Readonly<{
  writer: WriterCapability;
  expectedOffset: number;
  appendId: string;
  bytes: Uint8Array;
}>;

type AppendResult = Readonly<{
  startOffset: number;
  endOffset: number;
  protection: BodyProtection;
}>;

type SealBodyInput = Readonly<{
  writer: WriterCapability;
  expectedByteLength?: number;
  expectedDigest?: `sha256:${string}`;
}>;

type AbortBodyInput = Readonly<{ writer: WriterCapability }>;

type BodyStore = Readonly<{
  put(input: PutBodyInput, options?: BodyWriteOptions): Promise<ReadyBody>;
  head(
    input: { bodyId: BodyId },
    options?: ReadOptions,
  ): Promise<BodyHead | null>;
  read(
    input: { bodyId: BodyId; offset?: number; length?: number },
    options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  reserve(
    input: ReserveBodyInput,
    options?: BodyWriteOptions,
  ): Promise<WriterCapability>;
  append(
    input: AppendBodyInput,
    options?: BodyWriteOptions,
  ): Promise<AppendResult>;
  follow(
    input: { bodyId: BodyId; offset?: number },
    options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  seal(input: SealBodyInput, options?: BodyWriteOptions): Promise<ReadyBody>;
  abort(input: AbortBodyInput, options?: BodyWriteOptions): Promise<void>;
}>;

type BodyStoreMaintenance = Readonly<{
  list(
    input: {
      states: readonly BodyState[];
      idleForMs: number;
      after?: string;
      limit: number;
    },
    options?: ReadOptions,
  ): Promise<Readonly<{ bodies: readonly BodyHead[]; after?: string }>>;
  delete(
    input: {
      bodyId: BodyId;
      expectedState: BodyState;
      expectedMaintenanceVersion: number;
      idleForMs: number;
    },
    options?: BodyWriteOptions,
  ): Promise<boolean>;
}>;

type BodyStoreAdapter = Readonly<{
  deployment: Readonly<{
    durability: "ephemeral" | "durable";
    reach: "process" | "cluster";
    minimumProtectionMs: number;
  }>;
  forScope(scope: TrustedBodyScope): Promise<BodyStore>;
  maintenanceForScope(
    scope: TrustedBodyMaintenanceScope,
  ): Promise<BodyStoreMaintenance>;
}>;

export const bodyStoreAdapterV1 = defineProtectedResource<BodyStoreAdapter>({
  id: "@copilotz/body-store-adapter/v1",
  effect: "workflow-only",
});

const bodyStoreBinding = {
  contract: bodyStoreAdapterV1,
  id: "default",
  value: createS3BodyStoreAdapter({ client, bucket }),
} satisfies ApplicationResourceBinding<BodyStoreAdapter>;
```

`reserve` without `expectedGeneration` creates the Body or, with the same
`operationKey`, idempotently resumes that creation. Supplying
`expectedGeneration` is its one compare-and-takeover form: it succeeds only for
that open/sealing generation after its writer lease expires, atomically
increments the generation, returns a new capability, and fences every older
writer. A conflicting live lease, state, or generation rejects. Recovery reuses
this operation; there is no recovery-only BodyStore method. Both forms resolve a
matching `operationKey` before state comparison, so retry of a winning takeover
returns the same still-current new generation/capability; once that generation
is itself fenced, the retry conflicts and must reread.

`BodyHead` carries the current operational `maintenanceVersion` and store-clock
`writerLeaseRemainingMs` when applicable. `ReadyBody`, `WriterCapability`, and
`AppendResult` each carry a protected `protection: BodyProtection` field. It is
operational timing authority, not semantic body metadata.

`TrustedBodyScope` contains the already-authorized namespace, physical schema,
and principal. `TrustedBodyMaintenanceScope` adds kernel maintenance authority.
Neither is caller-authored. `runtime/content` resolves the adapter and calls
`forScope`; only workflow actions and Processors declaring
`requires.content: "bodies"` receive the resulting BodyStore under their
protected `context.content.bodies` handle. The application-facing
`scope.content` API never exposes raw Body operations. This is one
content-specific projection, not a generic factory/lifecycle system.

Maintenance is bounded and compare-and-delete. The adapter only enumerates
physical candidates and conditionally deletes by state and age; it never decides
semantic liveness. The protected content coordinator requires zero
`body_references` rows, expired Body protection, expired writer lease, and
elapsed grace before compare-and-delete. Asset and declaring-Collection liveness
are therefore the same projection lookup; generic runtime code never searches
for or branches on a Stream collection. If projection or protection state cannot
be proved, the candidate is reported rather than deleted. Enumeration and
deletion never enter ordinary Feature or Processor contexts.

There is no distributed “in-flight operation” registry. `put` and `seal` set
`protectedUntil` with the adapter's authoritative store clock; `reserve` and
`append` establish/renew the writer lease. Their results expose the remaining
protection duration only through the protected BodyStore surface; it never
enters application content APIs, records, events, or portable data. The
following graph transaction receives a hard deadline shorter than that remaining
duration by a configured safety margin. Once the deadline passes it cannot
commit; a retry must idempotently renew protection before opening SQL.
Application assembly validates that the maximum graph-commit deadline plus
margin is shorter than the adapter's minimum protection duration.

Configured database persistence synthesizes exactly one lowest-precedence
`(bodyStoreAdapterV1, "default")` binding. An explicit application binding with
that tuple replaces it. Any other binding ID for this protected contract is
rejected; Phase 10 selects one BodyStore and does not route between stores. The
shape remains ordinary `{ contract, id, value }`. Because the contract is
runtime-protected, `definePlugin` and composition reject it in plugin bindings;
no method-shape guessing or BodyStore-specific branch is added to the generic
resolver.

The body-specific deployment rules are exact:

- durable graph persistence requires a durable BodyStore;
- embedded or fully in-process Gateway execution may use process reach;
- a Gateway with remote workers and every Worker role require cluster reach;
- memory is ephemeral/process; local filesystem is durable/process unless its
  adapter is explicitly backed by a shared volume; and database/S3 adapters
  declare the reach of their actual deployment.

Application assembly validates those rules once. They are not a generalized
resource placement model.

The logical lifecycle is:

```text
absent -> ready                         direct immutable put
absent -> open -> sealing -> ready     progressive success
                 \-> aborted           unsuccessful production
```

Ready is immutable. Failed versus abandoned is Stream semantics, not a physical
body state.

### 9.3 Mandatory Event Bodies and Asset manifest

In the same 10B architecture cutover, introduce one internal SQL-transactional
`EventBodyStore` and move every new event/replay caller to it. Event Bodies use
their own `event_bodies` rows and `EventBodyRef`; they are never Asset nodes or
`ContentRef`s. Delete the unreleased Asset-node event-body writer/reader once
all callers move. The runtime does not expose EventBodyStore as a plugin
resource because event-body atomicity is mandatory kernel behavior.

The physical Event Body layout is intentionally one table:

```text
event_bodies
  namespace, event_body_id, schema_version
  body JSONB, digest, created_at
```

`(namespace, event_body_id)` is the primary key. Rows are insert-only,
digest-verified, and written in the same SQL transaction as the envelope,
projection, edges, Body-reference rows, and deliveries. Event bodies are bounded
canonical JSON, so they need neither the semantic BodyStore lifecycle nor chunk
state.

Every Collection Event Body carries one bounded metadata-only manifest:

```ts
type AssetManifestEntry = Readonly<{
  assetId: string;
  bodyId: string;
  mediaType: string;
  byteLength: number;
  digest: `sha256:${string}`;
  origin?: AssetOrigin;
  metadata?: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

type AssetManifest = readonly AssetManifestEntry[];
```

The manifest contains only Assets first materialized by that stable logical
mutation and is `[]` otherwise. Membership follows operation/Asset identity, not
whether this particular attempt executed the insert: after an indeterminate
commit, a retry loads/verifies the existing Asset and reproduces the exact entry
from the already-committed event; a genuinely pre-existing bare ref contributes
none. It contains no bytes or physical locator. Parent mutations and standalone
Asset publication use the same entry shape. This is immutable replay authority
for protected Asset metadata and its Body reference, not a second record field
or semantic event.

### 9.4 Database body layout

```text
content_bodies
  namespace, body_id
  state: open | sealing | ready | aborted
  media_type, byte_length, digest nullable
  writer_generation, writer_token_hash, lease_expires_at nullable
  protected_until nullable
  maintenance_version
  created_at, updated_at, ready_at nullable

content_body_parts
  namespace, body_id, start_offset, append_id, bytes BYTEA

body_references
  namespace, body_id, owner_kind, owner_id
```

Required invariants are small:

- header primary key `(namespace, body_id)`;
- part primary key `(namespace, body_id, start_offset)`;
- unique `(namespace, body_id, append_id)`;
- `byte_length` is monotonic while open and equals the contiguous committed end;
- every append supplies expected end, stable append ID, and current writer
  generation/token;
- duplicate append ID plus identical bytes succeeds; different bytes conflict;
- takeover occurs only after lease expiry and increments writer generation so a
  stale writer fails;
- abort is idempotent for the same current capability and rejects every stale
  generation;
- lease comparisons use store/database time, not a worker clock;
- direct put and seal set/renew `protected_until` using store time;
- maintenance rejects an unexpired `protected_until` or writer lease regardless
  of age/state;
- maintenance age comparisons use adapter/store time, and compare-delete
  requires the exact enumerated maintenance version;
- `maintenance_version` increments on every header, protection, lease, or state
  change;
- seal is idempotent, bounded-memory, and verifies exact length/digest; and
- ready content/state fields and parts are immutable; only the operational
  `protected_until` and maintenance version may renew idempotently.

`body_references` belongs to the graph/content projection, not to a BodyStore
adapter: primary key `(namespace, body_id, owner_kind, owner_id)`, with lookup
by `(namespace, body_id)`. `owner_kind` is either the reserved protected-Asset
kind or the canonical, globally unique Collection `name`. The graph transaction
inserts/removes these rows from final canonical state, and replay rebuilds them.
The table contains no physical locator, writer authority, lease, or workflow
state. `content_bodies`/`content_body_parts` exist only for the database
BodyStore; `body_references` exists in graph persistence for every selected
adapter.

Direct database puts create a ready header and immutable part(s). Progressive
settlement seals existing parts without whole-body copying. The adapter owns DDL
provisioning explicitly. When database is the selected migration target,
isolated Phase 11 source readers write every published durable Asset body into
this layout. They cover inline database, filesystem, and object/S3/GCS
locations; normal BodyStore reads have no old-table, old-locator, or inline
fallback.

### 9.5 Exit proof

The reusable resolution/injection suite proves:

- required, optional, many, exact-binding, ambiguity, declaration order, and
  exact injected result shapes;
- canonical contract-object identity and rejection of a second object reusing
  the same ID;
- stable `(contract.id, binding.id)` override identity and precedence;
- query-safe/workflow-only effect admissibility;
- exact alias injection with no sibling/global access;
- IDs-only portable descriptions and secret/value exclusion;
- missing dependencies fail without auto-install or closure pruning;
- duplicate plugin IDs fail; and
- direct plugin values and application bindings use one runtime composition
  path.

Application acceptance also proves the role-discriminated `createCopilotz`,
`app.scope({ namespace, databaseSchema?, principal? })`, typed
`scope.collection(definition)` / `scope.feature(definition)`, scoped transient
Processor binding, missing-selection failure, and the absence of namespace or
physical-schema overrides on every operation.

Add one EventBodyStore/kernel suite proving same-transaction envelope/body/
projection/edge/Body-reference/delivery commit, immutable digest verification,
metadata-manifest retry stability, replay, and the absence of Event Body Asset
nodes and Asset-backed readers.

Run common immutable/progressive/lease/fencing conformance for every BodyStore
adapter. Run restart persistence only for durable adapters and cross-instance
writer/follower cases only for cluster-reach adapters. Prove exactly one winner
for expired-generation compare-and-takeover and rejection while a lease is live.
Prove trusted scope and maintenance projection, bounded compare-and-delete, the
database default and application override, deployment rejection, plugin-binding
rejection, and that every Asset/Stream byte caller uses the final BodyStore.
Prove all superseded types/options/methods/tables/readers/writers/tests absent.

Prove `bodyRefs` derives only from final canonical records, commits with graph
state, and rebuilds through replay. Cover direct-put rollback, reserve-before-
record failure, interim open/closed Stream pins, failed/abandoned reference
removal, seal-before-close recovery, Asset reference creation/deletion,
zero-reference grace, protection/deadline expiry, live-writer rejection,
cross-instance races, and compare-delete races. No cleanup test may inspect a
Stream name or rely on a process-local in-flight set.

Close 10B only after the fixed registry, old plugin shape, broad contexts other
than the inventoried sole-path Stream handle, alternate composition inputs, and
old body path are absent. There is one final resolver, BodyStore,
EventBodyStore, and Asset-manifest contract before 10C starts. Record that 10C
has not started.

## 10. Slice 10C — canonical declared content

### 10.1 Scope

Port the already-proven `content.fields` behavior from the older collection path
into `runtime/collections` for:

- `message.content`;
- `llm_attempt.content`; and
- `tool_execution.content`.

In the same slice, add content paths to the already-10A-migrated core Feature
actions that pass `PreparedContent` into those Collections and remove their
manual `materialize`/`linkOwner` choreography. Otherwise an action could enter
SQL before kernel preflight and must be rejected.

Stream content remains excluded until 10D5 because an open Stream has no Asset.
The final BodyStore, its database layout, every byte caller, and deletion of the
unreleased body path are already complete in 10B. 10C uses that frozen scoped
content mechanism and does not alter resource composition or physical body APIs.

The final EventBodyStore and Asset manifest are already mandatory and frozen in
10B. 10C populates that manifest through the declared-content path but adds no
event-body persistence shape or reader.

### 10.2 One reusable preflight

Use one path extractor for Collection `content.fields`, Collection command
content paths, and transaction Feature action content paths. It replaces each
`PreparedContent` with canonical refs and keeps prepared Assets or a verified
ready Body head in invocation-local private state keyed by namespace and Asset
ID. The sidecar lasts one attempt and is never serialized.

A direct top-level Collection call preflights itself. A transaction Feature
preflights its declared paths before SQL. Only the outermost transaction action
performs body I/O. Nested transaction actions inherit the sidecar and may reuse
an already-preflighted Asset; introducing a new prepared body after the parent
transaction opens fails before the nested handler runs.

The sidecar is not destination-bound: the actual Collection call determines
ownership, and one prepared Asset may serve several fields or owners. Do not add
durable receipts, ledgers, holds, adoption rows, destination binding, or
mid-attempt worker handoff. A retry repeats the deterministic preflight and
reuses the 10B manifest membership rule.

### 10.3 Mutation pipeline

For one attempt:

1. Verify declared carriers, substitute their canonical refs, validate the one
   schema, and retain prepared body candidates in the attempt sidecar.
2. Through the scoped BodyStore, conditionally write each prepared-byte body and
   re-head each `prepareBody` candidate before SQL. An existing body is accepted
   only when media type, length, and digest match.
3. A candidate with no committed Body reference uses the bounded graph-commit
   deadline from its adapter-reported protection; use the minimum remaining
   protection across that set. A candidate whose protection expired is
   admissible only while an existing `body_references` row still pins it: lock
   those rows first in the graph transaction and preserve or replace at least
   one pin in that same commit. If a concurrent removal wins or neither proof
   exists, reject and re-head rather than creating an Asset for uncertain bytes.
4. Lock current state where applicable and evaluate the command/hook once.
5. Canonicalize final declared fields: insert or verify sidecar Asset metadata,
   require a ready same-namespace Asset for bare refs, and verify integrity.
6. Validate the final record.
7. Atomically persist Asset metadata, the owner record, declared relations,
   ownership edges, `body_references`, and Event Body/event with its Asset
   manifest.
8. Select durable consumers from the final canonical Event Body and persist
   delivery obligations in the same transaction.
9. Commit, then dispatch.

Remove preview-driven double evaluation. A command/hook runs once after the
relevant lock; consumer matching uses the result. Every BodyStore—including the
database implementation—uses the same retryable body-before-graph saga. A Body
left by SQL rollback is an ordinary grace-cleaned orphan. Only EventBodyStore is
part of the graph SQL transaction; there is no backend-specific transaction
branch in the semantic body API.

### 10.4 Events, ownership, and replay

- Every new event resolves through `EventBodyRef`. Storing that Event Body
  creates no Asset node, ContentRef, or ownership edge; the manifest inside it
  is replay authority for semantic Assets created by the parent mutation.
- Replay reconstructs protected Asset metadata and Asset `body_references` from
  the Event Body manifest without opening BodyStore; final record fields
  reconstruct Collection-owned body references.
- Subordinate assetization emits only the parent Collection event.
- Standalone Asset publish/delete retains its own events.
- Ownership changes do not emit separate semantic events.
- Ownership derives from the final record, not the incoming patch.
- Delete removes that owner's edge without synchronously deleting shared bytes.
- Replay rebuilds ownership from canonical refs without uploading or reading
  bodies.
- A conflicting idempotency key, Asset ID, body, media type, length, or digest
  fails even when the record patch would otherwise be a no-op.

### 10.5 Exit proof

Create one parameterized declared-content conformance suite covering direct
create/update/command/delete/replay across the database BodyStore and one
external BodyStore:

- omission, `null`, `[]`, required-field `unset` rejection, and parent-object
  replacement for nested paths;
- prepared bodies, existing refs, shared refs, replacement, and duplicates;
- integrity/idempotency conflict and apparent no-op conflict;
- indeterminate-commit retry with byte-identical Asset-manifest membership;
- SQL rollback and grace-based orphan cleanup for each backend;
- `prepareBody` with fresh protection or an existing locked Body reference,
  including expired protection and concurrent reference removal;
- single hook/command evaluation and final-body consumer matching;
- parent-only event emission, bounded Asset manifests, and Asset/ownership/
  Body-reference replay without BodyStore reads; and
- rejection of undeclared prepared content inside an active transaction.

The same suite proves scoped standalone
`prepare/publish/get/resolve/resolveMany/open/delete`, bounded ordered parallel
resolution, retry-stable Asset events, and deletion rejection while any owner
edge remains.

Keep the 10B BodyStore/protected-binding suites green and prove declared content
uses only that scoped facade and frozen EventBodyStore/manifest. 10C adds no
body adapter, event-body, or storage-selection path.

Each core Collection proves its declaration and removal of manual
`materialize`/`linkOwner` choreography. Record that 10D1 has not started.

## 11. Slices 10D1–10D6 — first-party domain plugins

Move one domain per approved slice. A plugin owns its Collections, Features,
Processors, business policy, and contracts for capabilities it defines; it
references shared contracts for dependencies it consumes. The application/host
owns lifecycle-bearing concrete binding values.

Every slice follows the same recipe:

1. convert any Collections it owns to the canonical kernel;
2. move business declarations/policy to the owning plugin while preserving the
   final contracts, bindings, `requires`, and narrow contexts established in
   10B;
3. move external/unbounded work to workflow actions and durable mutations to
   short transaction actions;
4. remove that domain's production runtime construction branch;
5. repoint its intended public subpath, migrate every in-repository caller, and
   delete obsolete exports; and
6. prove omission: if another selected plugin requires it, composition fails
   clearly.

| Slice | Plugin    | Collections and declared content                                              | Special boundary                                                                                               |
| ----- | --------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 10D1  | usage     | usage; no content fields                                                      | Records attempts once without payload copies.                                                                  |
| 10D2  | knowledge | `document.source`; chunk has no content                                       | Loading/embedding is workflow work; document/chunk commit is one transaction action.                           |
| 10D3  | memory    | `long_term_memory.content`, `contextSnapshotContent`, `memory_record.content` | Consumes the `memoryKinds` `many` bindings already cut over in 10B.                                            |
| 10D4  | schedules | `scheduled_job.run.content`                                                   | Host trigger calls a workflow; one pure command advances state and emits the event consumed by a Processor.    |
| 10D5  | streams   | `stream.content` only after successful settlement                             | Stream owns semantics; one BodyStore supplies bytes; settlement reuses kernel assetization.                    |
| 10D6  | goals     | no new Collection                                                             | Goal orchestration is a workflow over one cohesive ConversationRunner resource plus exact domain dependencies. |

### 11.1 Domain clarifications

- Memory content fields are optional canonical sequences, never nullable/string
  unions. Published pre-0.61 rows are translated by Phase 11; no alternate form
  enters the final runtime contract.
- Schedule occurrence identity derives from the stable command operation/event
  identity. Do not add a scheduler kernel or occurrence service.
- Goals use one cohesive `ConversationRunner` contract around `run()` and
  `RunHandle`. Cancellation comes from the action signal and `RunHandle.cancel`.
  Do not decompose application access into a family of plumbing resources.
- Prompt/transcript migration belongs to 10E1 with agents and context policy.
  Phase 11 does not own source-architecture cleanup.

## 12. Slice 10D5 — Stream semantic/plugin cutover

10B has already migrated every byte caller and adapter to the frozen BodyStore,
deleted the intermediate body API/schema, and proved all implementations. 10D5
changes only Stream semantics, ownership, public API, recovery policy, and
plugin placement. It adds no body abstraction, capability negotiation, or table.
It also replaces the inventoried `context.streams` callers from 10B with an
ordinary declared Stream Feature alias and deletes that last context exception.

### 12.1 Stream declaration and API

The Stream record contains only semantic discovery/terminal state:

- stable `bodyId` while open, declared through
  `bodyRefs: { fields: ["bodyId"] }`;
- `state: open | closed | failed | abandoned`;
- thread/participant/lane/media metadata;
- `content: []` while open, failed, or abandoned;
- exactly one canonical ref when closed; and
- safe terminal error/timestamps where applicable.

`bodyId` may be derived deterministically from Stream operation identity but is
not the Stream or Asset ID. Every terminal settlement unsets it. Successful
settlement atomically replaces the Stream's Body-reference pin with the
protected Asset's pin; failed or abandoned settlement leaves no durable pin. The
successful `assetId` is derived retry-stably from the Stream identity and
remains absent from the public record until close. No body locator, backend
credential, or writer token appears in the Stream.

The typed Stream Feature has two public actions. Each action independently
declares:

- `open(input: OpenStreamInput, options?)` returns a writer;
- `follow(input: FollowStreamInput, options?)` returns a backpressured reader.

```ts
const streamActionRequires = {
  collections: { streams: streamCollection },
  content: "bodies",
} as const;
```

Both actions use that ordinary shared requirement object. `open` creates/reads
the Stream through the declared Collection alias. `follow` resolves an open
Stream through `bodyId` and a closed Stream through its canonical Asset before
opening authorized bytes. Both declare `effect: "workflow"`.

The returned value is exact:

```ts
type OpenStreamInput = Readonly<{
  id?: string;
  threadId: string;
  lane: string;
  mediaType: string;
  participantId?: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

type FollowStreamInput = Readonly<{ id: string; offset?: number }>;

type SafeStreamError = Readonly<{
  code: string;
  message: string;
  retryable?: boolean;
}>;

type StreamSettlement =
  | Readonly<{ outcome: "closed" }>
  | Readonly<{ outcome: "failed"; error: SafeStreamError }>
  | Readonly<{ outcome: "abandoned"; error?: SafeStreamError }>;

type StreamAppendResult = Readonly<{
  startOffset: number;
  endOffset: number;
}>;

type StreamWriter = Readonly<
  & AsyncDisposable
  & {
    readonly id: string;
    append(
      input: { bytes: Uint8Array; appendId: string },
      options?: ReadOptions,
    ): Promise<StreamAppendResult>;
    settle(
      input: StreamSettlement,
      options?: OperationOptions,
    ): Promise<StreamRecord>;
  }
>;
```

The Stream layer projects BodyStore `AppendResult` into `StreamAppendResult`;
Body protection/version fields never cross the public handle.

The handle closes over the writer capability and generation; neither is caller
input. Explicit asynchronous disposal before settlement attempts
`settle({ outcome: "abandoned" })` and awaits it; disposal after any terminal
outcome is a no-op. A process loss still relies on lease/recovery rather than a
finalizer. Migrate every remaining caller of `finalize`, `fail`, or `abandon` to
`settle`, migrate `write` to `append`, and delete the whole interim writer
surface.

`open` captures the trusted scope/principal and a scoped invocation factory, not
its live action context or signal. Each later `append` or `settle` starts a
fresh child operation root. `appendId` is the append root/idempotency identity;
an explicit settlement `operationKey` retries `settle`. The `prepareBody`
sidecar used by successful settlement therefore exists only inside that
settlement root.

The token never appears in a Stream record or event. Possessing only a Stream ID
is insufficient to append or settle. Writer methods and the selected recovery
Processor reuse one plugin-owned lifecycle helper over their declared
Collection/content handles; neither receives a raw kernel/admin handle or adds a
public settlement action. A Stream moves from open to one terminal outcome
exactly once; retrying the same outcome is idempotent and a conflicting outcome
is rejected. Public action inputs therefore remain ordinary schema-validated
data.

Phase 10 does not add transient retention, named retention policies, suffix
truncation, prefix discard, or a quota hierarchy. Start with one configured
maximum body/chunk size. Add richer retention only with a demonstrated caller.

### 12.2 Lifecycle

Open:

1. derive stable Stream and Body identities;
2. reserve the Body and writer authority;
3. create the open Stream and discovery event within the shorter deadline
   derived from the reserve protection;
4. return the writer only after graph commit.

If graph creation fails, the Body is an ordinary orphan eligible for grace
cleanup. Byte appends and followers use only BodyStore; they never hold graph
SQL open and never emit semantic events.

Successful settlement:

1. seal and verify the Body;
2. call the protected `context.content.prepareBody` with the returned
   `ReadyBody`, retry-stable `assetId`, and semantic ref metadata;
3. using the fresh seal protection, or the still-locked Stream Body-reference
   pin during recovery, use one graph transaction to insert/verify protected
   Asset metadata, set the Stream's one canonical ref, derive its ownership
   edge, add the Asset's `body_references` row, unset the Stream's `bodyId` and
   remove its old `body_references` row, close the Stream, and persist its
   terminal event/deliveries with the Asset manifest.

This is the 10C path with a sealed-body candidate instead of prepared bytes. It
does not need a separate promoter, durable receipt, adoption ledger, or stream
asset event.

Failed or abandoned settlement first calls `abort` with the current writer
capability, which both authenticates and fences that writer. It then commits the
semantic terminal state and unsets `bodyId` in one graph transaction. A crash in
between leaves an open Stream pointing to an aborted Body; recovery completes
the semantic transition. A stale writer can therefore settle no outcome after
takeover.

Recovery is plugin-owned and introduces no dispatcher or workload. The Stream
plugin's detached static `stream.created` Processor delivery is itself the
durable recovery obligation. Its handler reads the Stream and Body through only
its declared `streamActionRequires` Collection/content dependencies and sets
`settlement: "detached"`. While the current writer lease is live, it waits
abortably for the store-reported remaining duration and reads again; it holds no
graph transaction or byte buffer while waiting. The ordinary delivery heartbeat,
cancellation, and retry path preserves that one obligation across process loss.
It succeeds only after the Stream is terminal and its physical consequence is
verified or completed.

For an expired open/sealing generation, recovery first calls
`reserve({ bodyId, mediaType, expectedGeneration })`. Only the atomic takeover
winner receives the new fenced writer capability. It calls `abort` with that
capability, then conditionally commits the open-to-abandoned Stream transition
and unsets `bodyId`. If another generation or terminal transition won, it
rereads instead of mutating stale state. Generic maintenance and the runtime
never branch on Stream state.

Recovery needs only these cases:

- zero `body_references`, expired protection/lease, and elapsed grace:
  compare-and-abort/delete;
- open Stream plus open/sealing Body and expired writer lease: compare-and-
  takeover, abort with the winning capability, then atomically abandon and unset
  `bodyId`;
- open Stream plus ready Body: retry successful assetization/close;
- open Stream plus aborted Body: atomically abandon and unset `bodyId`;
- open Stream plus missing Body: atomically fail with a safe corruption error,
  unset `bodyId`, and alert without fabricating bytes;
- failed/abandoned Stream: it has no `bodyId`; any interrupted open, sealing, or
  ready leftover therefore reaches the generic zero-reference rule;
- closed Stream whose canonical Asset resolves to a non-ready, missing, or
  corrupt Body: report corruption and alert; never delete or fabricate the
  expected output.

Appends are expected-offset and idempotent. A ready Body is digest-verified and
immutable. Every progressive writer takeover fences the stale writer.

### 12.3 Events and placement

A normal open-to-terminal Stream lifecycle emits one create event and one
terminal update event. The generic Collection delete, if deliberately invoked by
a future admin/retention policy, emits the standard `stream.deleted`; Phase 10
defines no such policy. Chunks, follower offsets, leases, and body cleanup never
become events.

The Stream schema and Stream-specific Oxian protocol introduced earlier on this
refactor branch are unreleased intermediate implementations. 10D5 migrates every
caller, fixture, and test to the final Feature/BodyStore path and deletes that
workload, schema, readers, settlement path, and protocol branching. The
published 0.60.18 baseline contains no Stream collection or Stream events, so
there is no old Stream drain or historical Stream adapter.

The target adds no Stream workload protocol. `open`, `follow`, and the returned
writer execute on the caller's host and no closure or writer capability crosses
Oxian. A Processor placed on a remote Worker calls the same Stream Feature
locally there; a Gateway independently follows the committed Stream through the
shared graph and cluster-reach BodyStore. The ordinary durable-delivery workload
is the only Oxian mechanism involved. Do not add a Stream dispatcher,
handler-registration contract, transitive composition fingerprint, rolling-
gateway heuristic, or deployment negotiator.

### 12.4 Exit proof

Keep the 10B BodyStore conformance suites green, then run one Stream vertical
suite proving:

- direct put and progressive open/append/follow/seal/abort;
- append retry, expected-offset conflict, bounded memory, restart, lease expiry,
  takeover fencing, stale-writer append/seal/abort/settle rejection, and digest
  verification;
- open Stream `content: []` and successful close with exactly one ready Asset
  ref/edge plus exactly one deterministic Asset Body-reference pin;
- body-first discovery ordering and no SQL across pumping/following;
- exactly two events for a normal open-to-terminal lifecycle and zero chunk
  events;
- failed/abandoned cleanup and the recovery cases above;
- namespace isolation, slow-follower backpressure, cancellation, and server
  attachment projection;
- remote-Worker production plus independent Gateway following through one
  cluster-reach BodyStore, with no proxied writer handle;
- absence of the Phase 8 Stream protocol, methods, readers, and tests; and
- identical Stream behavior through the database default and one explicit
  application BodyStore override.

## 13. Slices 10E1–10E5 — remaining capability plugins

10B has already replaced the fixed registry buckets with real contracts and
bindings. The architecture is still incomplete while the business semantics for
agents, LLM/embedding, tools/API/MCP, skills, channels, or admin remain in
runtime modules. Move each family vertically to ordinary plugins and delete its
old semantic owner.

| Slice | Capability                | Final shape                                                                                                                                                                                                 | Required deletion                                                            |
| ----- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 10E1  | agents and context policy | Agent definitions and context contributions are typed bindings; `plugins/agents` alone owns prompt/transcript assembly and agent-selection Features/policy. Core Processors consume those declarations.     | Native prompt/transcript DTOs and `runtime/agents`/`runtime/context`.        |
| 10E2  | LLM and embedding         | LLM and Embedding are Features over cohesive workflow-only adapter contracts. `plugins/llm/adapters` and `plugins/embedding/adapters` export factories; the application owns and binds constructed clients. | Provider/orchestrator façades and `runtime/llm`.                             |
| 10E3  | tools, API, and MCP       | Tool definitions/executors are typed bindings consumed by Tool Features. OpenAPI and MCP adapter factories produce Tool bindings; they are neither registry kinds nor hidden plugin units.                  | Parallel generators/catalogs and semantic code under `runtime/tools`.        |
| 10E4  | skills                    | Skill definitions/readers are typed bindings; skill listing/loading is Feature and Tool policy in `plugins/skills`; host filesystem access remains an adapter.                                              | `runtime/skills`.                                                            |
| 10E5  | channels and admin        | A channel is Collections + Features + Processors plus a typed transport binding. Admin is Features/projections. `server` remains a transport projection.                                                    | Runtime channel/admin construction, `runtime/channels`, and `runtime/admin`. |

Agent capability grants remain the existing explicit authority mechanism. A
binding being installed never grants an agent permission to use it.

Each slice must:

1. preserve the real target contracts, provider/consumer bindings, and narrow
   requirements already cut over in 10B;
2. move the remaining business policy and adapter factory source to its final
   plugin owner;
3. migrate package subpaths and every in-repository/downstream compile fixture;
4. delete the old semantic construction branch, runtime directory, exports, and
   source-placement tests; and
5. prove the capability through its Feature/Processor/resource contracts and
   end-to-end behavior.

Do not preserve a removed subpath by re-exporting it from another file. Keep a
semantic subpath only when it is part of the final API, and repoint it directly
to the owning plugin.

## 14. Slice 10F — production convergence

Each 10D/10E slice removes its own old construction path. 10F is the final
mechanical proof and residual deletion pass:

- bind every production Collection once through `runtime/collections`;
- remove the old two-map merge, property-shape detection, and duplicate-name
  precedence;
- verify the 10B-deleted `PLUGIN_RESOURCE_TYPES` buckets and broad execution
  contexts, plus the 10D5-deleted `context.streams` exception, cannot return;
- verify only flat plugin fields and the generic typed-binding map remain;
- remove the old production collection manager/repository construction path;
- remove `runtime/domain` and every native conversation/attempt/execution DTO or
  mutation façade after prompt/transcript migration;
- keep a framework-internal Collection catalog only for composition,
  transactions, and diagnostics;
- verify ordinary Features and Processors receive only declared handles;
- verify the 10B-deleted `canonicalCore`, fixed-bucket `resources`,
  optional-domain application options, and dynamic plugin module resolution are
  absent; concrete `plugins` and `bindings` are the only semantic composition
  inputs;
- remove every residual unmapped root utility or semantic runtime file named in
  6.1/6.11; and
- record the published-source obligations of the current versioned migrations,
  then delete those implementations, tests, exports, self-imports, publish/test
  task entries, contract imports, checker exemptions, and README/docs
  references; Phase 11 creates the final migration only after schema freeze; and
- make architectural source ownership and package exports match 6.1/6.11 while
  proving every forbidden path absent.

10F adds no abstraction. It closes when no production dual binding or old
directory exists, every valid selected plugin set composes, omission fails
clearly, and forbidden-import/symbol checks prevent the removed architecture
from returning.

## 15. Reusable proof strategy

Phase 10 adds a small set of reusable conformance suites rather than custom
tests for every declaration:

1. operation effects;
2. declared content;
3. resource resolution and narrow injection;
4. BodyStore behavior;
5. EventBodyStore, Asset-manifest, and replay projection behavior; and
6. plugin omission/composition.

Each concrete Collection, binding, or plugin runs the relevant suite plus tests
of intended business behavior. Every slice also runs:

- formatting for touched files;
- `deno task check`;
- the configured full no-run type-check graph;
- `deno task test` with required permissions; and
- `git diff --check`.

Every slice handoff records the exact scope, migrated callers/data, deleted
paths, proof, and “next slice not started.” Do not commit unless requested.

## 16. Phase 11 and later work

Phase 11 begins only after the final Phase 10 schema freeze. It owns:

- creation of `migration/index.ts`, the sole `/migration` export, and the
  matching `migration/**/*.ts` publish inclusion;
- dry-run, resumable migration from named published pre-0.61 schemas;
- historical Collection projection and ownership-edge rebuild;
- creation of mandatory final Event Bodies and Asset replay manifests;
- rebuild and verify `body_references` from migrated protected Asset metadata
  and every declared Collection Body-reference field;
- migration of every published durable Asset body—inline database, filesystem,
  and object/S3/GCS locations—through isolated source readers into the selected
  final BodyStore, with digest/length verification and resumable progress;
- explicit rejection/reporting of published memory-only Asset locations because
  ephemeral bytes cannot be reconstructed safely;
- versioned decoding/upcasting of immutable historical event schemas as replay
  semantics, not as a second application API;
- verification that migrated databases need no old-schema runtime reader; and
- deletion of migration-only readers after their named migration gate, where the
  release process does not need them for future upgrades.

Later demand-driven extensions—not incomplete refactor work—include:

- composition-managed binding factories, additional scopes, or dependency graphs
  if concrete construction needs prove them;
- contract-version negotiation and generalized fleet capability scheduling;
- multiple simultaneous storage classes and per-field routing;
- cross-backend Stream promotion;
- transient Stream retention, discard/truncation, and advanced quotas; and
- progressive external-store hardening or mixed-deployment negotiation beyond
  what the common conformance suite currently proves.

## 17. Explicit non-goals

Phase 10 does not:

- migrate or rewrite historical rows/events;
- introduce a generic service locator;
- expose a raw transaction to Features or Processors;
- add per-call assetization/backend switches;
- store raw bytes, chunks, locators, or credentials in semantic events;
- claim filesystem/S3 plus SQL atomicity;
- make ordinary Collection reads resolve large bodies implicitly;
- add a second assetization or stream-promotion protocol;
- build a generalized DI lifecycle/authority/placement framework;
- add distributed composition fingerprints when explicit workload IDs suffice;
- keep any superseded internal API, table, protocol, or directory for an
  unreleased phase; or
- weaken namespace, capability, idempotency, or immutable-event guarantees.

At lock time, Phase 10 implementation has not started. The next permitted
implementation task is **10A — Feature action descriptors and effects**.
