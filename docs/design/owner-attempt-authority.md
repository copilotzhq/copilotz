# Owner-controlled attempts without per-job leases

Approved by the user on 17 October 2026. This decision supersedes the recovered
F5 §4.2 and REGISTER §2 requirement that worker execution retain a delivery
lease and renewal heartbeat. It applies to the Copilotz owner-managed path,
including both local and worker Actions and Processors. The scoped runtime
migration is independently checked below; content protection and general
retained-history migration remain separate gates.

## Guarantees and simpler authority

The owner is the sole persistent command authority. One active attempt is bound
to an exact delivery and assignment. Local execution uses the private local
attempt witness; worker execution additionally uses its authenticated current
session and Started assignment witness. Both use the owner epoch/holder fence
and current business permissions. Reconnection cannot resurrect an old attempt.

There is no per-job renewable execution deadline. Connection failure detection
and optional execution deadlines can trigger explicit attempt revocation, but
are not renewable database claims. Retry availability/backoff, snapshots,
schedules, observation head heartbeats and storage protection retain their own
semantics.

A successor requires exact predecessor retirement and recovery eligibility.
Unknown COMMIT remains unknown. Disconnect or deadline expiry does not prove
remote code stopped or that an external effect did not happen. Begun effects
require reconciliation or an explicit indeterminate outcome; logical scheduling
capacity is not proof of physical remote quiescence.

## Content protection

F9 protection remains an absolute catalog deadline, with the existing revoking →
fence → revoked ordering. The owner renews quiet valid writers in both
placements, independently of writer I/O, through a bounded owner alarm. Each
renewal checks the catalog-bound exact current attempt; a worker also needs its
current authenticated session. Revocation stops renewal and fences before
reassignment. A late append or reconnect cannot renew authority. This replaces
the worker-job-heartbeat trigger, not protection or observation repair.

## Coordinated replacement and deletion

1. Keep the existing epoch/holder transaction fence and authenticated assignment
   resolution. Do not add another attempt table, worker facade or lease toggle
2. Converge delivery predicates on one exact owner-controlled attempt token and
   no deadline. Keep placement/session details at the existing authority
   resolver
3. Retire owner-path renewal commands, renewal response fields, heartbeat driver
   loops and lease configuration once both endpoints use the same contract
4. Replace expiry-driven alarms and reclamation with explicit lost/revoked
   attempt transitions, retaining retry eligibility, ordinal and effect proofs
5. Update startup, retained-format validation and conformance together. NULL is
   a representation invariant, never proof of authority or placement
6. Remove or migrate genuine legacy consumers before dropping shared schema
   columns or generic EventStore APIs. Temporary historical column/status names
   are not permission to preserve lease semantics in the new owner path

The implementation must explicitly refuse incompatible retained histories until
migration is supported. No production data conversion or deployment is
implicitly authorized. Exhausted new owner-controlled recovery uses AttemptLost;
historical DeliveryLeaseExpired records need explicit compatibility handling.

## Required replacement evidence

- Real worker/local Action and Processor execution on both transports, including
  Collection writes, child Actions, preparation, effects, retries and
  cancellation
- A healthy execution spans the former lease interval without any renewal call,
  receipt or renewal-related database update; explicit execution deadlines
  remain independent
- Current session/assignment/attempt/epoch revocation during awaited policies,
  receipt reads, grouped COMMIT and acknowledgement suppresses stale work
- Connection loss, late responses and owner takeover never grant blind retries;
  unknown commands and external effects retain their separate recovery rules
- Exact predecessor retirement and successor admission preserve attempt counts,
  retry timing and truthful logical versus physical capacity accounting
- Quiet writer protection, revocation fencing and observation repair remain
  covered independently; appends still do not renew storage protection
- Old-format histories are migrated explicitly or refused, never inferred safe
  merely from NULL expiry; generic legacy behavior remains tested until retired

## Source specification amendments

The recovered foundation files were amended together, with their previous text
preserved under history/archive/pre-owner-attempt-authority-2026-10-17:

- F5 §4.2: worker authority, explicit loss, retry/effect boundary; §1 alarm
  duties
