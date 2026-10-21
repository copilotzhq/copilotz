# Web runtime and Views

Copilotz core is framework-neutral. `/web` supplies the browser runtime, client
Collections, tracked reads, Action proxies, storage ports and locale-aware
formatting. `/views` supplies View definitions, reference resolution and
renderer interfaces. Neither imports React or another UI framework.

Renderer implementations and screens live in plugins. `/web/react` exports the
React adapter. `/web/kit` is the shared design system: tokens and themes,
shadcn/Radix primitives, read states, resource patterns and Markdown, styled
with Tailwind CSS 4. `/core/web` is chat: its Collections, intents, the live
thread feed and the thread, composer and tool Views. `/ui/web` is the chat
shell: sidebar, header, main, the resizable right panel, Spaces and pages.
`/admin/web` and `/usage/web` are the administration page and usage summary.
Apps reuse these Views and kit components and add their own sections, panels,
menus and tool renderers.

```ts
import {
  createBrowserPorts,
  createBrowserRuntime,
  localStorageAdapter,
} from "@copilotz/copilotz/web";
import {
  createCopilotzClient,
  createDeviceTransport,
} from "@copilotz/copilotz/client";
import { reactRenderer } from "@copilotz/copilotz/web/react";
import { threadFeedAdapter } from "@copilotz/copilotz/core/web";
import { adminWebPlugin } from "@copilotz/copilotz/admin/web";
import {
  browserShellHistory,
  shellNavigation,
  shellUrlStorageAdapter,
  uiWebPlugin,
} from "@copilotz/copilotz/ui/web";

// Same-origin browser sessions use the HttpOnly session cookie; the socket
// sends `{ cookie: true }` and never sees the cookie itself.
const device = createDeviceTransport({
  url: "wss://app.example/api/device",
  credentials: () => ({ cookie: true }),
});
const client = createCopilotzClient({ baseUrl: "/api", device });
const runtime = await createBrowserRuntime({
  plugins: [
    uiWebPlugin({ navigation: "url", preferences: "local" }),
    adminWebPlugin,
    appPlugin, // the app's sections, panels, menus and tool renderers
  ],
  ...createBrowserPorts(client),
  // Progressive replies, Stop and uploads go through Core HTTP.
  adapters: { core: { feed: threadFeedAdapter(client) } },
  storage: {
    url: shellUrlStorageAdapter(browserShellHistory(window)),
    local: localStorageAdapter(localStorage, "app:"),
  },
  renderer: reactRenderer,
  show: shellNavigation(() => runtime),
});
const mounted = runtime.mount(element, { shows: "shell", value: null });
// Later: mounted.dispose(); runtime.dispose(); device.close();
```

`live` accepts the SDK's `SubscriptionTransport`; use `createDeviceTransport`
from `/client` for authenticated WebSocket reads (see
[Subscriptions](./subscriptions.md) for credentials, the allowed origin and the
`__Host-copilotz_session` cookie). Each client Collection consumes
`createLiveQuery`, including its applied checkpoint and optimistic settlement.
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
View. Views support `modes: ["full", "panel"]` (and `dialog` or `inline` where
they are shown that way); `ctx.hints.mode` selects density, while other hints
are open-ended. Existing pure text Views and their async read context continue
serving bounded agent-context rendering.

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
        <ReadStatus state={record} noun="record" />
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
keep visual state with React; drafts, navigation and other state that outlives a
component belong in client Collections.

The React adapter embeds each View through
`ViewRendererAdapter.view(output,key)`. Each boundary tracks its own reads; a
composer change does not evaluate its parent or siblings, and a streaming reply
re-renders only its live tail. Unchanged props/hints reuse child output, changed
props reevaluate that child, and removed children release their observations.
Custom renderers can implement the same optional boundary hook; adapters
implementing only `mount` keep the original whole-output rendering contract.
Hints belong to the View they were passed to. Nested `ctx.show` starts with
fresh defaults; pass mode or other hints explicitly when wanted. Only explicit
`source`/`region` hints on that show call go to the host navigation port.

A View sees read-only Collections and Action proxies. Browser Actions get
`ctx.command(collection, id, command, input)`, reusing pure Collection commands.
Server Collections remain read-only. Resources and adapters compose by
namespace, so a later plugin overrides an earlier one's entry by alias (and
`null` hides it); executable aliases must be unique. Browser entry points
contain browser-safe leaves and server Action contracts, never server execute
closures.

