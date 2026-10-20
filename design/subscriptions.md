# Owner-pushed Collection subscriptions

## Current state

- `runtime/events/push.ts:282` stages owner changes at the existing SQL commit
  gate, and publishes through `CommandContext.afterCommit`.
- `runtime/events/store.ts:1142` already pushes every durable Event's owner seq.
  Collection mutation bodies contain the full resulting record
  (`runtime/collections/types.ts:34`). They are not yet in that push.
- `runtime/authorization/owner.ts:190` owns live authorization, declared
  dependency notices, session revocation and credential deadlines. Its existing
  operation publication path re-evaluates in a command on every publication.
- `server/reads.ts:14` is the authorized Collection read surface used by
  adapters.
- `client/index.ts:1` is currently an HTTP client. There is no device/WebSocket
  implementation in this worktree. Views currently expose one-shot reads.
- Deleted observation: commit `3dfcaa25`, `server/collection-observation.ts`.
  Its repeated selection scans will not return.

## Target and API

One owner-local subscription service, exposed as
`read.observe(collection, query,
{ checkpoint, signal })` and application
Collection `observe`. It returns a bounded async frame stream and detach. The
SDK live query consumes the same frames over an injected device transport
(including the in-process binding). Frames use F6 snapshot, batch, reset and
revoked shapes. Snapshot is one bounded, complete logical output; it is never
stitched from separate database snapshots.

A shared owner cache per namespace/Collection holds bounded full records, seeded
once at a serialized owner command boundary with the seq in that transaction.
Subsequent commits carry their already prepared mutation body through owner
push; no subscriber SQL runs for ordinary commits. Each subscription retains its
prior limited selection. In-memory filtering and ordering recompute membership
and refill from the shared cache. Oversized caches fail/reset explicitly.
Unsupported query features fail admission rather than silently change query
semantics.

F4 `observe` gains a Collection intent, change callback and cached publication
check. Notices fence publication synchronously, re-evaluate through the existing
owner queue, and resume with updated constraints. Credential expiry resets for
reauthentication; authority loss emits revoked. No new policy evaluator or
timer.

Opaque owner-issued checkpoints reference bounded retained frames and their
original snapshot/selection/authority identity. Reconnect reauthorizes and
replays only that history; missing retention, changed scope/schema, expiry or
takeover resets. Buffers are bounded by count and bytes, with control reset
replacing queued payload. Detach removes the reader while bounded history
remains.

Client application is transactional: call the handler before replacing rows or
checkpoint. Failed handlers detach. Batches must be contiguous; deltas carry seq
and id, with membership reconstructed in the query’s id order. Optimistic layers
settle after applying through the operation result seq, on failure, or a
covering replacement snapshot. Operation results expose seq without changing the
application's result value.

## Integration and deletions

Extend the existing owner push and F4 channel, not a second event bus. Export
the frame and live query contracts for the device binding. Keep existing
operation observation behavior. No deleted polling code will be restored. No
remote binding can be claimed until the device track supplies its
connection/channel transport; the in-process binding is executable and tested
here.

## Guarantees and verification

- F6 §6 snapshot/seq atomicity, writes during handoff, interrupted snapshots.
- Ordered deltas, previous membership, deletion/filter/permission refill.
- Contiguous `(from,to]` coverage and empty progress.
- Action seq settlement, no visible effect, failure and replacement snapshot.
- Revoked vs reset; retention/scope/schema/takeover fencing.
- Applied checkpoints, handler failure, reconnect and slow consumer isolation.
- F4 notice reauthorization and expiry reuse.
- Core integration cases run against PGlite and Postgres port 55431.
- Micro-benchmark reports commits/sec and commit latency at 0 and 100 readers,
  including SQL counts to detect subscriber-dependent database work.
- Targeted tests during development; full suites once at the end using the
  prescribed timeout wrapper. Final result records counts and remaining risks.

## Risks

Bounded full-Collection caches impose an explicit capacity limit. Large datasets
will need a shared ordered index/refill strategy in a future revision. Query
collation must match PostgreSQL; only supported deterministic ordering is
admitted. Authorization changes must fence queued payload before asynchronous
policy work. No replay cursor may reveal another principal's data or silently
adopt a new snapshot. Shared records and frames must not be mutable by
consumers.

## Live reads end to end

Baseline before LIVE: `client/live-query.ts:59` owns applied rows, checkpoint
and optimistic settlement; `client/web/runtime.ts:247` duplicates settlement and
`:268` duplicates frame application. `client/web/live.ts:6` defines a second
wire shape. `client/index.ts:217` uses HTTP multipart for operation
observations; `:343` requires an injected Collection transport. There is no
device socket in this branch (the sockets under runtime are worker bindings).

Target: owner `read.observe` → authenticated, multiplexed device WebSocket →
`SubscriptionTransport` → `createLiveQuery` → client Collection → tracked View.
The web runtime consumes the SDK handle directly. Delete its frame reducer,
checkpoint/sequence fields and settlement loop, and delete `web/live.ts`'s
second frame/port/MemoryLiveReads implementation. Tests use the actual
SubscriptionTransport contract. Browser-local Collection commands stay local.

The public Collection get/list, ReadState, observe(read), Action handles and
View ctx stay stable. `BrowserRuntimeOptions.live` accepts
SubscriptionTransport; SDK collections.observe remains unchanged. Expose a
shared device transport and a portable server socket binding; the Fetch facade
accepts the host's upgrade function at /device. Authentication reuses compiled
Collection exposure and the existing retained-authority authentication path.
Explicit reauthentication fences channels before rebinding; HTTP cookie changes
alone confer no authority. Operation multipart migration is outside this
Collection track and follows F6's explicit retirement gate.

The binding negotiates version/capabilities, bounds controls, channel queues,
logical outputs and socket buffering, fragments large JSON output, fences each
channel generation, and renews before channel/connection deadlines. Heartbeats
carry per-channel owner checkpoints; the client acknowledges only applied
frames. Disconnect, renewal and overflow resume from the handle's applied
checkpoint; absent retained history resets. No Collection polling or per-commit
SQL is introduced. Revocation removes private rows and closes the read.

Verify owner conformance unchanged, adapt WEB tests to asynchronous canonical
frames, and add real WebSocket/application/browser-renderer integration for
commit→delta→render, seq settlement, reconnect/replay, and revocation. Device
unit cases exercise fragmentation, stale generations, heartbeat repair,
reauthentication and bounded queues. Run full PGlite and Postgres suites with
the prescribed wrapper. Risks: host upgrade APIs differ; the portable binding
must keep host globals out of browser/core exports. Existing id-order and owner
cache capacity restrictions remain explicit.

Content selections remain part of client get/list: forward them with
subscription options, include them in retained selection identity, and use the
existing Collection resolver for declared fields and bounded bodies. Recheck the
live permission gate after asynchronous body resolution. This adds body reads
only when explicitly requested; ordinary owner pushes remain SQL-free. JSON
logical outputs preserve typed content bodies through envelope path metadata.

Query Action invalidation distinguishes a Collection mutation from empty owner
progress. Batches carry `collectionChanged` even when the limited projection is
unchanged; query Actions refresh on that signal, while their own result/receipt
progress only advances optimistic settlement. This prevents feedback loops.
