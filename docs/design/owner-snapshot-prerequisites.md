# Owner snapshot prerequisites

Ordinary registered Collection reads are implemented. The private, opt-in
registered `readSnapshot` integration is a work-in-progress candidate. Public
activation and acceptance remain gated; no weaker snapshot fallback is provided.

## Cloud recovery checkpoint — 18 October 2026, 02:33 UTC

A cloud runner restart restored an older workspace. The last pushed manager
checkpoint and accepted sibling dependencies were restored at their exact remote
commits. The newer integration source has been reconstructed from the recorded
edits: persistent execution lifetime capture, queue-free resource calls,
read-only callback sealing, local raw-call tracking and uncertainty propagation.
The narrow worker role allowlist includes only the pure callback helper.

The reconstructed source passes the owner host/worker type check and
changed-file lint. Its new tests and evidence still need restoration and
rerunning; earlier pre-restart results do not certify this reconstructed source.
Prior local validation logs are absent from the restored workspace. This is an
explicitly unaccepted WIP checkpoint to preserve the source while verification
continues. No merge or package publication is authorized.

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

## Shared read-only authority validation

The existing assignment, Action and Processor validators now accept a private
SQL read mode. Existing callers retain their locking mode. Certified exclusive
PGlite snapshot callers may select read-only validation; static lock clauses are
chosen where queries are built, with no SQL rewriting and no second permission
evaluator. PostgreSQL current-state checks retain normal row locks. This mode is
not a worker option and does not certify exclusivity by itself.

The same current grants, source/input/event policies, durable attempt facts,
prepared-source/recovery checks and final private witnesses remain required.
Local Action and Processor resolution forwards the mode through its existing
rechecks. A policy that writes or reenters ordinary queued database operations
is not bypassed: it is unsupported inside this read-only scope.

Focused actual PGlite tests cover all four Action/Processor placements and
worker assignment revocation. A normal locking Action check still fails in a
read-only transaction, proving the default was not weakened. Independent broad
checks pass 90 PGlite cases with one explicit PostgreSQL-only skip, and 235
PostgreSQL cases with one unchanged COUNT bigint fixture mismatch. The narrow
portable assertion correction then passes the full 32-case assignment file and
three authority cases on PostgreSQL, plus the corrected case on PGlite. Full
static checks, source audits and disposable database cleanup pass. This records
two snapshots and the corrected-case gate, not a fictional complete 236-case
rerun.

The mode supplies neither owner epoch fencing nor backend exclusivity by itself.
The host must establish both, retain current private revocation and perform
authorization through the actual backend scope. Owner host routing, resource
lifetime and historical Collection permission remain unactivated.

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

## Shared bounded Collection evaluator

Ordinary projection reads now use a prepared evaluator that captures the closed
request and registered schema, then reuses the existing get/list/aggregate SQL
compilers, protected-source checks and transfer/output bounds. It returns a
private synchronous finalizer. The host performs its final authorization first,
then validates and exposes output without another await. The evaluator grants no
authority and must not be exposed to plugin code.

This preserves error precedence: an output that exceeds the local ordinary-data
guard must not reveal even an output-validity bit after access is revoked. An
initial extraction moved that check too early; its causal failure is preserved
and a real-table regression covers the correction. Two unchanged host fixtures
also needed explicit three-argument forwarding after the prior authority mode
extension; both are checked on actual PostgreSQL.

The final frozen gate passes 184 PostgreSQL SQL/authority/host/helper cases, 42
PGlite SQL cases with three PostgreSQL-only skips covered by the PG run, three
reviewer probes and 12 role bundles. Full static checks, source/sibling hashes
and coordinator database export, fixture database drops and server stop pass.
Earlier inventory setup, fixture typecheck and causal failures remain recorded.
This is shared evaluator acceptance, not historical-read permission or
registered snapshot activation.

## Explicit cleanup outcome

The backend now reports `confirmed` or `unknown` separately from a scoped
callback's value/error. Confirmation means this invocation submitted no open or
its exact close acknowledgement succeeded after raw drain. A temporary capacity
refusal can therefore release its charge after confirmed cleanup; unconfirmed
cleanup remains charged. Error classes, message text, callback entry and generic
persistence close are not cleanup classifiers. The captured observer is notified
once; observer failures cannot replace the operation result.

Independent backend acceptance passes 157 Ominipg cases, 41 committed Copilotz
cases plus five steps and 25 reviewer probes, including actual PostgreSQL,
PGlite, Drizzle, lost replies and held rollback timeout. Static/hash checks and
disposable database cleanup pass. An initial test wrongly treated a failed reset
as unknown despite confirmed discard; the corrected distinction and an actual
failed return are both covered.

Managed forwarding records this observation independently of later cancellation
or generation errors. Once it invokes the backend, missing or duplicate
observations stay unknown; only a pre-invocation refusal can be confirmed
locally. Notification occurs before the final generation witness. Independent
managed acceptance passes 46 cases plus five steps and ten reviewer probes with
actual PostgreSQL/PGlite, full static/hash checks and coordinator database
export/drop/server stop. Missing or duplicate backend reports, capacity refusal
followed by admission, delayed cleanup and observer reentrancy are covered.

Consumers must await actual scope settlement as well as confirmation before
releasing this resource charge. Confirmation never restores authority or grants
replay. Owner resource lifecycle/routing remains the next activation gate.

## Owner resource manager (WIP integration checkpoint)

