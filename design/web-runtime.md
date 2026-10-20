# Web runtime and Views

Revised 2026-10-19 from the supplied web-runtime draft. The binding layering
supersedes its React-in-core and dependency-free UI proposals.

## Current state

- `runtime/views/definition.ts:1` defines portable Views, references and
  contexts. `resolution.ts:20` resolves exact kind/mode/renderer matches with
  explicit preferences. `renderer.ts:218` provides bounded, authorized pure text
  rendering. Preserve its security and lifetime guarantees.
- `runtime/plugins/contribution.ts:80` expands Views alongside all other
  primitives. `build/index.ts:125` discovers conventional primitive entries
  without executing them. Extend these rather than introducing a second View
  registry.
- `client/index.ts:103` owns fetch, Action submission, idempotency and operation
  observation. Subscription transport is a separate track; this work consumes a
  small injected live-read port, never a polling or projection protocol.
- Read-only source
  `libs/packages/copilotz-chat-ui/src/components/chat/Message.tsx:1` uses React
  Markdown; `components/ui/button.tsx:1` is shadcn/Radix/CVA. Consolidate those
  components in one plugin kit.
- Source `copilotz-admin/src/modules/overview/index.tsx:20` registers routes and
  fetches in effects. Replace this feature plumbing with Views and tracked
  reads. `copilotz-chat-adapter/src/projection.ts` is deliberately not migrated.

## Layering and placement

Core (`runtime/`, `client/`, root entry points) imports no UI framework. `/web`
exports the browser host, client Collections, observation and Action contracts.
`/views` retains the shared View definition/resolver and renderer interfaces.
React adapter, Tailwind/shadcn kit, navigation/layout and all screen
implementations live in `plugins/`, published separately as `/web/react`,
`/web/kit`, `/ui/web`, `/core/web`, `/admin/web`, `/usage/web`. Server plugin
entries never import them.

A primitive has `placement: server | browser | both`; defaults remain server for
server primitives and browser for interactive Views. Browser compositions
contain only browser-safe definitions and server Action contracts, never server
execute closures. Dependencies compose first; duplicate executable aliases fail;
resources and adapters overlay by namespace/alias. Contribution expansion stays
shared.

## Public API

- `createBrowserRuntime({ plugins, live, actions, storage, renderer, show })`.
- `runtime.observe(read)` returns a stable current snapshot, subscription and
  disposal. It re-tracks dependencies on each synchronous evaluation, including
  conditional reads. One client event log carries local changes, live deltas,
  Action transitions and lifecycle events. No UI framework hooks in core.
- `ctx.collections.name.get(id)` / `.list(query)` are synchronous read
  snapshots: `{ value, status, pending }`. Status includes
  loading/ready/stale/denied/missing. Server Collections are read-only.
  Client-owned Collections restore through an injected storage adapter and
  change through pure commands in browser Actions.
- `ctx.actions.alias(input)` returns a handle immediately: status, result(),
  cancel(). Server transport returns terminal result plus owner seq; acceptance
  alone is not success. Optimistic commands replay over each authoritative read.
- `defineView({ id, shows, renderer, modes, render(item, ctx) })` remains the
  View definition. Browser Views support full and panel modes; open hints are
  preserved. Browser context specializes the same contract for synchronous reads
  and output.
- `runtime.render(ref, hints)` evaluates a View with tracked context;
  `runtime.mount(target, root)` connects an observation to the injected
  renderer. `ctx.show` resolves nested Views, or delegates navigation hints to a
  layout port. Disposal detaches subscriptions, cancels local lifetimes, and
  clears private data.

## Live-read boundary (F6 §6)

A read is collection plus get/list selection. Its port emits an atomic snapshot
(rows, seq, checkpoint), contiguous ordered delta batches `(from,to]`, stale,
reset or revoked. Upserts carry record id and order; removes erase prior
membership. The server owns authorization, membership and limited-window refill.
Empty batches advance progress. A failed batch never advances the applied
checkpoint. A revoked read clears rows and pending values. Reattachment uses
only an applied checkpoint.

Optimistic layers have independent invocation identities. A terminal result
records its last owner seq. Each subscribed read retires that layer only when it
has applied through that seq; snapshots settle at/before S too. Rejection
removes only that layer, replaying concurrent changes. A receipt cannot retire a
layer. The in-memory port exercises ordering/reset/settlement while SUBS
supplies the real transport.

## Plugin Views and kit

Core Views cover thread list, conversation, message and composer, with send,
revise, delete and stop actions. Admin Views expose overview, threads,
participants, agents, activity and collection inspection through injected
readable state. Usage Views summarize authorized usage records. All share kit
cards, controls, tables, state messages and Markdown. Markdown uses
react-markdown with raw HTML disabled, safe URL handling and escaped code, with
no raw-HTML extension or HTML insertion.

The ui plugin owns workspace Collection, open/swap/close Actions and workspace
View. Navigator/command palette/URL open focus; item links and live work open
context; swap exchanges them. Focus renders full, context panel. URL and local
storage are injected ports, with no global browser access at module import. App
start restores storage, emits app.started, then mounts the host root datum in
the app root View.

## Deletions and guarantees

No edits to either read-only source checkout. Do not copy the old module
registry, chat projection/reconciliation engine, private event channel or
per-screen fetch hooks. Existing pure text rendering remains because agent
context still uses it. No new polling, server subscription implementation or
frontend runtime dependency.

Tests cover tracked conditional reads, lifecycle disposal, restore, commands,
contiguous deltas, resets/revocation, concurrent optimism and seq settlement,
Action cancellation/failure, composition, View preferences and full/panel
density. Import graph contracts reject UI frameworks reachable from core
exports. React SSR covers chat/admin/usage/layout and Markdown XSS. Run targeted
checks then the full suite with PGlite and Postgres 55432 using the required
timeout wrapper.

## Risks and integration

SUBS must map its wire frames and operation terminal seq into these ports; this
track cannot claim end-to-end server subscriptions before that integration.
Browser bundles must exclude server executable closures. Storage and query
semantics are explicit ports, not implicit trust boundaries. UI read
authorization remains server owned. Source UI features requiring media/identity
host capabilities need injected adapters; no private transport or projection
code is copied to simulate them.
