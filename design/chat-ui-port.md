# Chat UI port

Brings the previous chat UX (`@copilotz/chat-ui` 0.82.7 and
`@copilotz/chat-adapter`) back as Copilotz's React front-end plugins, improved
where it simplifies or fixes something (see the UX audit's P1 list). Core stays
framework-free. This file is the **contract** an app builds on; changes after
the first commit are listed at the end.

## Current state (before this change)

- `plugins/ui/web.ts` was a focus/context workspace (`workspace`, `uiOpen`,
  `uiSwap`, `uiClose`) with a navigator and panes: no Space-grouped sidebar,
  resizable panel or header.
- `plugins/core/views/*` rendered one Card per message, a bare composer and a
  thread table: no grouping, identity, streaming, tool activity or attachments.
- `plugins/ui-kit/styles.css` mapped six colors.
- Streaming exists on the platform: the LLM call publishes `stream.output` lanes
  (`plugins/llm/actions/call-llm/index.ts:1602`: `content`, `reasoning`,
  `tool-calls`), every Action stream carries `sourceActionRunId`
  (`runtime/actions/execution-context.ts:36`), and Core HTTP serves a
  record-scoped feed, `POST /threads/:id/observe`
  (`plugins/core-http/adapters/http/core/index.ts:262`). `/web` had no stream
  primitive (`design/subscriptions.md:149` defers `ctx.readOperation`).

## Layering

| Entry       | Owns                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------- |
| `/web`      | `format.ts`: locale-aware `formatWhen/Relative/Bytes/Count/Duration`, `recencyGroup`        |
| `/web/kit`  | Tokens and themes, primitives, `ReadStatus`, resource patterns, `Markdown`, `Icon`, `dom`   |
| `/core/web` | Chat Collections, intents (browser Actions), the thread feed, thread/composer/live Views    |
| `/ui/web`   | The shell: navigation state, sidebar, header, panel, SpaceView and sections, pages, palette |

`/ui/web` composes `/core/web` (`uiWebPlugin({ core })`). Presentational
components take plain props; Views read Collections and pass data and Action
proxies down. No component fetches.

## Shell model: one responsive layout

Sidebar (or icon rail) · header · main · resizable right panel. The Space name
opens its SpaceView in main; the chevron expands its chats; a chat opens in
main; while a chat is open the header toggle shows that chat's Space sections in
the panel. Below `lg` the sidebar is the rail and expands as an overlay, and the
panel overlays main, keeping its resize handle and width; Escape or the toggle
closes it. All of this is CSS (container and media queries); nothing reads the
window width and nothing closes itself on navigation.

### State (client Collections, row `main`)

| Collection         | Storage                       | Fields                                                                                                                                                            |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell`            | `navigation` (the URL)        | `threadId`, `spaceId`, `section`, `panel`, `newIn`, `page`, `origin`                                                                                              |
| `shellPreferences` | `preferences` (local storage) | `sidebar` (`auto/expanded/rail`), `groupBy` (`space/date`, default `space`), `panelWidth`, `theme` (`light/dark/system`), `archived`, `expanded[]`, `collapsed[]` |
| `shellOverlay`     | memory                        | `palette`, `dialog` (a `ViewReference`), `createSpace`                                                                                                            |
| `shellToasts`      | memory                        | one row per notice                                                                                                                                                |

`shellUrlStorageAdapter(browserShellHistory(window), codec?)` keeps identifiers
only (default `?chat=&space=&section=&panel=1&new=&page=`, unrelated parameters
kept). A chat, Space or page change pushes a history entry; the rest replaces
it. State restored from a link has `origin: "url"`, so the shell renders it
through `urlReference`: only Views that declare `url` render, and their query
reads are `held` until a gesture. In-app navigation is `app`.

Browser Actions: `shellOpenThread {threadId}`,
`shellOpenSpace {spaceId,
section?}`, `shellCloseSpace`,
`shellNewChat {spaceId?}`, `shellOpenPage {page, section?}`,
`shellSection {section}`, `shellPanel {open}`, `shellPreference {…}`,
`shellOverlay {…}`, `shellPalette {open}`, `shellDialog {reference|null}`,
`shellToast {text,
tone}`. Host `show` port: `shellNavigation(() => runtime)`
opens `thread`, `space` and `newThread` references in place, a reference shown
with `region: "main"` (value `null` or `{section}`) as a page, and any other
View in the dialog.

A page is a View kind in main (an app's settings, the administration page). It
receives `{section}` when the shell's `section` is set, otherwise `null`; the
header shows the label of the menu item that opens it and a Close button.

## Chat (core)

`createCoreWebPlugin({ actionAliases?, intents?, commands? })`; `coreWebPlugin`
is the default. Collections: `thread`, `message`, `participant`, `space`
(server; `thread` and `space` have a `patch` command for optimistic overlays,
`commands` adds more), `draft`, `outbox`, `threadFeed`, `threadRun`,
`threadOutputs`, `threadWindow` (browser).

Intents are browser Actions over the composed server aliases (defaults
`createThread`, `createThreadMessage`, `reviseMessage`, `addThreadParticipant`,
`spaces`, `updateConversation`, `deleteConversation`): `chatSend`,
`chatDiscard`, `chatRevise`, `chatCreateThread`, `chatRenameThread`,
`chatArchiveThread`, `chatDeleteThread`, `chatMoveThread`, `chatCreateSpace`,
`chatUpdateSpace`, `chatDeleteSpace`, `chatAddMember`, `chatRemoveMember`,
`chatAddAgent`, `chatFollow`, `chatStop`; plus `chatLoadOlder` and `setDraft`.
An app whose server Actions take other inputs replaces single intents
(`intents.chatCreateSpace = (input, ctx) => ctx.actions.space({…})`).

`chatSend` writes an `outbox` row (shown at once; failed sends keep Retry and
Discard), uploads files through `adapters.core.feed.upload` (inline base64 up to
512 KiB without it), then calls `createThreadMessage` with a `monotonicUlid` id,
omitting `recipientIds` unless @mentioned so Core defaults to the thread's
agents. New conversations add `resources.chat.agents`.

Reads: `readThreadMessages(ctx, id, limit)` (newest by `createdAt`, the window
grows by 100 on "Load older"), `readThreads` (a live window ordered by
`updatedAt`), `readSpaces` (by name), `readSpaceThreads` (by `updatedAt`), and,
served from those shared lists when they hold the record, `readThread` and
`readSpace`. People are `readParticipants` (one `in` read per 32 sorted ids;
`readSenders` builds on it), so the thread, composer and agent selector share
one read. A chat with its panel open uses five live reads (messages, people,
conversations, Spaces, the Space's chats), well inside SEC3's 16 per socket. A
refused read keeps its code and `reason` (`query_unsupported`, `limit_exceeded`,
`quota_exceeded`, `forbidden`, `unbound_collection`, `unavailable`) in
`ReadState.error`, and `ReadStatus` explains it. A revoked session
(`bindShellSession(runtime, device)`) replaces the shell with the app's sign-in
(`resources.shell.signIn {view|href|action}`) and releases every read;
`shellSessionRestored` brings it back.

### Streaming

`threadFeedAdapter(client)` (from `/core/web`) wraps Core HTTP: `observe`
(`POST /threads/:id/observe`), `cancel` (Stop), `upload` (`/assets`), `asset`
(message attachments). The host grants it as `adapters.core.feed`. Without it
the chat works from live Collections, without progressive replies or Stop.

`chatFollow` (started by the thread View, cancelled on unmount) projects frames
with `createFeedProjector` (`plugins/core/shared/chat-feed.ts`): replies by
`llmAttemptId`, lanes by `lane`, provider fallbacks by `providerAttemptIndex`,
tool-call drafts from NDJSON, tool output by `sourceActionRunId` →
`copilotzToolAction.toolCallId`, bytes by offset. It commits at most every 50
ms: `threadFeed` (replies), `threadRun` (`status`, `active` operations,
`stopping`) and `threadOutputs`. Only the `threadLive` View and tool hosts
re-render while text streams. A reply settles on `llm.call.*` or its operation's
terminal output and hides once its persisted message (same
`copilotzWorkflow.llmAttemptId`) is in the window.

## Extension points (inert data, or Views)

| Slot             | Declare                                                                                                                                                                   | The View receives                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Branding, copy   | `resources.shell.branding {title, subtitle?, logoUrl?}`, `.labels`, `.suggestions`, `.features {spaces, attachments, voice}`, `.theme: "host"` to manage `.dark` yourself | —                                                             |
| Identity         | `resources.chat.sender` (who sends), `resources.chat.agents` (participant inputs for new chats)                                                                           | —                                                             |
| Space sections   | `resources.spaceSections.<id> {label, icon?, order?, view, tools?}`; `null` hides a built-in                                                                              | `{spaceId, threadId}`, mode `full`/`panel`                    |
| Right panel      | `resources.shell.panel {view}` replaces the Space sections                                                                                                                | `{threadId, spaceId}`, mode `panel`                           |
| Header menu      | `resources.headerMenu.<id> {label, icon?, order?, action?, dialog? or page?, destructive?, requires?}`                                                                    | dialog: `{threadId, spaceId}`, mode `dialog`                  |
| User menu        | `resources.userMenu.<id>` (same shape)                                                                                                                                    | `{}`                                                          |
| Pages            | a menu item's `page: "<kind>"`, or `ctx.show(ref, { source: "link", region: "main" })`                                                                                    | `{section}` or `null`, mode `full`                            |
| Agent selector   | a View for `agentSelector` plus `resources.views.prefer`                                                                                                                  | `{threadId}`                                                  |
| Tool renderers   | `resources.toolRenderers.<toolId> {view, inline?}`; the View declares mode `inline`                                                                                       | `ToolCallView` (status, input, result, `data`, live `output`) |
| Markdown plugins | `adapters.markdown.<alias> {remarkPlugins?, rehypePlugins?}`                                                                                                              | —                                                             |
| Images           | `resources.markdown.imageOrigins`                                                                                                                                         | —                                                             |

Built-in sections: `overview` (0), `conversations` (10), `members` (90). A
section's `tools` puts a dot on its tab when an agent uses one of them; the tab
never switches. Section and panel Views must declare `url: true` to render from
a link. `icon` is a kit icon name (`iconNames`).

## Kit

`styles.css`: chat-ui's default slate theme (white, slate primary,
`--radius:
0.5rem`, system font) as tokens for light and `.dark`, plus `bubble`,
sidebar and code tokens; prose themed through tokens; KaTeX math (HTML with its
fonts, plus MathML); tw-animate-css. Brand by overriding
`--primary`/`--primary-foreground`. One set of primitives (Button, Badge, Card,
Input, Textarea, Dialog, `ConfirmDialog`/`ConfirmAction`, `FormDialog`,
`NameDescriptionDialog`, DropdownMenu with checkbox/radio/sub, Tabs, `TabBar`
(navigation tabs with roving focus and an activity dot), Tooltip, Avatar,
ScrollArea, Separator, Kbd, Spinner, Field, NativeSelect, Checkbox, Notice,
EmptyState, CopyField) and patterns (`Screen`, `Frame`, `ReadStatus`, `Metric`,
`DetailList`, `ResourceTable`, `ResourceToolbar`, `ResourceList`, `ResourceRow`,
`ResourceHeader`, `PaneBoundary`, `showSafely`, `Markdown`, `Icon`,
`identityColor`, `initials`).

## Admin

`createAdminWebPlugin({ actionAliases?, core? })` composes the app's Core plugin
(`core`) and registers `resources.userMenu.admin`, a page (`admin`) with tabs
for Overview, Agents, Conversations, People, Activity and Usage. Each section
reads its query Action through the page's own context (`adminSection`), so a
page opened from a link holds its query until Load. The overview no longer opens
live reads. Detail Views use `DetailList`; refusals are sentences.

The sections are
`resources.adminSections.<id> {label, icon?, order?,
description?, view?, requires?}`:
the built-ins are entries (orders 0 to 50) an app reorders or hides (`null`),
and an app adds its own as Views receiving `{ section }`. `requires` names
Action aliases that must be composed. `adminQuery {section, embedded: true}`
renders a section without a Screen.

## Deletions

`plugins/ui/{workspace.ts, views/workspace, views/panes, views/navigator,
tests/workspace.test.tsx}`,
`workspaceNavigation`, `workspaceUrlStorageAdapter`, the `ui*` workspace
Actions, `core.threads` (`{list: "thread"}`), `core.message` and the
`resources.navigation` entries (admin's included), with their docs and tests.

## Tests

Ported (`chat-ui/tests`): grouping, ownership, Space grouping, touch drag,
prepend anchor, theme, activity labels, Space form. New: feed projection, URL
codec and history, happy-dom shell tests (sidebar and chevron vs. name, Space
vs. chat, panel resize and restore, composer attachments, live activity and
Stop, app section, panel and tool renderer, narrow width keeps state, pages,
shared live reads, refusal states, arrow keys), admin page and refusals, and the
runtime keeping a live refusal's code. Screenshots: `contracts/web-demo` at
1440×900 and 390×844, light and dark.

## Contract changes

- 2026-10-21: `uiWebPlugin(options)` takes `{navigation, preferences, core}`
  (was a storage name); the first draft's `resources.spaceSections` entries
  gained `tools`; the Space section value is `{spaceId, threadId}`.
- 2026-10-21 (later): pages (`shell.page`, `shellOpenPage`, a menu item's
  `page`, `region: "main"`); `createAdminWebPlugin` takes `core` and registers a
  user-menu page instead of `resources.navigation`; shared read helpers
  (`readThread`, `readSpace`, `readSpaceThreads`, `readParticipants`); a live
  read's `ReadState` carries `error` (the runtime passes the live query's
  refusal through); kit `TabBar` (Space tabs use it) and `DetailList`.
- 2026-10-21 (final): Views nested in a URL-opened View inherit its hold; one
  gesture releases the scope. Code highlighting and KaTeX load on first use.
- 2026-10-21 (product gaps): JSON tool results pass through (`data`,
  `resultStatus`; `chatLoadToolResult` reads references on demand, bounded at
  256 KiB); `resources.adminSections` opens the admin page to app sections
  (`adminSections`, `adminSection`, `ADMIN_SECTIONS` exported; `adminQuery`
  takes `embedded`); core declares server proxies only for intents in use
  (`intentServerActions`; the unused `deleteThreadMessages` alias is gone); the
  header title keeps priority over the `agents` slot; the kit vendors KaTeX's
  CSS and fonts.
- 2026-10-21 (content budget): a window read never fails for size. Content reads
  take `bodyByteLimit` and `overflow: "defer"` (bodies resolve in read order
  while they fit; the rest stay `resolve: false` references marked `deferred`
  with `byteLength`); live subscription windows defer by default. The chat's
  message selection defers, and `chatLoadBody` reads deferred text when it shows
  (`messageBody`, `ChatMessage.pending`).
- 2026-10-21 (SEC3 round 2): the thread feed, conversation and Space lists are
  live ordered windows (`createdAt`, `updatedAt`, `name`); `ReadStatus` reads
  refusal `reason`s; sessions end through `bindShellSession` and
  `resources.shell.signIn`, with `shellSessionEnded` and `shellSessionRestored`.

## Held reads in nested Views

A View that a URL opened holds its query reads, and so does every View it nests
with `ctx.show` (fail closed). The runtime keeps one hold scope per URL-opened
root reference; one user gesture on any held read in the scope starts every held
read still on screen. A View declaring `url: { queries: "run" }` runs its own
reads; the Views it nests stay held. Admin sections still read through the
page's context (`adminSection`), so the page shows one Load for its section.

## Follow-ups

- Persisted reasoning text is resolved only through the bounded `content` field
  selection; reasoning stored elsewhere shows as a step without text.
