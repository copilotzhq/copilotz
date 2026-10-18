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

## Native PGlite exclusive lifecycle prerequisite

The internal helper now reuses the native transaction mutex instead of adding
another lock. It keeps native handles private, seals and drains scoped queries,
explicitly confirms rollback, and quarantines the database when cleanup is
unproved. The actual SQL-engine isInTransaction predicate prevents joining an
already-open manual transaction; native WASM readiness is awaited first.

The adapter compares the actual constructor against a recognized built-in
Deno/Node descriptor using a lazy dynamic import. Its effective configuration is
restricted to primitive startParams/relaxedDurability options, excluding custom
extension/filesystem bypasses. Ordinary custom-provider operation is unchanged;
unsupported snapshot configurations refuse rather than claim exclusivity.

Independent final checks pass 14 typed cases, including actual PGlite, four
additional lifecycle/descriptor probes, and the canonical static task. Final
source hashes and documentation formatting are verified. Initial readiness, lint
and doc-format failures remain preserved. The deliberate arbitrary-SQL escape
probe is a documented caller-contract boundary: the internal executor accepts
trusted compiled reads only, not transaction-control or session-changing SQL.
Public Collection operations must never expose raw worker SQL.

The helper alone does not establish engine/session resource ownership. The next
section records that integration gate. Callback capability, generation
forwarding and owner authorization remain open. This is scoped prerequisite
evidence, not a new full Copilotz acceptance.

## Engine and session resource flow

The backend now wires bounded snapshot resources through typed session
open/query/close operations. PGlite claims admission synchronously, drains prior
ordinary work, excludes sync and checks actual SQL-idle state before native
opening. PostgreSQL uses its reserved snapshot/current pair. A resource closes
without blocking on ordinary checkouts that need its pins returned.

Current-state and snapshot requests have separate pending scopes, and server
lane keys use tagged tuples rather than colliding textual prefixes. Explicit
transport close and EOF seal new snapshot admission, release its pins, drain
already-accepted ordinary lanes and finally close the engine. Legacy queued
UPDATE/COMMIT work is preserved. Unknown cleanup quarantines admission and
remains observable even after its resource record clears; confirmed admission
failure keeps ordinary usage available.

Independent frozen acceptance passes 136 Ominipg cases with actual PostgreSQL
and PGlite, 31 Copilotz cases plus five steps, eight additional reviewer probes,
and canonical static/documentation checks. Source hashes and disposable database
export/drop/stop are verified. The initial cancelled-open rollback reporting and
partial-acquisition cleanup failures are preserved alongside their corrections.
Later-close reporting, lane collision, EOF progress and accepted ordinary-work
drain have explicit coverage.

This is backend/session acceptance. The callback-level database API,
managed-generation forwarding and actual owner historical-read rules/expiry
remain separate. No newer full Copilotz acceptance or owner activation is
claimed.

## Managed generation forwarding

The optional internal `SqlSession.withReadSnapshot` capability forwards one
backend callback resource through the existing persistence generation reference.
It is distinct from the existing short `readSnapshot` selection transaction. An
absent backend capability refuses; there is no ordinary-read fallback. Published
dependency pins are unchanged, so acceptance uses the reviewed sibling backend
source explicitly.

A generation has one lifetime signal. Retirement revokes retained snapshot and
current-state handles immediately, before recovery observers or reconnection
waits. Each executor checks the selected generation and cancellation before and
after awaited results. The callback remains pinned to its original database
until the backend finishes its actual scope cleanup. A replacement generation
can serve new operations, but never receives a replay of the old snapshot or
callback. Caller cancellation is captured once and does not itself trigger
reconnection just because its reason resembles a connection error.

PostgreSQL forwards the separate current-transaction lane; default in-process
PGlite forwards the exclusive snapshot lane. Both accept trusted compiled SQL
only. This internal seam supplies no historical Collection grant, owner policy,
resource expiry, or worker-facing SQL API.

The existing persistence shutdown API suppresses database close errors. This
increment does not reinterpret its resolved close promise as proof of physical
cleanup. Backend snapshot cleanup errors still propagate from the scope; a
complete owner resource release must rely on its actual backend lifecycle rather
than a successful generic persistence shutdown return.

Independent frozen generation acceptance passes 41 cases plus five steps on
actual PostgreSQL and PGlite, and four unchanged reviewer probes. Static checks,
all candidate/dependency hashes and disposable database export/drop/stop pass.
The final facade cancellation and reentrant final-witness failures are retained
alongside their corrections. Final cancellation is checked before the last
generation witness, so caller signal methods cannot retire the database after
that witness and still disclose a result.

Coverage includes retirement during retained reads/current callbacks, cleanup
ordering, local cancellation, capability absence and independent PostgreSQL
current transactions while historical snapshot rows remain stable. Generic
close-error suppression remains the documented existing limit. These scoped
checks do not replace the owner local/worker activation tests below.

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
