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
