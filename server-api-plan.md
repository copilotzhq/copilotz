# Copilotz DX-First Implementation Plan

Status: draft

## Purpose

This document rewrites the current implementation plan with one priority above all others:

- maximize developer experience

The goal is to make Copilotz easier to adopt, easier to reason about, and easier to evolve without introducing unnecessary modes, factories, or abstraction layers.

This is a planning document for implementation definitions, not a final API contract.

## Core Product Direction

Copilotz should feel simple to start and powerful to extend.

The main developer experience should revolve around a single public factory:

- `createCopilotz(...)`

We should avoid introducing extra top-level factories or too many resource source modes until we have proven that they are necessary.

## Main DX Decision

There should be one main way to bootstrap Copilotz:

```ts
const copilotz = await createCopilotz({...});
```

That factory should support two intuitive resource authoring styles:

1. Explicit code-defined resources
2. File-defined resources loaded from a local `resources/` directory

These two styles should be composable.

## Target Developer Experience

### 1. Explicit resources

```ts
const copilotz = await createCopilotz({
  dbConfig: { url: Deno.env.get("DATABASE_URL")! },
  agents: [...],
  tools: [...],
  apis: [...],
  processors: [...],
});
```

### 2. File-based resources

```ts
const copilotz = await createCopilotz({
  dbConfig: { url: Deno.env.get("DATABASE_URL")! },
  resources: {
    path: "./resources",
  },
});
```

### 3. Mixed mode

```ts
const copilotz = await createCopilotz({
  dbConfig: { url: Deno.env.get("DATABASE_URL")! },
  resources: {
    path: "./resources",
  },
  tools: [extraTool],
});
```

In mixed mode, explicit code-defined resources should extend or override the file-loaded resources in a predictable way.

## Primary Goals

- Keep `createCopilotz(...)` as the single main public entrypoint.
- Make local file-based resources a built-in first-class feature of `createCopilotz`.
- Reuse DB connections internally without forcing users to learn a separate app factory.
- Make live local iteration easy for instructions, tools, APIs, and processors.
- Keep server integration framework-independent.
- Replace legacy generic REST ideas with domain-aware helper surfaces where they improve usability.

## Non-Goals

- Introduce a separate public app factory as the main entrypoint.
- Add multiple advanced resource modes such as DB-defined executable resources right now.
- Add URL-imported executable modules as part of the first DX-focused pass.
- Preserve the old generic `/v1/rest/[resource]` model as the long-term primary API.
- Build framework-specific route helpers directly into `lib/copilotz`.

## Guiding Principles

1. One obvious way to start.
2. Sensible defaults over mode-heavy configuration.
3. Internal complexity is acceptable if external API stays simple.
4. File-based local iteration should be easy.
5. Runtime/system APIs should match Copilotz's actual architecture.
6. We should only add new public abstractions when they clearly reduce user code.

## Proposed `createCopilotz` Direction

## Keep `createCopilotz`

We should not replace `createCopilotz` with another top-level public factory.

Instead, we should refactor `createCopilotz` internally into clearer phases:

1. resolve database
2. resolve resources
3. merge explicit and loaded resources
4. normalize runtime config
5. create Copilotz instance

This keeps the public DX simple while still letting us improve the internals substantially.

## Add Built-In File Resource Loading

Today `loadResources()` exists as a utility.

DX-first direction:

- `createCopilotz` should support file resource loading directly
- `loadResources()` can remain as a lower-level utility, but should no longer be the main path users must wire manually

### Proposed config shape

```ts
type CopilotzResourcesConfig = {
  path?: string;
  watch?: boolean;
};
```

Example:

```ts
createCopilotz({
  resources: {
    path: "./resources",
    watch: true,
  },
});
```

### Semantics

- `resources.path`:
  load resources from a file structure
- `resources.watch`:
  enable local runtime refresh behavior for file-based resources

We should keep this intentionally simple.

No extra first-pass modes such as:

- `explicit`
- `dynamic`
- `db`
- `manual`
- `process`
- `mtime`

Those may still exist internally, but should not shape the first public DX unless proven necessary.

## Resource Composition Rules

When `resources.path` is used, `createCopilotz` should load:

- agents
- tools
- apis
- processors
- mcp servers if supported by the loader

Then explicit config fields should be applied on top.

### Initial composition rule

Simple and predictable:

- if explicit arrays are provided, they are appended after loaded resources by default
- if IDs collide, explicit definitions win

That gives developers an easy override model without making them learn a custom merge DSL.

### Example

If `resources/agents/assistant` exists and user also passes:

```ts
agents: [{ id: "assistant", ... }]
```

then the explicit `assistant` should replace the loaded one.

## Database Reuse Strategy

## Keep `createDatabase`

Copilotz already has `createDatabase`, and that should remain the DB primitive.

DX-first plan:

- if user passes `dbInstance`, use it directly
- if user passes `dbConfig`, `createCopilotz` can internally reuse a cached DB instance for equivalent DB config

This should be an internal optimization, not a new concept the user must manage unless they want explicit control.

## Important boundary

We should cache:

- database connections

