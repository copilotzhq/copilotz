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
  live: liveReadPort,
  actions: actionTransport,
  renderer: reactRenderer,
  show: workspaceNavigation(() => runtime),
});
const mounted = runtime.mount(element, { shows: "workspace", value: null });
// Later: mounted.dispose(); runtime.dispose();
```

`LiveReadPort` and `ActionTransport` are small integration contracts, not a new
server protocol. The subscription track supplies the real live transport. For
embedded use and deterministic tests, `/web` exports `MemoryLiveReads`. No
polling or chat projection/reconciliation engine is included. An Action
transport resolves only on terminal success with `{ value, seq }`, and reports
its accepted operation ID separately so cancellation targets that exact
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
stale or denied. A live port delivers an atomic snapshot with owner sequence and
checkpoint, then ordered contiguous `(from,to]` deltas. Upserts include order
keys; removals discard lost membership. The server owns authorization,
projection and limited-window refill. Only applied batches advance the
checkpoint. Revocation clears readable values, including optimistic overlays.

An Action's `optimistic` declaration names a Collection, pure command and
record-ID selector. Each invocation has its own layer. Failure removes only that
layer; concurrent server state survives. A successful operation records its
terminal owner `seq`. Each read retires the layer after applying through that
seq, including an empty progress batch or a replacement snapshot. Acceptance is
never settlement.

Query Actions declare `query: { reads: [collectionNames] }`. Views call
`ctx.readAction(alias, input)`. Results are shared by input, invalidated by live
progress on declared Collections, and fenced against late responses. Admin Views
use the existing admin Actions this way; they have no independent fetch effects.

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

## Kit components and source packaging

The kit also exports Radix `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`, and
`DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`,
`DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuSeparator`. Forms share
`Field` (a generated label/control ID), `NativeSelect` and `Checkbox`. Feedback
uses `Notice`, `EmptyState` and `CopyField`; pass the host's async clipboard
function to `CopyField` as `copy`.

`ConfirmAction` wraps a trigger and a Dialog. Its `onConfirm` returns true to
close or false to remain open. Rejected callbacks display an error and allow
retry. While pending, repeat submissions and dismissal are blocked. Both Stop
and other disruptive app actions can use the same confirmation pattern.

`Frame` takes `{ ctx, title, description?, actions?, children? }`: full/panel
modes render a Screen, while dialog mode supplies a Dialog title and description
inside the host's Dialog. Actions are available in every mode. The UI pane host
renders dialog content full-screen on small viewports and as a bounded modal on
larger ones. `PaneBoundary` contains component failures;
`showSafely(ctx, ref,
hints, label?)` additionally contains synchronous View
resolution/render errors. Changing the reference resets the boundary. Reads
still run synchronously in the tracked View evaluation.

All plugin TSX has explicit React value imports and file-level classic JSX
pragmas. Consumers can use their default TSX transform; they need no automatic
JSX override for these sources. Keep a single React/React DOM installation.

The npm source package exports `@copilotz/copilotz/web/kit/styles.css`. Import
it into the host's Tailwind CSS 4 pipeline, alongside the host's source
scanning. The npm manifest mirrors every executable JSR export and includes all
TS/TSX sources; use a bundler that compiles dependency TS/TSX. For the npm
aliases of JSR dependencies, configure `@jsr:registry=https://npm.jsr.io` in the
consuming project's `.npmrc`. React and React DOM are peer dependencies.

JSR's Deno 2.9.2 publisher rejects CSS as an export entry. The same stylesheet
is included in the JSR archive at `plugins/ui-kit/styles.css`, but cannot be a
JSR export. JSR-only hosts can vendor that asset from the pinned release or use
the repository's `build:web-css` task. This is an asset packaging distinction;
both distributions use the same components and stylesheet. `check:surface`
verifies npm/JSR export parity and publication inclusion; package contracts
check the npm archive and a consumer without JSX compiler options.
`npm pack --dry-run` previews the source archive; the release workflow still
publishes JSR.