- REGISTER §2: worker job leases join architecture-induced mechanism removals
- F4 §§5–5.1 and F2 fencing: delegation ends with current attempt/session loss
- F9 §3.1: owner-driven body protection for both placements
- F7 deadline inventory, OWNER-DESIGN identity descriptions and PHASE3
  allocation
- F5/F9 conformance: revoked-attempt races replace job-expiry predicates while
  independent clocks and content-protection guarantees remain

The approved original local/worker split is historical evidence, not a claim
that this replacement was already specified. Every subsequent slice applies the
[simplification review](refactor-cleanup.md): name the removed mechanism, its
surviving guarantee, remaining consumers and the tests justifying deletion.

## Runtime migration and regression disposition

The current patch converges the EventStore's command-local selector and Action
lifecycle writer for both placements. It removes the two owner renewal routes,
renewal keys/budgets/sequence state, worker renewal loops, the now-unused
execution-heartbeat module and its bundle entries. Owner-context claimNext,
heartbeat, expiry sweep and missing-selector delivery mutations refuse rather
than falling back to the legacy timed path. The owner-only expiry sweep's dead
callback aggregation/clamp is removed too.

No running-attempt alarm classifier remains. A successful claim/start retires
only its exact availability wake in the same transaction. The bounded inventory
checks running-row representation without re-reading every assignment or
constructing additional authority proofs. Unrelated commands never delete a
running attempt's anomalous alarm; the due-alarm path refuses it. Actual
start/current/retirement and raw-drain proofs remain at their proper boundaries,
including authenticated command contexts for local Processor reserve/retry.

Oxian already supplies connection-level WebSocket heartbeat detection, separate
from jobs. In-process work relies on its event-fabric lifetime. An optional
execution deadline is a separate product policy; the current owner host does not
supply one. Content-protection renewal remains a separate implementation gate;
the ordinary worker path did not support open-body renewal before this change.

Original tests remain in the preceding Git history. Mechanism-specific tests are
retired only where the mechanism is removed; their surviving guarantees are
mapped below. The scoped validation and its retained initial failures are
recorded after the migration table.

| Original test responsibility                                 | Replacement or retained evidence                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| execution-heartbeat: serial renewal and stop drain           | Renewal scheduling is retired. Existing local raw-call/drain, held acknowledgement and worker cancellation/terminal tests retain real unsettled-call lifetime guarantees                                                                                 |
| execution-heartbeat: duplicate/wrong renewal reference       | Renewal replies are retired. Exact attempt/reference and duplicate claim without hydration or reexecution remain in owner-port, registered-worker and attempt-authority tests                                                                            |
| execution-heartbeat: timeout plus late successful renewal    | The artificial renewal uncertainty source is retired. Actual claim/terminal/child/effect unknown outcomes, late responses and quarantine remain tested separately                                                                                        |
| registered-worker and owner-port renewal/timing/budget cases | Ports have no renewal method; waiting executions issue no renewal commands; actual owner tests cross the former lease interval and verify NULL deadlines, no renew receipts and no expiry alarms                                                         |
| execution renewal COMMIT/rollback/permission cases           | Existing actual claim/completion COMMIT, rollback, duplicate, stale attempt/epoch and safe receipt tests remain; next real Collection command checks a revoked grant, and narrow settlement remains separate                                             |
| expiry-triggered replacement reuses invoked input            | Elapsed time no longer permits replacement. Captured input immutability and refusal of an unretired replacement are explicit; authorized retry/capture reuse remains a separate actual recovery/preparation obligation                                   |
| deliveries: timed claim/renew/reclaim                        | Exact non-expiring attempt mutation, no time-based stealing, stale token/epoch refusal and unsupported owner renewal/claimNext. Claim/settlement rollback, output gate, replay and retry availability remain                                             |
| delivery-recovery: owner expiry cutoff and implicit sweep    | Explicit configured exact lost targets replace selection by time. Retain original fault/snapshot harness for captured time, retry requeue, duplicate, unknown COMMIT, publication and current fence; high-level eligibility remains in lost-action tests |
| owner sweep default clamp and twenty-callback aggregation    | The owner sweep/clamp is retired. Twenty bounded explicit recovery commands retain ordered/no-starvation publication and earlier callback failure coverage through the real boundary                                                                     |
| generic EventStore owner-sweep backend fixtures              | Owner publication guarantees move to explicit recovery/boundary tests. Genuine non-owner expiry keeps namespace filtering, default100 and explicit7 limits on each backend; no fictitious legacy1000-to100 clamp                                         |