## Live reads and optimism

Reads expose `value`, `status`, `pending` and, when stale or denied, `error`
(`{kind, code, message, status?, retryable}`). Status is loading, ready,
missing, stale or denied. The SDK receives an atomic snapshot with owner
sequence and checkpoint, then ordered contiguous `(from,to]` batches. Deltas
carry owner seq and record id; records reconstruct the authorized id-ordered
window. The server owns authorization, projection and limited-window refill.
Only applied batches advance the checkpoint. Revocation clears readable values,
including optimistic overlays.

The server bounds live reads: 16 active subscriptions per socket and 32 per
user; each filter up to 64 predicate nodes and 32 values per `in` list;
`jsonEquals`, case-insensitive matching and filters SQL cannot evaluate are
refused, and so is `order` by any field but `id` until ordered live reads land.
A refused read is stale with `error.code` `subscription_query_refused` or
`subscription_capacity_exceeded`; `ReadStatus` says what happened in plain
words. Identical reads are shared: the runtime keys a read by its collection and
canonical query, so Views asking the same question share one subscription.
`/core/web` builds on that (see
[Core and admin View contracts](#core-and-admin-view-contracts)).

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

Query results add `error?` and `refresh()`. A query read made by a View that a
URL opened has status `held` until a user gesture calls `refresh()`;
`ReadStatus` renders it with a Load button (see
[URL state](#url-state-and-deep-links)). Error kind is denied, unavailable or
invalid; status remains denied for refused reads and stale for
unavailable/invalid results. Refresh starts a fresh query, fences prior
responses and reattaches stale/revoked dependency reads using the current
transport authority. Reauthenticate the device first if session proof changed.
Each attempt has its own idempotency key; there is no polling loop.

The single bounded diagnostic event log exposes local changes, live deltas,
Action transitions and `app.started`. Processors receive live changes, never
restored state or initial snapshots. Dependency delivery errors are isolated
from other observers. Dispose the runtime on logout or scope change.

## Storage

The host chooses a root datum; an app plugin supplies its View. Storage restores
before `app.started` and mounting. `localStorageAdapter` and `urlStorageAdapter`
receive browser capabilities from the host. Attach an adapter by name to a
client Collection's `storage` field; `flushStorage()` surfaces pending save
errors. Only persist state appropriate to the selected storage (especially
URLs).

`urlStorageAdapter` keeps small navigation state, such as a selected ID, a tab
or a page. Its rows are flat records of plain scalars. A URL never carries a
record: a parameter that is malformed or holds a nested value restores as absent
(the Collection's initial rows), and saving a nested row is refused. The shell
uses `shellUrlStorageAdapter` instead (see [The chat shell](#the-chat-shell)).

Browser Actions persist each changed stored Collection once when execute
settles, including commands across awaits. Commands remain immediately visible;
a failed Action persists mutations already applied. Concurrent Actions have
separate batches, and saves are serialized per Collection. `flushStorage()`
waits for queued saves; await an Action result first to include its completed
batch.

Storage adapters may implement `subscribe(listener)` for external changes.
`urlStorageAdapter` and `shellUrlStorageAdapter` listen to history navigation.
Restoration uses the current URL, or the Collection initial value if its
parameter is absent, validates row identities, updates tracked reads and never
writes back. Old pending loads/queued saves cannot overwrite newer navigation or
local commands. `runtime.restoreStorage()` explicitly refreshes all stored
Collections. Runtime disposal removes storage listeners. A custom asynchronous
save already started cannot be cancelled by this interface; such an adapter must
serialize external navigation with its own writes.

Host-selected browser capabilities are injected through `adapters` and read as
`ctx.adapters.namespace.alias`. The host grants these ports explicitly; the core
neither imports UI libraries nor obtains browser capabilities on its own.

## The chat shell

`uiWebPlugin({ navigation, preferences, core })` is one responsive layout:
sidebar (or icon rail), header, main and a resizable right panel. The sidebar
lists Spaces and their chats (or chats by date; the choice is remembered). A
Space's name opens its SpaceView in main; its chevron expands its chats; a chat
opens in main. While a chat is open, the header's panel toggle shows that chat's
Space sections in the right panel. On a narrow screen the sidebar becomes the
icon rail and expands as an overlay, and the panel overlays main with the same
resize handle and width; only its toggle or Escape closes it. The same state
drives every width: nothing reads the window width and nothing closes itself on
navigation.

`navigation` and `preferences` name the storage adapters for the `shell` row
(the URL) and the `shellPreferences` row (per device: sidebar mode, grouping,
panel width, theme, expanded Spaces). `core` is the app's Core plugin instance
when it configures one with `createCoreWebPlugin`. The shell also keeps
`shellOverlay` (palette, dialog, New Space) and `shellToasts` in memory.

Navigation is a set of browser Actions: `shellOpenThread {threadId}`,
`shellOpenSpace {spaceId, section?}`, `shellCloseSpace`,
`shellNewChat {spaceId?}`, `shellOpenPage {page, section?}`,
`shellSection {section}`, `shellPanel {open}`, `shellPreference {…}`,
`shellPalette {open}`, `shellDialog {reference | null}` and
`shellToast {text, tone}`. The host `show` port,
`shellNavigation(() =>
runtime)`, maps `ctx.show(ref, { source: "link" })`:
`thread`, `space` and `newThread` references open in place, a reference shown
with `region: "main"` opens as a page, and any other View opens in the dialog.

Keyboard: ⌘K/Ctrl-K opens search (chats, Spaces, actions), ⌘B/Ctrl-B toggles the
sidebar, ⌘./Ctrl-. toggles the panel, and Escape closes the topmost overlay. The
theme follows `shellPreferences.theme` (light, dark or system) by toggling
`.dark` on the document; set `resources.shell.theme: "host"` to manage it
yourself.

### Chat

`createCoreWebPlugin({ actionAliases?, intents?, commands? })` configures chat;
`coreWebPlugin` is the default. It reads `thread`, `message`, `participant` and
`space` live, and keeps `draft`, `outbox`, `threadFeed`, `threadRun`,
`threadOutputs` and `threadWindow` in the browser. Messages are grouped by
sender with names and avatars; the reader's own messages sit in a bubble, agent
replies read as prose with highlighted code and math. Tool calls and reasoning
show as a compact activity timeline, and an app's tool renderer replaces a
step's default presentation.

The Views call intents, browser Actions over the composed server aliases:
`chatSend`, `chatDiscard`, `chatRevise`, `chatCreateThread`, `chatRenameThread`,
`chatArchiveThread`, `chatDeleteThread`, `chatMoveThread`, `chatCreateSpace`,
`chatUpdateSpace`, `chatDeleteSpace`, `chatAddMember`, `chatRemoveMember`,
`chatAddAgent`, `chatFollow` and `chatStop`. An app whose server Actions take
other inputs replaces single intents:
`createCoreWebPlugin({ intents: { chatCreateSpace: (input, ctx) => … } })`.

`chatSend` shows the message at once from the `outbox` (a failed send keeps
Retry and Discard), uploads attachments through `adapters.core.feed.upload`
(inline up to 512 KiB without it), then calls `createThreadMessage` with a
`monotonicUlid` id. It omits `recipientIds` unless the text @mentions agents, so
Core addresses the thread's agents.

### Streaming

Replies stream through Core HTTP's record-scoped feed,
`POST /threads/:id/observe`. `threadFeedAdapter(client)` from `/core/web` wraps
it (`observe`, `cancel` for Stop, `upload`, `asset`); grant it as
`adapters.core.feed`. The thread View starts `chatFollow`, which projects the
feed's frames with `createFeedProjector`: reply text and reasoning by lane,
provider fallbacks by attempt, tool-call drafts as they are written, and a
tool's live output by its Action run. It commits at most every 50 ms into
`threadFeed`, `threadRun` and `threadOutputs`, so only the live tail and tool
renderers re-render while text streams. A reply settles when its LLM call or
operation ends, and gives way to its persisted message. Without the adapter the
chat still works from live Collections, without progressive replies or Stop.

## Extension points

An app extends the shell with inert data and Views; it never edits shell
components.

| Slot             | Declare                                                                                                                      | The View receives                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Branding, copy   | `resources.shell.branding {title, subtitle?, logoUrl?}`, `.labels`, `.suggestions`, `.features {spaces, attachments, voice}` | —                                                     |
| Identity         | `resources.chat.sender` (the reader), `resources.chat.agents` (participants of new chats)                                    | —                                                     |
| Space sections   | `resources.spaceSections.<id> {label, icon?, order?, view, tools?}`; `null` hides a built-in                                 | `{spaceId, threadId}`, mode `full` or `panel`         |
| Right panel      | `resources.shell.panel {view}` replaces the Space sections in the panel                                                      | `{threadId, spaceId}`, mode `panel`                   |
| Header menu      | `resources.headerMenu.<id> {label, icon?, order?, action?, dialog?, page?, destructive?, requires?}`                         | `{threadId, spaceId}` (dialog mode for `dialog`)      |
| User menu        | `resources.userMenu.<id>` (same shape)                                                                                       | `{}`, or the page value                               |
| Pages            | a menu item's `page: "<kind>"`, or `ctx.show(ref, { source: "link", region: "main" })`                                       | `{section}` or `null`, mode `full`                    |
| Agent selector   | a View for `agentSelector` plus `resources.views.prefer`                                                                     | `{threadId}`                                          |
| Tool renderers   | `resources.toolRenderers.<toolName> {view, inline?}`; the View declares mode `inline`                                        | `ToolCallView` (status, input, result, live `output`) |
| Markdown plugins | `adapters.markdown.<alias> {remarkPlugins?, rehypePlugins?}`                                                                 | —                                                     |
| Images           | `resources.markdown.imageOrigins`                                                                                            | —                                                     |

Built-in Space sections are `overview` (order 0), `conversations` (10) and
`members` (90). A section's `tools` lists tool names; when an agent uses one in
the open chat, its tab gets a dot instead of switching. `icon` is a kit icon
name (`iconNames`). A menu item runs its `action` alias with the input shown,
opens its `dialog` View, or opens its `page`; `requires: "thread"` or `"space"`
limits where it appears. A page is a View kind shown in main; its section lives
in the URL (`?page=<kind>&section=<id>`), and it switches sections with
`ctx.show({ shows: kind, value: { section } }, { source: "link", region:
"main" })`.
Section, panel and page Views must declare `url: true` to render from a link.

### Build a chat app

An app is one plugin composed after the shell. This one brands the shell, adds a
Boards section to Spaces, renders its `terminal` tool, adds a header action and
a settings page:

```tsx
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserPlugin, BrowserViewContext } from "@copilotz/copilotz/web";
import type { ToolCallView } from "@copilotz/copilotz/core/web";
import { ReadStatus, Screen } from "@copilotz/copilotz/web/kit";

const boards = defineView<
  { spaceId: string; threadId?: string | null },
  React.ReactNode,
  BrowserViewContext
>({
  id: "app.boards",
  shows: "appBoards",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render({ spaceId }, ctx) {
    const cards = ctx.collections.card.list({ where: { spaceId }, limit: 100 });
    return (
      <div className="grid gap-2 p-4">
        <ReadStatus state={cards} noun="cards" empty={!cards.value.length} />
        {cards.value.map((card) => <p key={card.id}>{String(card.title)}</p>)}
      </div>
    );
  },
});

const terminal = defineView<ToolCallView, React.ReactNode, BrowserViewContext>(
  {
    id: "app.terminal",
    shows: "appTerminal",
    renderer: "react",
    modes: ["inline"],
    render: (call) => (
      <pre className="bg-muted rounded-md p-3 text-xs">
        {`$ ${String((call.input as { stdin?: string })?.stdin ?? "")}\n${
          call.output?.stdout ?? ""
        }`}
      </pre>
    ),
  },
);

const settings = defineView<
  { section?: string } | null,
  React.ReactNode,
  BrowserViewContext
>({
  id: "app.settings",
  shows: "appSettings",
  renderer: "react",
  modes: ["full"],
  url: true,
  render: (_value, ctx) => <Screen title="Settings" density={ctx.hints.mode} />,
});

export const appPlugin: BrowserPlugin = {
  id: "app",
  views: { boards, terminal, settings },
  collections: { card: { placement: "server" } },
  actions: { threadExport: { id: "app.thread.export", placement: "server" } },
  resources: {
    shell: {
      branding: { title: "Team chat", subtitle: "Plans and research" },
      suggestions: ["Plan the week", "Summarize yesterday's notes"],
    },
    chat: {
      agents: [{
        participantType: "agent",
        externalId: "planner",
        agentId: "planner",
        name: "Planner",
      }],
    },
    spaceSections: {
      boards: {
        label: "Boards",
        icon: "kanban",
        order: 20,
        view: "appBoards",
        tools: ["kanban"],
      },
    },
    toolRenderers: { terminal: { view: "appTerminal" } },
    headerMenu: {
      export: {
        label: "Export",
        icon: "download",
        action: "threadExport",
        requires: "thread",
      },
    },
    userMenu: {
      settings: { label: "Settings", icon: "settings", page: "appSettings" },
    },
  },
};
```

Brand colors are tokens: override `--primary` and `--primary-foreground` (and
`--bubble` for the reader's messages) in the app's stylesheet, for `:root` and
`.dark`. Everything else follows. `contracts/web-demo` is a complete app root
over fixture data, with a demo feed that streams replies and tool output.

## Markdown

Message text may come from an LLM steered by prompt injection or from another
thread participant, so Markdown never fetches anything without a click. The kit
`Markdown` renders GitHub-flavored Markdown, math (KaTeX, with a MathML copy for
assistive technology) and highlighted code with a copy button. It discards raw
HTML (`skipHtml`; there is no raw HTML plugin) and applies
`markdownUrlPolicy({ origin, imageOrigins })` from `/web`, which any Markdown
component can reuse:

- `urlTransform(url, key)` matches react-markdown's option. Links (`href`) keep
  relative URLs and http(s), mailto, xmpp and irc(s); `javascript:` and other
  schemes become `""`. Every other attribute fetches on render, so it keeps only
  a URL that `loadsImage` allows.
- `loadsImage(url)` allows relative and same-origin http(s) images, plus the
  `imageOrigins` the app lists. With no page origin, only relative images load.
- `linkAttributes` is `target="_blank"` with
  `rel="noopener noreferrer nofollow"`.

A refused image renders as its alt text ("Image not loaded" when there is none)
and never as an `img`. Chat reads the allowlist from
`resources.markdown.imageOrigins`, and extra remark/rehype plugins from
`adapters.markdown`; a streaming reply skips highlighting until it settles.

Chat opts into the existing Collection content read contract for text bodies,
with an aggregate 256 KiB limit. Non-text assets remain explicit references that
the message View loads on demand through `adapters.core.feed.asset`. The live
port must honor the read's `content` selection as well as authorization;
snapshots and deltas carry resolved text entries
(`kind: "text", value: string`).

## Kit components and source packaging

`/web/kit` has one set of primitives in the shadcn style: `Button`, `Badge`,
`Card`, `Input`, `Textarea`, `Dialog`, `DropdownMenu` (with checkbox, radio and
sub menus), `Tabs` (content tabs), `TabBar` (navigation tabs with roving focus,
icon-only in narrow containers and an activity dot), `Tooltip`, `Avatar`,
`ScrollArea`, `Separator`, `Kbd`, `Spinner`, `VisuallyHidden`, `Field`,
`NativeSelect`, `Checkbox`, `Notice`, `EmptyState` and `CopyField` (pass the
host's async clipboard function as `copy`). Dialog patterns: `ConfirmDialog`
(controlled; `onConfirm` returns true to close), `ConfirmAction` (a trigger plus
`ConfirmDialog`), `FormDialog` and `NameDescriptionDialog`. While a confirmation
is pending, repeat submissions and dismissal are blocked; a rejected callback
shows its error and allows retry.

Patterns: `Screen` (a title row, actions and content in full or panel density),
`Frame` (a Screen, or a Dialog header in dialog mode), `ReadStatus` (one
vocabulary for loading, empty, held, reconnecting, refused, missing and the live
read limits), `Metric`, `DetailList`, `ResourceTable` (humanized headers,
relative times, figures aligned right), `ResourceToolbar`, `ResourceList`,
`ResourceRow`, `ResourceHeader`, `PaneBoundary` and
`showSafely(ctx, ref,
hints, label?)`, which contains View resolution and render
errors. Also `Markdown`, `Icon` and `iconNames`, `identityColor` and `initials`,
the formatting helpers from `/web` (`formatRelative`, `formatBytes`, …) and
`dom` helpers typed without the DOM library.

All plugin TSX has explicit React value imports and file-level classic JSX
pragmas. Consumers can use their default TSX transform; they need no automatic
JSX override for these sources. Keep a single React/React DOM installation.

Process `plugins/ui-kit/styles.css` with Tailwind CSS 4,
`@tailwindcss/typography` and `tw-animate-css`, including the app's own source
files in scanning. The stylesheet defines the tokens for light and `.dark`
(white and slate, `--radius: 0.5rem`, the system font), the message bubble,
sidebar and code tokens, prose themed through tokens, and reduced motion. It
imports KaTeX's stylesheet, which loads its fonts from `fonts/` next to the
compiled CSS: a pipeline that rebases `url()` (such as Vite) bundles them, and
otherwise copy `katex/dist/fonts/*.woff2` there. Run `deno task build:web-css`
to compile the first-party kit and View styles to `dist/web.css`, with the fonts
in `dist/fonts/`, for a host to include.

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

## URL state and deep links

A link is input from anyone, so URL state carries identifiers only and opens
only Views that opt in.

- **Identifiers only.** A URL holds record IDs, View kinds and plain navigation
  scalars, such as a tab or a page. A View opened from a URL reads its records
  again through its Collections, which authorize every read.
- **Addressable Views.** Only a View that declares `url` can render a reference
  that came from a URL. Any other View is refused:
  `View '<id>' cannot be opened from a URL`. The same View still renders from
  in-app navigation.
- **No submission from the URL.** In a View opened from a URL, `ctx.readAction`
  returns status `held` and calls nothing until a user gesture calls its
  `refresh()`. Starting it during render throws. A View that declares
  `url: { queries: "run" }` starts its query reads immediately; declare it only
  when no query input derives from the URL value. Collection reads are never
  held. A held read applies to the View the URL named; a View it nests with
  `ctx.show` is not held, so a page reads its sections through its own context
  (as the administration page does).

```ts
defineView({ id: "app.record", shows: "record", url: true /* ... */ });
defineView({
  id: "app.report",
  shows: "report",
  url: { queries: "run" }, // its query input is fixed, not read from the URL
  /* ... */
});
```

`shellUrlStorageAdapter(history, codec?)` stores the `shell` row in the URL. The
default codec uses `?chat=<id>&space=<id>&section=<id>&panel=1&new=<id>` and
`&page=<kind>`, drops values that are not identifiers and keeps unrelated
parameters. Opening a chat, a Space or a page pushes a history entry; other
changes replace it. `browserShellHistory(window)` marks the entries the app
writes, so Back restores them as in-app state; anything else (a pasted or shared
link) restores with `origin: "url"`, and the shell renders it through
`urlReference` from `/web`. A custom codec implements
`decode(URL): state | undefined` and `encode(URL, state)`, encodes identifiers
only and preserves unrelated parameters.

The core thread and new-chat Views, the shell's Space, section and page Views,
the admin page, query, agent and participant Views, and the usage summary
declare `url: true`; the admin page and query Views therefore show Load when a
link opens them. The composer, live tail, tool and dialog Views and the admin
Collection inspector are not addressable.

## Core and admin View contracts

Threads display and create the Collection's `name`. `/core/web` exports the
reads its Views share, for apps to reuse in tracked View rendering:

- `readThreads(ctx)`: the reader's newest 200 conversations (id order, which the
  live owner supports), sorted by `updatedAt`.
- `readThread(ctx, id)` and `readSpace(ctx, id)`: one record, served from the
  shared lists when they hold it, so the header, panel, composer and thread add
  no read of their own.
- `readSpaces(ctx)` and `readSpaceThreads(ctx, spaceId)`.
- `readParticipants(ctx, ids)` and `readSenders(ctx, ids)`: people in one `in`
  read per 32 ids, sorted so Views asking for the same people share it.
- `readThreadMessages(ctx, threadId, limit?)` with `messageReadSelection`: the
  thread's newest messages by `createdAt`, returned oldest first by creation
  time and then id, the order Core history uses. Message ids are not a timeline:
  agent replies and tool results use ids derived from the work that produced
  them. Until ordered live reads land the server refuses this read; the thread
  says live updates are unavailable and keeps the messages sent from this device
  visible.

A conversation with its panel open uses five live reads: its messages, its
people, the conversation list, the Space list and its Space's chats.

`createAdminWebPlugin({ actionAliases, core })` uses the same composition
aliases as the server; omitted aliases retain the standard registry values, and
`core` is the app's Core plugin when it configures one. `adminWebPlugin` is the
default instance. With the shell, the user menu gains Administration, which
opens the `admin` page: Overview, Agents, Conversations, People, Activity and
Usage, each read from its authorized query Action. Refusals read as plain
sentences ("You don't have access to this section."). `agent` detail shows
public agent fields from the authorized agents query, and `participant` detail
reads its Collection by ID; both accept `{ id }` and full/panel/dialog
densities.