The private manager owns at most one backend scope outside the serialized owner
command loop. It uses the shared bounded Collection evaluator and existing
Action/Processor authority callbacks. PostgreSQL checks current authority on the
reserved current lane; certified exclusive PGlite checks it on the owned engine.
Both validate the owner epoch, private attempt lifetime and fresh caller
witness. A resource ID alone grants no authority. Historical disclosure requires
an explicit historical grant; an ordinary Collection filter does not imply one.

Open/read/close retain the same captured execution lifetime. Reads compare the
current historical scope before and after SQL, and perform final synchronous
output validation only after authorization. Resolver and policy results are
detached before private callbacks can mutate their returned aliases. Final
readiness and close results recheck private authority, including revocation
while cleanup was pending. Cleanup does not require a renewed business grant.

Idle/maximum timers revoke resource authority independently of the command
queue. Missing or duplicate cleanup observations quarantine the resource. Only
exact confirmed cleanup plus actual backend scope settlement frees its database
charge. A late continuation cannot disclose data or clear a successor resource.
Two manager-wide counters bound outstanding reads and authority callbacks across
resource generations; cancellation does not release either counter before its
own actual continuation settles. Opening resolvers consume the authority budget.
No job lease, durable read receipt, replay or execution registry is added.

Expiry bounds authority, not response time or physical cleanup time. Accepted
raw SQL can delay open/read/close completion. Future transport cancellation must
preserve the underlying resource and continuation charges until their respective
settlement, even if its caller receives an earlier timeout.

The corrected frozen manager passes 21 repository cases on each of actual PGlite
and PostgreSQL, 45 lifecycle/Collection compatibility cases, the unchanged
causal PostgreSQL epoch probe, and six final reviewer probes on each backend.
Lint/format and source/dependency hash checks pass; disposable fixture databases
were dropped and coordinator databases exported/dropped with the service
stopped. This is split scoped evidence, not a new full-suite acceptance. Two
reviewer readiness probes initially used stale callback indices after the final
epoch fence added checks; their failures and corrected boundary-targeted replays
remain.

The initial actual-PostgreSQL review found stale disclosure when the final
policy changed the durable epoch inside its own current transaction. Authority
now rechecks the exact epoch/holder after the operation in the same transaction,
then finishes with the private witness. Earlier resolver-alias,
close-after-revocation and detached-continuation capacity failures remain with
corrections. An invalid policy-filter fixture was corrected to `where.id`.

The unchanged full static gate still fails at strict package reachability
because the manager has no production caller yet. This checkpoint remains WIP;
no artificial export or check waiver makes it accepted integration. Genuine host
wiring must close that gate before this task is checked complete.

This manager uses stub execution witnesses in its tests. It does not activate
registered `readSnapshot`. The next gate must capture existing worker dispatch
and local placement entries, route resource calls without queued grant/readiness
lookups, preserve the existing raw-call accounting, and prove all four
Action/Processor placements on both transports. Nested ordinary calls must not
wait behind a snapshot that owns their required database capacity.

## Performance boundary

Snapshots are explicit, short selection scopes. Ordinary single reads do not
reserve these resources. The current PostgreSQL design reserves two connections
within the existing configured pool, one for the historical snapshot and one for
current authorization. This is a cost of this authority design, not an intrinsic
two-connection requirement for database snapshots. Saturated admission refuses
rather than increasing pool size. Current authorization transactions and
transport calls also add work per snapshot read; their latency is not yet
benchmarked.

Default PGlite holds its single certified engine exclusively until the scope
closes, so unrelated database work waits. Finish selection before LLM/provider
calls, remote content resolution or other slow application work. PostgreSQL
long-lived transactions can retain obsolete row versions and impede vacuum; see
the official
[idle transaction timeout documentation](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-IDLE-IN-TRANSACTION-SESSION-TIMEOUT).

Before production acceptance, measure ordinary versus snapshot latency and
throughput under concurrent reads/writes, current-authority contention, pool
occupancy/refusal, and PGlite queue delay at different callback durations. F5's
idle/maximum lifetime settings require this load evidence. Expiry revokes use
but does not prove cancellation of raw SQL or physical capacity release.

## Reconstructed host integration: cleanup ownership

The recovered integration now connects the private manager to actual local and
worker Action/Processor calls. Earlier manager-only statements above describe
that checkpoint, not the current wiring. Full static/role and backend acceptance
must be rerun against the reconstructed tree; pre-restart evidence is
historical.

A local driver's quiescence covers authored execution and its admitted raw
calls. The owner separately owns a snapshot's SQL resource. Revocation can
prevent a new close call from being admitted even while that resource is still
cleaning up. Driver quiescence therefore does not certify snapshot cleanup or
return its capacity. The manager retains the charge until explicit confirmed
cleanup and actual backend scope settlement; host shutdown joins that
owner-owned cleanup. No post-revocation cleanup receipt, job lease, or second
execution registry is introduced.

If cleanup proof is absent or unknown, the manager first quarantines the
resource and rejects its completion with an indeterminate error. A private
negative notification then stops owner admission, including failures arriving
after the invocation has quiesced. Observer failure cannot turn uncertainty into
success or release capacity. Host shutdown reports the same cleanup uncertainty.

The callback helper preserves identical known read/close errors so Processor
error policies can recognize them. Distinct failures retain cleanup uncertainty;
unknown open/read failures also remain indeterminate. Error classification reads
only own data descriptors and never coerces error properties or invokes getters.
Accepted raw reads still drain before the callback settles.