## Composing workspace panes and navigation

`ui.workspace` (shows `workspace`) is now a composition of two independent
Views:

- `ui.panes` (shows `workspacePanes`) reads `workspace.main` and owns focus,
  context, swap/close controls, pane error boundaries and dialogs.
- `ui.navigator` (shows `workspaceNavigator`) owns resource navigation and the
  ⌘K/Ctrl-K palette. It does not read or render the panes.

The View definitions are exported as `panes`, `navigator` and `workspace` from
`/ui/web`. An app root View can render its own navigator next to
`ctx.show({ shows: "workspacePanes", value: null })`. Call `ctx.show` during the
root View's render to preserve read tracking; do not defer it to a React effect.
The default workspace continues to compose the provided navigator and panes.

`workspace.main` contains `focus`, `context`, and `dialog`, each a ViewReference
or null. Focus renders full, context renders panel, and dialog renders dialog.
The browser Actions invoke these Collection commands atomically:

| Action alias | Command   | Input and behavior                                                                                                                                                                      |
| ------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uiOpen`     | `open`    | `{ reference, source?, region?, mode? }`; navigator/command/url choose focus and demote the previous focus; links choose context; `mode: "dialog"` or `region: "dialog"` opens a dialog |
| `uiReplace`  | `replace` | `{ reference, region? }`; replace only that region without demotion (default context)                                                                                                   |
| `uiSet`      | `set`     | `{ focus?, context?, dialog? }`; exact snapshot, omitted regions become null                                                                                                            |
| `uiRestore`  | `restore` | Same exact snapshot semantics; suitable for history or saved state                                                                                                                      |
| `uiSwap`     | `swap`    | Exchange focus/context, preserving dialog                                                                                                                                               |
| `uiClose`    | `close`   | `{ region? }`; clear just that region (default context)                                                                                                                                 |

Use `workspaceUrlStorageAdapter(host, codec)` for readable deep links. The host
supplies `read(): URL` and `replace(URL)`; the codec supplies
`decode(URL): WorkspaceState | undefined` and
`encode(URL, WorkspaceState): void`. The adapter copies the URL before encoding.
The codec owns route conventions and must preserve unrelated parameters. Attach
it as the storage named by `uiWebPlugin("url")`. It restores before the first
View mounts and saves through `runtime.flushStorage()`. On browser history
navigation, call
`runtime.actions.uiRestore(codec.decode(new URL(location.href))).result()` for a
workspace route. An undefined decode means the route does not belong to the
workspace; the host should choose its appropriate root View instead.

```ts
const codec = {
  decode(url: URL) {
    const id = url.searchParams.get("thread");
    return {
      focus: id ? { shows: "thread", value: { id } } : null,
      context: null,
      dialog: null,
    };
  },
  encode(url: URL, state: WorkspaceState) {
    const id = state.focus?.shows === "thread"
      ? (state.focus.value as { id: string }).id
      : undefined;
    if (id) url.searchParams.set("thread", id);
    else url.searchParams.delete("thread");
  },
};
// This example stores only the thread focus; richer codecs encode all regions.
```

## Core and admin View contracts

Threads display and create the Collection's `name`. `/core/web` exports
`messageReadSelection` (the bounded text content options) and
`readThreadMessages(ctx, threadId)` (the canonical thread query using those
options). Apps reuse these in tracked View rendering.

`createAdminWebPlugin({ actionIds: { agents: "app.admin.agents" } })` binds
Action aliases to configured server IDs; omitted IDs retain the standard
registry values. `adminWebPlugin` is the default instance. All query Views,
including the agent detail View, read aliases. `agent` detail shows public agent
fields from the authorized agents query, and `participant` detail reads its
Collection by ID. Both accept `{ id }` and full/panel/dialog densities. Admin
list links open those details through the host's navigation port.