No timer removal removes current business authorization, exact predecessor
retirement, retry backoff, effect ambiguity or output gating. Arbitrary
out-of-band policy-table changes are checked by the next protected owner
command; explicit cancellation/session loss still closes the worker signal.
Observation revocation notifications remain a distinct F4/F6 obligation.

The former local alarm evidence API and its forged-context/17 inert evidence
variants retire with that classification mechanism. Held-start, unknown outcome,
exact caller, retry ordinal, predecessor retirement, capacity and raw-drain
tests remain. Six actual Action helper corruption variants now exercise the real
post-acknowledgement input boundary before factory admission. Both actual
Processor held-reply scenarios still verify real command context authenticity,
no premature execution, and no due successor before known receipt plus drain.

### Exact historical timestamp handoff

Historical finite-deadline lost-Action recovery now captures
`lease_expires_at::text` in its existing delivery `FOR UPDATE` query. The
primitive SQL value is retained unchanged through later policy awaits and passed
to the existing exact compare-and-swap. NULL remains NULL. No extra read,
timestamp parser, cache, public EventDelivery format change or execution
deadline is added.

The former EventDelivery date normalization rounded sub-millisecond timestamps,
causing a safe but incorrect refusal. Six causal cases reproduce that failure;
the corrected tests cover retry, exhausted and cancelled dispositions for both
microsecond instants and explicit timezone offsets. They compare the stored
instant, not the original offset spelling. A one-microsecond policy-time change
still fails the exact CAS and rolls back the relevant durable state. Infinity
and negative infinity remain refused; new NULL-deadline attempts are unchanged.

Independent scoped validation passes 99 normally checked PostgreSQL-configured
cases across seven complete recovery/host files, with no failures or skips. The
root's focused PGlite check passes nine cases. Lint, format, all six static
checks and strict package surface pass (46 exports / 16 external imports / 725
production modules). All 131 test databases were dropped, sessions absent, and
PostgreSQL stopped; candidate and sibling hashes were verified.

This corrects only precision in otherwise eligible explicit recovery. Original
execution-contract, effect, assignment, owner-control and namespace checks still
apply. It does not migrate production history, invent an original contract,
prove remote quiescence or activate general open/local-history restart.

## Independent checkpoint validation — 17 October 2026

The exact frozen source overlay was independently checked against the preceding
committed tree `97f71b24b405b95a8aa0f01e80bf1046de6194c0`. Runtime edits add 209
and remove 1,001 lines (net 792 removed); test/document changes are separate.

- Pure worker/port/attempt/local controller coverage: 154 passed
- Canonical 17-file PostgreSQL run: 156 registrations, 154 passed and 2 failed.
  Both failures were an old connected long-Action test waiting for retired renew
  replies. Its complete corrected 12-case file passes on PostgreSQL, checking
  held execution, 10-minute owner-clock passage, real former timer interval, SQL
  NULL deadline, no renewals and exactly one completion on both transports
- Broader 14-file PostgreSQL owner migration: 186 passed. Its first attempt
  stopped at ordinary typechecking because a worker-only startup fixture had not
  narrowed the expanded placement union; explicit worker/Action narrowing
  corrected it
- Complete native EventStore file: 30 passed, including real PGlite and
  PostgreSQL default 100 / explicit 7 legacy recovery behavior
- Role bundles: 12 passed. Strict surface: 46 exports and 725 production
  modules. Changed-file lint/format and architecture checks pass

All tests used ordinary typechecking. Counts overlap and are not summed into a
new full-suite total. Original failures remain in the acceptance evidence; the
canonical correction is split-run evidence, not a rewritten all-green run. The
separate two-red current-effect-authority test delta is excluded from this
checkpoint. No merge, publication, production migration or public
local-placement completion is implied.
