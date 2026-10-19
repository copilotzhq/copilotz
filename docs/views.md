---
title: "Views"
description: "Compose authorized presentations and attach bounded owner-backed Collection observations."
section: Runtime
order: 15
---

# Views

A plugin declares a View, composition selects it by data kind, mode and
renderer, and a host supplies an authorized projector. The View receives only
that projection. `ViewDefinition<Item, Result, Context>` permits a host-specific
result/context while preserving the default text context.

`createTextRenderer` remains a pure, one-shot text renderer. The public package
does not include a React renderer or a browser component scheduler. A React host
can evaluate these same View definitions over the owner-backed Collection
observation seam below and mount the returned elements. React hooks belong in
mounted React components, not asynchronous View functions. None of this is a
JavaScript sandbox or an alternative worker execution runtime.

```ts
import { createPluginRegistry, definePlugin } from "@copilotz/copilotz/plugins";
import { createTextRenderer, defineView } from "@copilotz/copilotz/views";

const summary = defineView({
  id: "boards.summary",
  shows: "board",
  renderer: "text",
  modes: ["context"],
  render: (board: { title: string }) => board.title,
});
const plugin = definePlugin({ id: "boards", version: "1", views: { summary } });
const registry = createPluginRegistry({ plugins: [plugin] });

// This example host owns a single public field and grants it to one viewer.
// A storage-backed host must enforce current policy before returning its fields.
const renderer = createTextRenderer({
  registry,
  scope: { principal: "reader" },
  project(reference, { scope, signal }) {
    signal.throwIfAborted();
    const viewer = scope as { principal: string };
    const selector = reference.value as { id?: string };
    if (
      viewer.principal !== "reader" || reference.shows !== "board" ||
      selector.id !== "board-1"
    ) throw new Error("View read denied");
    return { title: "Shared board" };
  },
});
await renderer.render({ shows: "board", value: { id: "board-1" } });
```

## Composition and resolution

Use `views` maps in `definePlugin`, `createPluginRegistry`, or the existing
`createCopilotz` factory. Resource and adapter contributions may also emit
Views. Aliases and stable View IDs must be unique across the final composition.
The registry exposes `views` and `resolveView(shows, mode, renderer)`.

`shows` is a kind string, `{ list: "kind" }`, `{ action: "action.id" }`, or
`{ navigation: "name" }`. These are distinct kinds. The render input is
`{ shows, value }`; its value is an opaque selector for the host projector, not
a raw record to render. Mode names are open-ended; defaults are `context` and
`text`.

Overlapping Views fail composition unless the final Resource overlay selects a
matching candidate:

```ts
resources: {
  views: {
    prefer: [{ shows: "board", mode: "context", renderer: "text", view: "boards.summary" }],
  },
}
```

A preference cannot override an executable ID or select a nonmatching View. When
no View matches, the text renderer serializes the authorized projection. It
never falls back to serializing the raw reference. The projector is mandatory
even for this generic rendering and for every nested `ctx.show` call.

## Capabilities and lifetime

A View context exposes `collections`, `actions`, `resources`, `scope`, `signal`,
`hints` and `show`. Host-supplied Collection capabilities provide `get` and
`list` reads returning `{ value, status, pending }`. Each capability must
already be bound to the viewer and enforce authorization on every read. The
renderer cannot make an unscoped database client safe.

Projection, resource, scope and Collection result snapshots contain inert,
acyclic data. Accessors, callable capabilities and unsafe properties are
rejected. Snapshots are isolated copies, readonly in TypeScript; they are not
frozen. Mutating a View's scope copy cannot change the scope used to authorize
nested projection. The host must exclude hidden fields, secrets and
protected-derived text before returning data to a View.

Declared Action names expose functions that reject invocation without calling
the host. No persistence handles, writes, transactions, adapters or subscription
capabilities enter the View context. Plugin code remains trusted in-process
code.

`ctx.show` inherits the current scope, mode and renderer. Each captured context
expires when its render ends, before adapter cleanup. Detached nested renders
are cancelled and their cleanup is drained before normal completion. All nested
renders share the root deadline and data budget; nesting cannot reset them.

Hosts can supply `renderers` adapters. An adapter opens one session per render
with `render(evaluate)` and optional `dispose()`. It may evaluate a View at most
once and must return text. Cross-renderer nesting requires the requested
adapter; a missing adapter fails. Disposal is started after success, failure or
cancellation.

## Resource bounds

`createTextRenderer` accepts positive integer limits:

- `maxDepth`, default 32: nested Views and inert data depth
- `maxNodes`, default 20,000: cumulative snapshot nodes per root render
- `maxBytes`, default 65,536: cumulative UTF-8 bytes of snapshots and text per
  root render
- `maxPending`, default 16: concurrent render sessions and Collection reads on
  this renderer instance, including nested sessions
- `timeoutMs`, default 1,000: the root deadline in milliseconds, including
  projection, View evaluation, nested rendering and cleanup

