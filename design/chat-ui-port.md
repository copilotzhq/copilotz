# Chat UI port

Brings the previous chat UX (`@copilotz/chat-ui` 0.82.7 and
`@copilotz/chat-adapter`) back as Copilotz's React front-end plugins, improved
where it simplifies or fixes something. Core stays framework-free. This file is
the **contract** an app builds on; changes to it are listed under "Contract
changes" at the end.

## Current state (before this change)

- `plugins/ui/web.ts:16` is a focus/context workspace (`workspace`, `uiOpen`,
  `uiSwap`, `uiClose`) with a navigator and panes. It has no Space-grouped
  sidebar, resizable panel or header.
- `plugins/core/views/*` render one Card per message (`message/index.tsx:30`), a
  bare textarea composer and a thread table. There is no grouping, sender
  identity, streaming, tool activity or attachments.
- `plugins/ui-kit/styles.css:1` maps six colors; the old chat UI had the full
  shadcn token set, sidebar tokens, radius and highlighting styles.
- Streaming exists on the platform, not in the browser runtime: the LLM call
  publishes `stream.output` lanes (`plugins/llm/actions/call-llm/index.ts:1602`,
  lanes `content`, `reasoning`, `tool-calls`), and Core HTTP serves a
  record-scoped feed, `POST /threads/:id/observe`
  (`plugins/core-http/adapters/http/core/index.ts:262`), which the SDK reads
  with `createCoreClient(client).threads.observe`. `/web` has no stream
  primitive (`design/subscriptions.md:149`, deferred `ctx.readOperation`).

## Layering

| Entry        | Owns                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| `/web/kit`   | Tokens and themes, primitives, patterns, `Markdown`, `Icon`, identity helpers |
| `/core/web`  | Chat Collections, Actions, the thread feed, thread/composer/live Views        |
| `/ui/web`    | The shell: navigation state, sidebar, header, panel, SpaceView, user menu     |
| `/web/react` | The React renderer (unchanged)                                                |

`/ui/web` depends on `/core/web`. Presentational components take plain props and
callbacks; Views read Collections and pass data and Action proxies down. No
component fetches.

## The shell model (one responsive layout)

```
┌ sidebar ─────┬ header ─────────────────────────────┬──────────────┐
│ brand  ⟨⟩    │ title · Space chip · agents   ▣ ⋯   │ right panel  │
│ + New chat   ├─────────────────────────────────────┤ (Space       │
│ search ⌘K    │ main: a conversation, or SpaceView  │  sections,   │
│ Spaces|Recent│                                     │  resizable)  │
│ ▸ Space  (3) │                                     │              │
│   chat …     │                                     │              │
│ No Space     │                                     │              │
│ user menu    │  composer                           │              │
└──────────────┴─────────────────────────────────────┴──────────────┘
```

- Clicking a Space's name opens its SpaceView in main; its chevron expands its
  chats. Clicking a chat opens it. While a chat is open, the header's panel
  toggle shows that chat's Space sections in the right panel.
- Same state at every width. Below `md` the sidebar defaults to the icon rail
  and expands as an overlay; below `lg` the right panel overlays the chat. All
  of this is CSS; there is no `windowWidth` branch and nothing closes itself on
  navigation.

### Navigation state (Collections)

| Collection         | Placement, storage                  | Row `main`                                                                                    |
| ------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `shell`            | browser, `navigation` storage (URL) | `threadId`, `spaceId`, `section`, `panel` (boolean), `origin`                                 |
| `shellPreferences` | browser, `preferences` (local)      | `sidebar` (`auto/expanded/rail`), `groupBy` (`space/date`), `panelWidth`, `theme`, `archived` |
| `shellDialog`      | browser, memory only                | `reference` (`ViewReference \| null`)                                                         |

URL state carries identifiers and scalars only.
`shellUrlStorageAdapter(host,
codec?)` defaults to
`?chat=<id>&space=<id>&section=<id>&panel=1` and preserves other parameters. A
row restored from the URL has `origin: "url"`; the shell then passes its
references through `urlReference`, so only Views that declare `url` render and
their query reads are `held` until a gesture. Any in-app navigation sets
`origin: "app"`.

Browser Actions: `shellOpenThread {threadId}`,
`shellOpenSpace {spaceId,
section?}`, `shellCloseSpace`,
`shellSection {section}`, `shellPanel {open}`, `shellPreference {patch}`,
`shellDialog {reference|null}`. `shellNavigation(()
=> runtime)` is the host
`show` port: `ctx.show(ref, { source: "link" })` opens threads and Spaces
natively and any other View in the dialog host.

## Chat (core)

Collections: `thread`, `message`, `participant`, `space` (server, read-only),
`draft` (browser), `threadFeed`, `threadRun` and `outbox` (browser, memory).

Actions keep the server composition aliases (`createThread`,
`createThreadMessage`, `reviseMessage`, `deleteThreadMessages`,
`addThreadParticipant`, `spaces`, `updateConversation`, `deleteConversation`).
`createCoreWebPlugin({ actionAliases })` renames them for an app whose server
composition differs; `coreWebPlugin` is the default. Browser Actions:

- `sendMessage {threadId, text, files?, recipientIds?}` puts an `outbox` row
  (shown immediately, with Retry on failure), uploads files through
  `adapters.core.feed.upload` when granted (inline base64 under 512 KiB
  otherwise), then calls `createThreadMessage` with a `monotonicUlid` id. It
  omits `recipientIds` unless addressed, so Core defaults to the thread's
  agents.
- `followThread {threadId}` reads the thread feed through
  `adapters.core.feed.observe` and projects it into `threadFeed`/`threadRun`
  (below). The thread View starts it on mount and cancels it on unmount.
