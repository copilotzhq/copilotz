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
import {
  createBrowserPorts,
  createBrowserRuntime,
} from "@copilotz/copilotz/web";
import {
  createCopilotzClient,
  createDeviceTransport,
} from "@copilotz/copilotz/client";
import { reactRenderer } from "@copilotz/copilotz/web/react";
import { coreWebPlugin } from "@copilotz/copilotz/core/web";
import { adminWebPlugin } from "@copilotz/copilotz/admin/web";
import { usageWebPlugin } from "@copilotz/copilotz/usage/web";
import {
  uiWebPlugin,
  workspaceNavigation,
  workspaceUrlStorageAdapter,
} from "@copilotz/copilotz/ui/web";

// HTTP and the device socket use the same plain header-map provider.
const sessionHeaders = () => ({ authorization: `Bearer ${sessionProof}` });
const device = createDeviceTransport({
  url: "wss://app.example/api/device",
  credentials: sessionHeaders,
});
const client = createCopilotzClient({
  baseUrl: "/api",
  device,
  getRequestHeaders: sessionHeaders,
});
const runtime = await createBrowserRuntime({
  plugins: [coreWebPlugin, adminWebPlugin, usageWebPlugin, uiWebPlugin("url")],
  ...createBrowserPorts(client),
  storage: {
    // `codec` maps panes to readable parameters; see "Composing workspace panes".
    url: workspaceUrlStorageAdapter({
      read: () => new URL(window.location.href),
      replace: (url) => window.history.replaceState(null, "", url),
      events: window,
    }, codec),
  },
  renderer: reactRenderer,
  show: workspaceNavigation(() => runtime),
});
const mounted = runtime.mount(element, { shows: "workspace", value: null });
// Later: mounted.dispose(); runtime.dispose(); device.close();
```

`live` accepts the SDK's `SubscriptionTransport`; use `createDeviceTransport`
from `/client` for authenticated WebSocket reads (see
[Subscriptions](./subscriptions.md)). Each client Collection consumes
`createLiveQuery`, including its applied checkpoint and optimistic settlement.
The old `LiveReadPort`, `LiveFrame` and `MemoryLiveReads` have been removed.
Tests supply canonical subscription frames through the same transport contract.
An Action transport resolves only on terminal success with `{ value, seq }`, and
reports its accepted operation ID separately so cancellation targets that exact
operation. `createBrowserPorts(client)` is the platform binding for both ports;
apps do not unwrap result envelopes or invent a fallback sequence. Its Action
transport observes terminal completion, reads the result and converts the
decimal owner seq to bigint. Missing/unsafe seq rejects. Returned
`{ok:false,error}` values reject as `ActionFailure` with code/message/status;
thrown SDK refusals keep their structured error. The runtime accepts bigint,
safe numbers or decimal strings from custom transports and uses exact decimal
seq for shared SDK settlement.

## Authoring Views

Use the existing `defineView` with `BrowserViewContext`. Browser rendering is
synchronous so every Collection or query read can be tracked automatically. A
View that a link may open declares `url` (see
[URL state](#url-state-and-deep-links)); without it, URL state cannot name the
View. Views support `modes: ["full", "panel"]`; `ctx.hints.mode` selects
density, while other hints are open-ended. Existing pure text Views and their
async read context continue serving bounded agent-context rendering.

```tsx
const view = defineView<{ id: string }, React.ReactNode, BrowserViewContext>({
  id: "app.record",
  shows: "record",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
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

The React adapter embeds each View through
`ViewRendererAdapter.view(output,key)`. Each boundary tracks its own reads; a
composer change does not evaluate its parent or siblings. Unchanged props/hints
reuse child output, changed props reevaluate that child, and removed children
release their observations. Custom renderers can implement the same optional
boundary hook; adapters implementing only `mount` keep the original whole-output
rendering contract. Hints belong to the View they were passed to. Nested
`ctx.show` starts with fresh defaults; pass mode, pane, width or navigation
hints explicitly when wanted. Only explicit source/region hints on that show
call go to the host navigation port.

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
Dependencies use `{progressOnly:true}` subscriptions with empty queries and no
row/content selection. The owner does not scan or transmit records for them.

Query results add `error?: {kind,code,message,status?,retryable}` and
`refresh()`. A query read made by a View that a URL opened has status `held`
until a user gesture calls `refresh()`; `ReadStatus` renders it with a Load
button (see [URL state](#url-state-and-deep-links)). Error kind is denied,
unavailable or invalid; status remains denied for refused reads and stale for
unavailable/invalid results. Refresh starts a fresh query, fences prior
responses and reattaches stale/revoked dependency reads using the current
transport authority. Reauthenticate the device first if session proof changed.
Each attempt has its own idempotency key; there is no polling loop.

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

`urlStorageAdapter` keeps small navigation state, such as a selected ID, a tab
or a page. Its rows are flat records of plain scalars. A URL never carries a
record: a parameter that is malformed or holds a nested value restores as absent
(the Collection's initial rows), and saving a nested row is refused. Workspace
panes use `workspaceUrlStorageAdapter` instead.

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

Message text may come from an LLM steered by prompt injection or from another
thread participant, so Markdown never fetches anything without a click. Its URL
policy is `markdownUrlPolicy({ origin, imageOrigins })` from `/web`, which any
Markdown component can reuse:

- `urlTransform(url, key)` matches react-markdown's option. Links (`href`) keep
  relative URLs and http(s), mailto, xmpp and irc(s); `javascript:` and other
  schemes become `""`. Every other attribute fetches on render, so it keeps only
  a URL that `loadsImage` allows.
- `loadsImage(url)` allows relative and same-origin http(s) images, plus the
  `imageOrigins` the app lists. With no page origin, only relative images load.
- `linkAttributes` is `target="_blank"` with
  `rel="noopener noreferrer nofollow"`.

The kit `Markdown` applies this policy with the page origin and an
`imageOrigins` prop. It renders a refused image as its alt text ("Image not
loaded" when there is none) and never as an `img`. The core message View reads
the allowlist from `resources.markdown.imageOrigins`:

```ts
const appPlugin = {
  id: "app",
  resources: { markdown: { imageOrigins: ["https://cdn.example"] } },
};
```

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

Browser Actions persist each changed stored Collection once when execute
settles, including commands across awaits. Commands remain immediately visible;
a failed Action persists mutations already applied. Concurrent Actions have
separate batches, and saves are serialized per Collection. `flushStorage()`
waits for queued saves; await an Action result first to include its completed
batch.

Storage adapters may implement `subscribe(listener)` for external changes.
`urlStorageAdapter` and `workspaceUrlStorageAdapter` listen to popstate through
the injected `events` target. Restoration uses the current URL, or the
Collection initial value if its parameter is absent, validates row identities,
updates tracked reads and never writes back. Old pending loads/queued saves
cannot overwrite newer navigation or local commands. `runtime.restoreStorage()`
explicitly refreshes all stored Collections. Runtime disposal removes storage
listeners. A custom asynchronous save already started cannot be cancelled by
this interface; such an adapter must serialize external navigation with its own
writes.

Operation streams and agent lanes are not yet browser read primitives. The
concrete proposed contract and required tests are in
[the LIVE follow-up design](../design/subscriptions.md#live-follow-up-browser-integration).

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

| Action alias | Command   | Input and behavior                                                                                                                                                                                                                           |
| ------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uiOpen`     | `open`    | `{ reference, source?, region?, mode? }`; navigator/command/url choose focus and demote the previous focus; `source: "url"` admits identifiers only (URL state); links choose context; `mode: "dialog"` or `region: "dialog"` opens a dialog |
| `uiReplace`  | `replace` | `{ reference, region? }`; replace only that region without demotion (default context)                                                                                                                                                        |
| `uiSet`      | `set`     | `{ focus?, context?, dialog? }`; exact snapshot, omitted regions become null                                                                                                                                                                 |
| `uiRestore`  | `restore` | Same exact snapshot semantics; for saved in-app state, never URL-decoded panes                                                                                                                                                               |
| `uiSwap`     | `swap`    | Exchange focus/context, preserving dialog                                                                                                                                                                                                    |
| `uiClose`    | `close`   | `{ region? }`; clear just that region (default context)                                                                                                                                                                                      |

### URL state and deep links

A link is input from anyone, so URL state carries identifiers only and opens
only Views that opt in.

- **Identifiers only.** A URL holds record IDs, View kinds and plain navigation
  scalars, such as a tab or a page. A View opened from a URL reads its records
  again through its Collections, which authorize every read. A pane whose value
  is not a scalar or a flat record of scalars is dropped as it is restored.
- **Addressable Views.** Only a View that declares `url` can render a reference
  that came from a URL. Any other View, such as the core message View, is
  refused in its pane: `View '<id>' cannot be opened from a URL`. The same View
  still renders from in-app navigation.
- **No submission from the URL.** In a View opened from a URL, `ctx.readAction`
  returns status `held` and calls nothing until a user gesture calls its
  `refresh()`. Starting it during render throws. A View that declares
  `url: { queries: "run" }` starts its query reads immediately; declare it only
  when no query input derives from the URL value. Collection reads are never
  held.

```ts
defineView({ id: "app.record", shows: "record", url: true /* ... */ });
defineView({
  id: "app.report",
  shows: "report",
  url: { queries: "run" }, // its query input is fixed, not read from the URL
  /* ... */
});
```

The core thread and conversation-list Views, the admin overview, query, agent
and participant Views, and the usage summary declare `url: true`. The admin
query and agent Views therefore show a Load button when a link opens them. The
message and composer Views, the admin Collection inspector and the workspace
layout Views are not addressable.

`urlReference(candidate)` from `/web` applies the identifier rule and marks an
admitted reference `origin: "url"`, which the runtime checks before rendering.
`workspaceUrlStorageAdapter` admits every decoded pane through it, and
`uiOpen({ reference, source: "url" })` does the same, refusing a non-identifier
value. Never pass URL-decoded references to `uiSet`, `uiRestore` or `uiReplace`;
those take trusted in-app state.

Use `workspaceUrlStorageAdapter(host, codec)` for readable deep links. The host
supplies `read(): URL`, `replace(URL)` and, for history navigation, an `events`
target such as `window`. The codec supplies
`decode(URL): WorkspaceState | undefined` and
`encode(URL, WorkspaceState): void`. The adapter copies the URL before encoding.
The codec owns route conventions, encodes identifiers only and must preserve
unrelated parameters. Attach it as the storage named by `uiWebPlugin("url")`. It
restores before the first View mounts, saves through `runtime.flushStorage()`,
and on popstate restores through the same admission. An undefined decode means
the route does not belong to the workspace; the host should choose its
appropriate root View instead.

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
