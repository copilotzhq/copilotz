---
title: "View foundation"
description: "Compose scoped pure one-shot text presentations with the bounded V1 View primitive."
section: Runtime
order: 15
status: experimental
---

# View foundation (V1)

## The pain

An application needs different presentations of the same authorized data without
copying rendering decisions into every caller.

## The problem

Presentation selection must be unambiguous, and rendering must not gain access
to raw records, storage writes or provider adapters.

## The solution

Views are the sixth plugin primitive. This portable foundation implements F3 §8
authoring, composition resolution, restricted context and pure one-shot
rendering. It does not implement owner/worker conversion, live React rendering,
context assembly/channel egress wiring or the per-role build outputs of F3 §9.

```ts
import {
  createPluginRegistry,
  createTextRenderer,
  definePlugin,
  defineView,
} from "@copilotz/copilotz";

const summary = defineView({
  id: "boards.summary",
  shows: "board",
  renderer: "text",
  modes: ["context"],
  render: (board: { title: string }, ctx) => board.title,
});
const plugin = definePlugin({ id: "boards", version: "1", views: { summary } });
const registry = createPluginRegistry({ plugins: [plugin] });
const renderer = createTextRenderer({
  registry,
  scope: { principal: "agent" },
  // The host must authorize the reference for this scope and return only safe
  // public/projected fields. Never pass raw hidden or protected fields through.
  project: async (reference, { scope, signal }) => ({
    title: "Authorized title",
  }),
});
await renderer.render({ shows: "board", value: { id: "board-1" } });
```

## Reference

### Resolution and reference forms

The bounded V1 renderer input envelope is `{ shows, value }`. It is an explicit
projection binding, not the finalized public UI/Action reference syntax;
kind-keyed UI references and typed owner references remain integration work. The
value is opaque to the framework until the host's mandatory `project` callback
authorizes and projects it. `shows` is a record/named-datum kind string,
`{ list: "kind" }`, `{ action: "action.id" }` or `{ navigation: "name" }`. These
are separate data kinds. Mode names are open-ended and default to `context`;
renderer defaults to `text`.

Views resolve by data kind, mode and renderer. Stable IDs and composition
aliases are unique. Overlapping modes fail composition unless the final Resource
overlay explicitly selects a candidate:

```ts
resources: {
  views: {
    prefer: [{ shows: "board", mode: "context", renderer: "text", view: "boards.summary" }],
  },
}
```

A preference cannot replace an executable ID or select a nonmatching View. With
no matching View, the generic renderer uses only the authorized projection.
Rendering never serializes the raw reference as a fallback.

### Restricted context and lifecycle

The one-shot context exposes only `collections`, `actions`, `resources`,
`scope`, `signal`, `show` and `hints`. Host-supplied Collection capabilities
expose authorized `get` and `list` reads returning `{ value, status, pending }`;
they must enforce the viewer's scope. Their results and the supplied
scope/resources/projections are snapshotted as isolated inert data. No
persistence, writes, transactions, adapters, subscription or tracking capability
is exposed. These snapshots are readonly in TypeScript, not frozen at runtime;
changing a local scope snapshot cannot change the host’s projection authority.

In pure one-shot rendering, declared Action names are present but reject
invocation without calling the host. Interactive Action invocation is deferred
to later renderer integration. This is a capability boundary for trusted plugin
authoring, not a JavaScript sandbox for malicious code.

`ctx.show` resolves a nested reference through the same authorized projector and
viewer scope. It inherits mode/renderer unless explicitly overridden.
Cross-renderer nesting requires a host-supplied one-shot renderer adapter; a
missing adapter fails rather than silently using a different medium. A render
has a bounded nesting depth (32 by default), parent-linked abort signals and
per-renderer session cleanup. Each captured context expires when its own render
ends, before session disposal. The owning render cancels detached nested work
and drains its cleanup before settling. There are no tracking/subscription
hooks, and adapters may evaluate each View at most once.

A host can override the text adapter or supply additional one-shot adapters
through `renderers`. Each adapter opens a scoped session with `render(evaluate)`
and optional `dispose()`. Disposal runs on success, failure or cancellation.
Adapter cleanup must itself finish; this foundation cannot force an
uncooperative host callback to release its resources. Like all in-process plugin
code, an uncooperative render function cannot be forcibly stopped, but
subsequent framework reads/nesting are fenced by the abort signal.

### Build boundary

`views/` leaves use the same default-export/index conventions as other
executable primitives. The existing build discovers and deterministically emits
them in `plugin.generated.ts`. Full owner/worker/web output separation remains a
later slice; V1 does not claim its import-graph conformance.

## What this unlocks

First-party plugins can supply reusable, scoped one-shot text presentations.
`ViewReference` and the string-returning one-shot `ViewContext` are bounded V1
renderer plumbing; the full live/UI API is still pending, with no compatibility
promise across future renderer interfaces.

## Next steps

See [Plugins and Processors](plugins-and-processors.md) for composition and
[Collections](collections.md) for scoped application reads.