- `stopThread {threadId}` cancels the feed's active operations.

Reads: `readThreadMessages` (newest 100 by `createdAt`, the window grows on
"Load older"; ordered live reads arrive with SEC3 round 2, until then the read
reports its refusal and the View says so calmly), threads
`{order: id desc,
limit: 200}` sorted by `updatedAt` in the View, Spaces
`{limit: 200}`.

### Streaming (the smallest correct path)

`threadFeedAdapter(client)` (exported by `/core/web`) wraps the existing SDK
feed: `observe(threadId, {checkpoint, signal, onFrame})`, `cancel(operationId)`
and `upload(file)`. The host grants it as `adapters.core.feed`. Without it the
chat still works from live Collections, only without progressive text.

`followThread` keeps byte-level state (UTF-8 tails, NDJSON partial lines) in its
closure and commits display state at most every 50 ms:

- `threadFeed[threadId].attempts[]`:
  `{ attemptId, operationId, agent, text,
  reasoning, tools: [{ id, name, input, phase }], status, startedAt }`,
  keyed by the stream metadata's `llmAttemptId` and lane, never by timing.
- `threadRun[threadId]`:
  `{ status: "live" | "reconnecting" | "unavailable",
  active: operationIds }`.
  The composer reads only this row, so text chunks never re-render it.

A live attempt is hidden once its persisted message
(`metadata.copilotzWorkflow
.llmAttemptId`) is in the window. Persisted tool
calls (`metadata.llmToolCalls`) pair with tool result messages
(`metadata.toolInvocation.id`) to show running, completed and failed tools
without the feed. Reconnects resume from the last applied checkpoint; renewal is
transparent.

## Extension points (all inert data or Views)

| Slot              | Declare                                                                                                                                      | The View receives                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Branding, labels  | `resources.shell.branding {title, subtitle?, logoUrl?}`, `resources.shell.labels`, `resources.shell.suggestions`, `resources.shell.features` | —                                                 |
| Space sections    | `resources.spaceSections.<id> {label, icon?, order?, view}`                                                                                  | `{spaceId, threadId}`, mode `full` or `panel`     |
| Right panel       | `resources.shell.panel {view}` replaces the default Space sections                                                                           | `{threadId, spaceId}`, mode `panel`               |
| Header menu items | `resources.headerMenu.<id> {label, icon?, order?, action? \| dialog?, destructive?, requires?}`                                              | dialog View: `{threadId, spaceId}`, mode `dialog` |
| User menu items   | `resources.userMenu.<id>` (same shape)                                                                                                       | `{}`                                              |
| Agent selector    | Override View kind `agentSelector` with `resources.views.prefer`                                                                             | `{threadId}`                                      |
| Tool renderers    | `resources.toolRenderers.<toolId> {view, inline?}`                                                                                           | `ToolCallView` (see `/core/web`)                  |
| Markdown plugins  | `adapters.markdown.<alias> {remarkPlugins?, rehypePlugins?}`                                                                                 | —                                                 |
| Image origins     | `resources.markdown.imageOrigins` (unchanged)                                                                                                | —                                                 |

`icon` is a kit icon name (`iconNames` lists them). `action` names a composed
Action alias, called with `{threadId, spaceId}`; `dialog` names a View kind
opened in the shell's dialog host. Built-in sections (`overview`,
`conversations`, `members`) are registered the same way with orders 0, 10 and
90. Apps may override any built-in View with `resources.views.prefer`.

## Kit and tokens

`plugins/ui-kit/styles.css` defines OKLCH tokens for light and `.dark`:
`background foreground card popover primary(-foreground) secondary muted accent
destructive success warning border input ring sidebar(-foreground, -accent,
-border)`,
radius `--radius: 0.75rem` (`sm/md/lg/xl` derived), the Inter/system font stack,
focus rings, scrollbar, prose, code highlighting and KaTeX. Apps brand by
overriding `--primary` (and optionally `--primary-foreground`).
`resources.shell.theme` is not used: the shell toggles `.dark` on the document
from `shellPreferences.theme` (`light/dark/system`).

Primitives (one each): Button, Card, Input, Textarea, Badge, Skeleton, Dialog,
AlertDialog (`ConfirmAction`), Avatar, ScrollArea, Tooltip, Tabs, DropdownMenu
(with checkbox/radio items and sub-menus), Separator, Kbd, Spinner, Field,
NativeSelect, Checkbox, Notice, EmptyState, CopyField. Patterns: Screen, Frame,
ReadStatus, Metric, ResourceTable, PaneBoundary, showSafely, Markdown, Icon,
`identityColor`, `initials`.

## Deletions

`plugins/ui/{workspace.ts, views/workspace, views/panes, views/navigator,
tests/workspace.test.tsx}`,
`workspaceNavigation`, `workspaceUrlStorageAdapter`,
`uiOpen/uiReplace/uiSet/uiRestore/uiSwap/uiClose`, the `workspace` Collection,
`core.threads` (`{list: "thread"}`), `core.message` and the
`resources.navigation` entries. Docs sections on workspace panes go with them.

## Tests

Ported from `chat-ui/tests`: message grouping, ownership, Space grouping, touch
drag, prepend anchor, theme, activity labels, Space form. New happy-dom tests:
sidebar grouping and chevron vs. name, Space vs. chat in main, panel resize and
restored width, composer attachments, feed projection and live activity, app
section/panel/tool renderer, narrow width keeps the same state. Screenshots:
`plugins/ui/demo` (fixture runtime), headless Chrome at 1440×900 and 390×844,
light and dark.

## Contract changes

None yet.