The data budget charges selectors, copied scope/resources, projected and read
values, View results and final text. Repeated snapshots and nested outputs each
consume budget. A large input can therefore leave less room for output.
`snapshotViewData(value, { maxDepth, maxNodes, maxBytes })` also accepts
standalone snapshot limits with the same defaults. Sparse arrays and executable
or accessor properties fail closed.

Capacity is reserved synchronously. Excess work rejects instead of joining a
queue. Aborting or timing out rejects the caller and revokes its context, but
noncooperative projectors, Views, adapters, Collection reads and cleanup retain
their reservations until their actual promises settle. An adapter cannot free a
reservation by discarding a pending evaluation. Reuse a renderer instance for
work that must share its admission limit.

These bounds do not forcibly terminate JavaScript. Hosts and plugin callbacks
remain trusted in-process code; synchronous work must also cooperate so the
platform can deliver cancellation and deadlines.

## Package and build surface

The package root and `@copilotz/copilotz/views` export `defineView`,
`isViewDefinition`, `createViewResolver`, `createTextRenderer`,
`snapshotViewData` and their types. The View implementation has no owner-runtime
dependency.

Plugin `views/<name>/index.ts` leaves use the ordinary default-export
convention. The existing build discovers them and emits deterministic static
imports and View maps in `plugin.generated.ts`. Layout and ownership checks
apply to View leaves just as they do to Actions, Collections and Processors.

See [Plugins and Processors](plugins-and-processors.md) for composition and
[Collections](collections.md) for scoped reads.

## Owner-backed live Collection selections

The canonical client exposes
`client.collections.observe(name, selection,
{signal, checkpoint?, onSnapshot})`.
A selection is exactly one of:

- `{id}` for a record
- `{query}` for a bounded list window (default 100, maximum 1000 records)
- `{queryName, input}` for a declared owner projection

The HTTP route is `POST /collections/:name/observe` through the existing
multipart protocol. It must be explicitly enabled in the Collection exposure
operations policy, and the Collection must require an owner policy. Both
configured authentication and authorization must succeed. A private server
binding captures only the authenticated actor, schema, namespace and bounded
`scope.context.viewer` claims; headers, selectors and namespace strings cannot
mint that authority.

A frame replaces the complete selected value and contains `reset`, `from?`,
`to`, `status`, `pending:false` and an opaque checkpoint. The value and owner
sequence are read from the same repeatable database snapshot. Sequence numbers
belong to the schema owner, so different namespaces can interleave. A fresh
attachment or reconnect always sends `reset:true`; this is snapshot replacement,
not historical delta replay. The client rejects gaps in non-reset coverage and
advances its applied checkpoint only after `onSnapshot` succeeds. No raw owner
event payload is exposed.

Owner change notifications are hints. The existing shared owner heartbeat
repairs missed hints and rechecks current viewer authority, including idle
membership revocation. Idle record/list checks retain the original predicate and
probe only previously disclosed IDs; changed owner heads refresh the selected
window. Arbitrary owner projections run again because their closed
identity/authorization dependencies cannot be safely inferred from one owner
head. Applications should keep these projections short and bounded.

There are at most 256 observers per owner and 128 per namespace. Snapshot scans
are serialized per owner, and hints coalesce while a scan is running.
Cancellation removes a waiting scan. Each observer buffers one replacement
snapshot; a slow consumer must reset instead of accumulating an unbounded
history. These are resource bounds, not throughput guarantees. Selection input
is limited to 16 KiB, 512 nodes and 16 levels; output to 1 MiB and 40,000 nodes.
List cursors and relation includes are not accepted by this live-window API. Use
a declared summary projection and explicit UI pagination for large
records/lists.

## Host-only named projections

A Collection may declare a named query with `ownerProjection:true`, required
`inputSchema` and `outputSchema`, and no local `select`, `query` or `filter`. It
must use `ownerPolicy:"required"`. The owner supplies the matching callback
through
`collectionProjections[collectionAlias][queryName].select(input, context)` on
the application/engine options. Missing or undeclared registrations fail before
activation; worker composition rejects these host-only callbacks.

This is the existing Collection named-query primitive. It still enters its
ordinary `query` read/result policy. The context contains an immutable current
`viewer`, fixed `scope`, `commandTime`, `signal`, and a revocable query-only SQL
capability. Browser callers provide only a declared name and validated domain
arguments, never a role or principal to trust. The callback runs only inside the
existing database READ ONLY snapshot and cannot submit owner commands. Its SQL
results use the existing bounded Collection transfer budget; its sanitized
output is bounded, copied, frozen and validated before disclosure. Retained
query handles reject calls after the callback ends.

Projection callbacks must perform no mutations or external side effects and must
return only explicitly whitelisted public fields. A generic raw-row HTTP
constraint cannot authorize a projected aggregate/object; nonempty such filters
fail closed for owner projections. Their explicit current-viewer query policy
and callback must enforce the full projection's authorization instead.
