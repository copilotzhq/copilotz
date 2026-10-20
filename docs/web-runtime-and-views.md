# Web runtime and Views

Copilotz core is framework-neutral. `/web` supplies the browser runtime, client
Collections, tracked reads, Action proxies and storage ports. `/views` supplies
View definitions, reference resolution and renderer interfaces. Neither imports
React or another UI framework.

Renderer implementations and screens live in plugins. `/web/react` exports the
React adapter. `/web/kit` is the shared shadcn/Radix kit, styled with Tailwind
CSS 4. `/core/web`, `/admin/web` and `/usage/web` export browser leaves of those
plugins. `/ui/web` supplies workspace layout and navigation. Apps reuse those
same Views and kit components, and add their own app root View.

```ts
import { createBrowserRuntime } from "@copilotz/copilotz/web";
import { reactRenderer } from "@copilotz/copilotz/web/react";
import { coreWebPlugin } from "@copilotz/copilotz/core/web";
import { adminWebPlugin } from "@copilotz/copilotz/admin/web";
import { usageWebPlugin } from "@copilotz/copilotz/usage/web";
import { uiWebPlugin, workspaceNavigation } from "@copilotz/copilotz/ui/web";

// Ports are bound to this authenticated session by the host.
const runtime = await createBrowserRuntime({
  plugins: [coreWebPlugin, adminWebPlugin, usageWebPlugin, uiWebPlugin()],
  live: device,
  actions: actionTransport,
  renderer: reactRenderer,
  show: workspaceNavigation(() => runtime),
});
const mounted = runtime.mount(element, { shows: "workspace", value: null });
// Later: mounted.dispose(); runtime.dispose();
```

`live` accepts the SDK's `SubscriptionTransport`; use `createDeviceTransport`
from `/client` for authenticated WebSocket reads (see
[Subscriptions](./subscriptions.md)). Each client Collection consumes
`createLiveQuery`, including its applied checkpoint and optimistic settlement.
The old `LiveReadPort`, `LiveFrame` and `MemoryLiveReads` have been removed.
Tests supply canonical subscription frames through the same transport contract.
An Action transport resolves only on terminal success with `{ value, seq }`, and
reports its accepted operation ID separately so cancellation targets that exact
operation.

## Authoring Views

Use the existing `defineView` with `BrowserViewContext`. Browser rendering is
synchronous so every Collection or query read can be tracked automatically.
Views support `modes: ["full", "panel"]`; `ctx.hints.mode` selects density,
while other hints are open-ended. Existing pure text Views and their async read
context continue serving bounded agent-context rendering.

```tsx
const view = defineView<{ id: string }, React.ReactNode, BrowserViewContext>({
  id: "app.record",
  shows: "record",
  renderer: "react",
  modes: ["full", "panel"],
  render({ id }, ctx) {
    const record = ctx.collections.record.get(id);
    return (
      <Screen title="Record" density={ctx.hints.mode}>
        <ReadStatus state={record} />
        <p>{String(record.value?.title ?? "")}</p>
      </Screen>
    );
  },
});
```

`runtime.observe(read)` returns `getSnapshot`, `subscribe` and `dispose`. It
tracks conditional reads anew on each evaluation and detaches unused
subscriptions. The React adapter subscribes with `useSyncExternalStore`. Read
Collections in the View's render function, then pass data to React components;
deferred component rendering is outside the core tracking scope. Components may
keep visual state with React; drafts, selected records and panes belong in
client Collections.

A View sees read-only Collections and Action proxies. Browser Actions get
`ctx.command(collection, id, command, input)`, reusing pure Collection commands.
Server Collections remain read-only. Resources and adapters compose by
namespace; executable aliases must be unique. Browser entry points contain
browser-safe leaves and server Action contracts, never server execute closures.

## Live reads and optimism

Reads expose `value`, `status` and `pending`. Status is loading, ready, missing,
stale or denied. The SDK receives an atomic snapshot with owner sequence and
checkpoint, then ordered contiguous `(from,to]` batches. Deltas carry owner seq
and record id; records reconstruct the authorized id-ordered window. The server
owns authorization, projection and limited-window refill. Only applied batches
advance the checkpoint. Revocation clears readable values, including optimistic
overlays.

An Action's `optimistic` declaration names a Collection, pure command and
record-ID selector. Each invocation has its own layer. Failure removes only that
layer; concurrent server state survives. A successful operation records its
terminal owner `seq`. Each read retires the layer after applying through that
seq, including an empty progress batch or a replacement snapshot. Acceptance is
never settlement.

Query Actions declare `query: { reads: [collectionNames] }`. Views call
`ctx.readAction(alias, input)`. Results are shared by input, invalidated by live
Collection mutations (including outside the subscribed window), and fenced
against late responses. Empty owner progress settles optimism without restarting
a query Action, so its own result cannot cause a refresh loop. Admin Views use
the existing admin Actions this way; they have no independent fetch effects.

The single bounded diagnostic event log exposes local changes, live deltas,
Action transitions and `app.started`. Processors receive live changes, never
restored state or initial snapshots. Dependency delivery errors are isolated
from other observers. Dispose the runtime on logout or scope change.

## Layout, start and storage

The host chooses a root datum; an app plugin supplies its View. Storage restores
before `app.started` and mounting. `localStorageAdapter` and `urlStorageAdapter`
receive browser capabilities from the host. Attach an adapter by name to a
client Collection's `storage` field; `flushStorage()` surfaces pending save
errors. Only persist state appropriate to the selected storage (especially
URLs).

The ui plugin owns `workspace`, `uiOpen`, `uiSwap` and `uiClose`. Navigator,
command palette (⌘K/Ctrl-K) and URL opens choose focus; item links and live
agent work choose context. Focus renders full, context renders panel, and ⇄
swaps them. Core only understands references, Views, `ctx.show` and hints. Call
`ctx.show(ref,
{ source: "link" })` in event handlers to use the layout port.

## Shared UI and migration

Process `plugins/ui-kit/styles.css` with Tailwind CSS 4 and
`@tailwindcss/typography`, including the app's own source files in scanning. Use
one React/React DOM instance in the host bundle. Repository tests use Deno's
local npm layout for Radix's CommonJS transitive dependencies.

The kit consolidates the existing chat UI's shadcn controls and adds shared
Screen, ReadStatus, Metric, ResourceTable and Markdown components. Chat supplies
thread, message, composer and thread-list Views; admin supplies overview, query
sections and Collection inspection; usage supplies ledger summaries. Sender
identity comes from an app's `resources.chat.sender` and is still authorized by
the server. Markdown discards raw HTML, filters unsafe URLs and renders code as
escaped text.

The old external packages are read-only migration inputs, not dependencies of
the new Views. Host-specific media/voice and attachment ingestion still require
host capabilities; no old projection engine is copied into the browser runtime.

Chat opts into the existing Collection content read contract for text bodies,
with an aggregate 256 KiB limit. Non-text assets remain explicit references. The
live port must honor the read's `content` selection as well as authorization;
snapshots and deltas carry resolved text entries
(`kind: "text", value: string`).

Run `deno task build:web-css` to compile the first-party kit and View styles to
`dist/web.css` for a host to include.

Host-selected browser capabilities can be injected through `adapters` and read
as `ctx.adapters.namespace.alias`. The host grants these ports explicitly; the
core neither imports UI libraries nor obtains browser capabilities on its own.