We should not blindly cache forever:

- loaded file resources
- the whole Copilotz runtime instance

The DB lifecycle should be separable from the resource lifecycle.

That is especially important if we want:

- local live iteration
- changing instructions without restarting everything
- tools evolving during development

## Resource Reloading Strategy

## DX-first rule

Only one public switch:

- `resources.watch: true`

That should mean:

- local file resources can refresh during development

We do not need to expose a complicated reload matrix in the public API right now.

## Internal interpretation

Internally, `watch: true` may be implemented in different ways:

- file watcher
- mtime checks before run
- resource fingerprint checks

But externally the developer should only need to understand:

- `watch: false` or omitted: load once
- `watch: true`: pick up file changes locally

## Loader Concerns To Address

Current resource loading has two important limitations:

1. app-level singletons often cache the loaded resources together with the DB/runtime
2. dynamic module import caching can prevent changed `.ts` modules from actually refreshing

So implementing `watch: true` likely requires internal improvements such as:

- resource fingerprinting
- import cache busting for `.ts` modules
- direct text reads for `.md` instructions

But those should remain internal implementation details as much as possible.

## What We Are Explicitly Not Doing Now

To keep DX simple, we should postpone:

- DB-defined executable resources
- URL-imported tool or processor functions from DB records
- multi-mode resource source config
- separate public runtime factory
- an extra public `forwardRunEvents` abstraction

These may still become useful later, but they are not necessary for the DX-first first pass.

## Event Forwarding Helpers

We discussed a possible helper such as `forwardRunEvents(...)`.

Current conclusion:

- not a priority public abstraction

Reason:

- `copilotz.run(...).events` already gives a good low-level primitive
- we should only extract an event-forwarding helper if route adapters still feel repetitively noisy after the main refactor

This can remain an internal helper later if useful, but it should not drive the first implementation plan.

## Server Helper Strategy

We still want server-facing helper modules, but only where they clearly improve DX and align with Copilotz's real data model.

The intent is:

- framework-independent server helpers
- no hard dependency on Oxian
- thin adapters in apps

## Proposed Domain Split

### `copilotz/server/collections`

Primary application data API.

Backed by:

- `copilotz.collections`
- `copilotz.collections.withNamespace(namespace)`

Why:

- collections are already the preferred graph-backed application data abstraction
- they are more stable and developer-friendly than raw generic CRUD over `ops.crud`

Primary responsibilities:

- list exposed collections
- resolve collection by name
- execute collection CRUD operations
- execute collection search where available
- parse common list/query options

### `copilotz/server/threads`

Dedicated runtime API for threads.

Backed by:

- `ops.getThreadById`
- `ops.getThreadByExternalId`
- `ops.getThreadsForParticipant`
- `ops.findOrCreateThread`
- `ops.archiveThread`

Why:

- threads are runtime entities with semantics beyond normal business CRUD

### `copilotz/server/messages`

Thread-scoped message API.

Backed by:

- `ops.getMessageHistoryFromGraph`
- `ops.getLastMessageNode`
- message-clear helpers if still needed

Why:

- messages are graph-backed now, but their domain model is still "messages inside threads"

Messages should be treated as a thread subresource, not a generic top-level REST resource.

### `copilotz/server/events`

Dedicated queue/observability API.

Backed by:

- `ops.addToQueue`
- `ops.getProcessingQueueItem`
- `ops.getNextPendingQueueItem`
- `ops.updateQueueItemStatus`

Why:

- events are queue items, not normal CRUD business records

### `copilotz/server/assets`

Dedicated asset delivery API.

Backed by:

- `copilotz.assets.getBase64`
- `copilotz.assets.getDataUrl`
- asset ref parsing helpers
- asset metadata helpers when available

Why:

- assets are their own subsystem
- they are not currently first-class graph nodes
- they need representation-aware delivery semantics

### `copilotz/server/graph`

Low-level graph/admin API.

Backed by graph `ops`.

Why:

- useful for admin, debugging, migration, and advanced tooling
- not the primary app-data API

## Collections Over Generic REST

The old generic REST-over-`ops.crud` direction should be phased out as the primary model.

DX-first rationale:

- developers should work with collections for app data
- collections are the abstraction Copilotz is teaching people to use
- generic raw-table REST adds confusion once the product becomes graph-first

So the default app-data API direction should be:

- collections first

Not:

- generic raw resource CRUD first

## Proposed Endpoint Families

These are conceptual endpoint families for planning. They are not framework-specific route definitions.

### Collections

- `GET /v1/collections`
- `GET /v1/collections/:collection`
- `POST /v1/collections/:collection`
- `GET /v1/collections/:collection/:id`
- `PUT /v1/collections/:collection/:id`
- `DELETE /v1/collections/:collection/:id`
- `GET /v1/collections/:collection/search`

### Threads

- `GET /v1/threads`
- `GET /v1/threads/:id`
- `GET /v1/threads/by-external-id/:externalId`
- `POST /v1/threads`
- `PATCH /v1/threads/:id`
- `POST /v1/threads/:id/archive`

### Messages

