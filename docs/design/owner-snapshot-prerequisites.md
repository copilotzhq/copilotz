# Owner snapshot prerequisites

Ordinary registered Collection reads are implemented. Registered `readSnapshot`
remains unavailable: this document records the prerequisites for F5 snapshot
sessions, not an activated API or a weaker replacement.

## Shared transaction lifetime

[Ominipg PR #4](https://github.com/AxionCompany/ominipg/pull/4) consolidates the
PGlite and PostgreSQL callback lifecycle while retaining their existing
exclusive client-queue and pooled lane scheduling:

- Both query aliases close when the callback completes or fails; a retained
  executor cannot issue work during terminal acknowledgement or afterwards
- Admitted query promises drain before terminal SQL, with the existing session
  gate retaining timed-out raw requests until their response arrives
- BEGIN is inside cleanup: a lost/late reply cannot skip rollback of a remotely
  opened transaction
- Failed or unconfirmed rollback poisons further admission and closes the
  workload session directly, avoiding a wait on the transaction's own queue
- Public close still drains other admitted callbacks, even after internal
  fail-close; repeated close retains resource-cleanup errors
- COMMIT uncertainty remains an unknown outcome. Cleanup does not prove rollback
  of business effects and is not permission to replay

This removes the duplicated serial/pooled callback lifecycle. It adds no owner
lease, database table, read receipt or query engine. Default PGlite remains
in-process; PostgreSQL is optional. Published dependency pins are unchanged.

## Scoped evidence

The final frozen candidate passes 65 checked cases in 12 Ominipg files under the
canonical `--node-modules-dir=auto` mode with a disposable PostgreSQL database.
A separate Copilotz integration gate passes 31 cases plus five steps, including
actual PGlite/PostgreSQL, snapshot and Collection transaction behavior. Four
independent fault probes cover timed-out rollback raw occupancy and repeated
cleanup-error reporting in both scheduling modes. The existing check task
passes.

Ten causal failures on the old client and the review-found early public-close
failure are retained. That review defect was fixed and added to the repository.
The first wider attempt failed to resolve cached Drizzle; default-mode inference
then produced six errors on both candidate and unchanged baseline. The canonical
CI node-modules mode resolves them without source/test weakening; Drizzle passes
in the final coherent group. These are scoped checks, not a new complete
Copilotz acceptance or a package-publication claim.

## Pooled timeout progress

A subsequent scoped correction keeps PostgreSQL request waiting within the
existing named transaction or default/unlaned group. An unrelated timed-out pool
checkout cannot block the transaction that must continue or end to release its
connection. PGlite retains the whole-session gate. No extra pool, connection
budget, checkout rejection policy, public API or lane registry is added.

The plain routing envelope is captured before waiting, so caller mutation cannot
change the admitted lane. UNLISTEN can complete independently after its own
subscription's raw work drains; new LISTEN retains default admission. The
listener hub still holds its shared connection after unsubscribe, so capacity
accounting must retain that charge. Encoding errors create no raw waiter/timer.

Independent gates pass 77 Ominipg cases with actual PostgreSQL enabled, 31
Copilotz cases plus five steps, four cleanup-fault probes and one
listener-retention diagnostic. The static task passes, source hashes remain
unchanged, and both disposable databases were exported/dropped with services
stopped. Wording-only corrections then pass ten focused cases with two explicit
PostgreSQL skips; no behavioral change is hidden in that correction. Earlier
terminal-only, mutable-envelope, unsubscribe-progress and encoding failures
remain preserved. This does not establish reserved snapshot/control capacity or
activate owner snapshots.

## Accounted pool capacity

The internal PostgreSQL reservation now shares the existing pool with ordinary
queries, transactions and LISTEN/reconnect. Pending checkouts count before
awaiting the provider. At most one two-client reservation can be admitted, and
only when it fits within the configured total; no second pool or increased
connection limit is introduced. Saturated admission refuses before BEGIN.

Release seals pair executors, drains actual admitted statements and resets both
clients before returning capacity. Failed returns retain their charge; partial
or aborted acquisition waits for both raw outcomes and returns late clients. A
retained pool owner can retry failed cleanup before physical shutdown starts.
Once raw pool shutdown starts, its result is retained. The engine's existing
close operation still caches its outcome; engine-level retry is not claimed.

Independent full scoped gates pass 102 Ominipg and 31 Copilotz cases plus five
steps, with actual PostgreSQL enabled. Four retained cleanup probes and three
causal probes pass. A test-only prefer-const correction then passes all 25 pool
cases on actual PostgreSQL, the same seven probes, and the full static task. The
original cleanup-retry, reentrant-shutdown and lint failures are preserved;
final source hashes and disposable database export/drop/stop were verified.

This is an internal backend prerequisite. It does not expose the owner snapshot
callback, current-authority control lane, PGlite exclusivity capability,
generation forwarding or historical-read permission.

## Remaining backend and authority gates

A read-only REPEATABLE READ snapshot owns a separate transaction outside the
owner command loop. Current locking authorization cannot simply be run inside
it: READ ONLY rejects FOR UPDATE and the owner UPDATE fence.

For pooled PostgreSQL, current authorization needs independent connection
capacity. Snapshot admission must leave enforceable control capacity, accounting
for LISTEN and other transaction users. A snapshot count of poolMax minus one
alone does not establish that guarantee.

For PGlite, an outside transaction can wait behind the snapshot that is waiting
for its authorization. Snapshot access and cleanup must progress through the
actual exclusive engine while private revocation remains live. The existing
`concurrent:false` handshake is insufficient: background replication currently
uses the engine directly. A trusted capability must establish exclusivity or
refuse; URL inspection and caller claims do not establish it.

An ordinary policy filter also cannot implicitly grant historical visibility.
For example, `visibility=public` against old rows can include a row that is now
private. A prospective narrow historical-read grant must be explicit, current
and revocable. The existing ordinary read policy is not widened. More general
current per-row eligibility over historical aggregates and cursors needs a
separate complete proof.

One bounded resource entry is justified by each actual pinned snapshot. Unknown
open/close and raw SQL drain keep that capacity occupied. Resource idle/maximum
lifetimes must never become job leases, reassignment authority or automatic
snapshot replay. Cancellation, takeover, host close, retained readers, nested
use and unawaited calls require actual local/worker Action/Processor proofs on
both transports before activation.