- `GET /v1/threads/:id/messages`
- `DELETE /v1/threads/:id/messages`

### Events

- `GET /v1/threads/:id/events`
- `GET /v1/threads/:id/events/processing`
- `GET /v1/threads/:id/events/next-pending`
- `POST /v1/threads/:id/events`
- `PATCH /v1/events/:eventId/status`

### Assets

- `GET /v1/assets/:refOrId`
- optional split forms:
  - `GET /v1/assets/:refOrId/content`
  - `GET /v1/assets/:refOrId/meta`
  - `GET /v1/assets/:refOrId/url`

### Graph

- `GET /v1/graph/nodes/:id`
- `GET /v1/graph/namespaces/:namespace/nodes`
- `GET /v1/graph/nodes/:id/edges`
- `POST /v1/graph/search`
- `PATCH /v1/graph/nodes/:id`
- `DELETE /v1/graph/nodes/:id`

## Assets: Current Position

Assets are currently:

- stored in configured asset backends
- referenced by `asset://...`
- exposed through asset APIs
- announced through `ASSET_CREATED` and `ASSET_ERROR` events

Assets are not currently modeled as first-class graph nodes.

Messages and tool outputs may reference assets, but that is different from assets being graph entities themselves.

## Should Assets Become Graph Nodes?

Maybe later, but not now.

For the DX-first plan, we should keep assets separate.

If we later decide asset nodes are valuable for:

- provenance
- observability
- graph traversal
- searchability

that should be treated as a separate explicit design step.

It should not complicate the first server-helper implementation.

## Proposed Helper Surfaces

These names are placeholders and should be validated during implementation.

## `createCopilotz` resource resolution helpers

Internal helpers, not necessarily public:

- `resolveDatabase(config)`
- `resolveLoadedResources(config)`
- `mergeResourceSets(loaded, explicit)`
- `buildNormalizedCopilotzConfig(config, resources)`

## Collections

- `listCollections(copilotz)`
- `resolveCollectionCrud(copilotz, namespace, collectionName)`
- `executeCollectionList(...)`
- `executeCollectionGetById(...)`
- `executeCollectionCreate(...)`
- `executeCollectionUpdate(...)`
- `executeCollectionDelete(...)`
- `executeCollectionSearch(...)`
- `parseCollectionQuery(...)`

## Threads

- `listThreads(...)`
- `getThreadById(...)`
- `getThreadByExternalId(...)`
- `createOrFindThread(...)`
- `archiveThread(...)`

## Messages

- `getThreadMessages(...)`
- `clearThreadMessages(...)`

## Events

- `listThreadEvents(...)`
- `getProcessingEvent(...)`
- `getNextPendingEvent(...)`
- `enqueueThreadEvent(...)`
- `updateEventStatus(...)`

## Assets

- `resolveAssetInput(...)`
- `readAsset(...)`
- `getAssetMetadata(...)`
- `resolveAssetUrl(...)`
- `buildAssetReadResult(...)`

## Graph

- `getGraphNode(...)`
- `listGraphNodes(...)`
- `getNodeEdges(...)`
- `searchGraphNodes(...)`
- `updateGraphNode(...)`
- `deleteGraphNode(...)`

## Shared utilities

- `deepMergeReplaceArrays(...)`
- `listPublicAgents(resources)`
- `loadUserMetadata(...)`
- `upsertUserMetadata(...)`

## Open DX Questions

1. Should `resources.path` default to `"resources"` when the field is present but empty?
2. Should `resources.watch: true` refresh immediately via file watching, or lazily on next run via fingerprint check?
3. Should explicit arrays always override file-loaded resources by ID, or should we support append-only behavior for some resource types?
4. Should collection exposure be allowlist-based by default in server helpers?
5. Should graph helpers be treated as internal/admin-only in the first pass?
6. Should direct asset upload endpoints exist in the first pass, or should we focus on asset reads only?

## Recommended Implementation Order

### Phase 1: Refactor `createCopilotz` Internals For Simplicity

- keep `createCopilotz` as the only main public factory
- add built-in `resources.path`
- add built-in `resources.watch`
- separate DB reuse from resource/runtime reuse
- make explicit resource config merge cleanly with loaded resources

### Phase 2: Shared DX Utilities

- `deepMergeReplaceArrays`
- `listPublicAgents`
- asset read helpers

### Phase 3: Collections-First Server Helpers

- collection resolution
- collection query parsing
- collection CRUD/search execution helpers

### Phase 4: Dedicated Runtime Helpers

- thread helpers
- message helpers
- event helpers

### Phase 5: Optional Graph/Admin Helpers

- low-level graph read/update helpers for admin/debug use cases

## Immediate Next Step

Define concrete implementation contracts for:

1. `createCopilotz` resource-loading config
2. resource merge behavior between file-loaded and explicit resources
3. DB reuse strategy inside `createCopilotz`
4. `copilotz/server/collections`
5. `copilotz/server/threads`
6. `copilotz/server/events`
7. `copilotz/server/assets`

Then validate the design by migrating one client to the new `createCopilotz` DX before rolling it across the workspace.
