# Owner, worker and Views implementation checklist

Updated: 18 October 2026, 13:50 UTC.

This is the maintained coordination checklist for
[Copilotz PR #93](https://github.com/copilotzhq/copilotz/pull/93). It tracks
scoped deliverables, not a percentage complete. A checked item means the named
scope is implemented and reviewed; it does not imply its whole workstream is
production-ready. All changes remain draft: **no merge or publication**.

## Acceptance-driven finish plan

The latest explicit order is: **finish the current complete owner refactor, then
run a separate two-agent browser-worker project as end-to-end acceptance, then
migrate Compass including its frontend**. The local server owns persistence;
authored Actions, Processors, agents and compatible tools run in the browser.
See the
[concrete milestones and acceptance matrix](browser-worker-acceptance-plan.md).
The smaller app does not replace any approved refactor scope or the later full
application migration. Preserve the current content safety checkpoint and
complete the remaining functionality, recovery, public APIs, cleanup and library
validation first. Preparing the acceptance contract can run alongside this;
implementing the new project must not displace the unfinished refactor.

## Current priority

The 18 October [retirement review](refactor-cleanup.md) prioritizes real caller
migration and deletion over additional isolated owner components. The reviewed
append/checkpoint gate is pushed and the dormant classifier is removed with its
missing safety cases moved to actual startup. The actual host now uses the fixed
owner core with scoped backend acceptance. Content now has an actual abort-only
invocation path in a private opt-in draft; quiet renewal, orphan cleanup and
shutdown/settlement barriers still belong to this same unfinished slice.
Compatibility tests preserve behavior; permanent dual runtimes are not a goal.

The classifier cleanup preserves the used alarm identity and target type. Its
four missing safety counterexamples now exercise the surviving startup path. It
adds no replacement service or mode. At that cleanup checkpoint, full-static
reachability reported eight unwired modules; that was scoped cleanup acceptance,
not a release gate.

The host-catalog migration is independently accepted in scope: corrected
PostgreSQL 70 tests plus 46 schema steps, final-source PGlite 381 tests plus 46
steps and one explicit PostgreSQL-only skip. The earlier 364-case PostgreSQL
matrix remains pre-correction evidence. Interrupted setup was reproduced on both
backends and fixed with atomic provisioning plus validation-only reopen. The
corrected stage exported/dropped 103 owned databases and stopped PostgreSQL;
source/dependency hashes match. That accepted checkpoint had six unwired content
modules, down from eight through actual host imports. Current content WIP has
not completed a new full-static or full-suite gate.

## Content integration preservation checkpoint (unaccepted WIP)

The private host now connects owner-mediated `streams.open/append/abort` and
invocation disposal through all four Action/Processor drivers, actual local raw
tracking and both worker transports. The existing coordinator performs physical
append acknowledgements separately from coalesced one-second catalog
checkpoints. Known fatal failures stop invocation admission immediately; actual
authored work and cleanup still drain before completion. Later uncertainty
overrides known failure. Owner-control revocation freezes C, fences the original
generation and only then confirms revoked. A strict abort-only drained predicate
is repeated in the final settlement UPDATE; unconfigured hosts retain all-stream
refusal.

Incremental diagnostics, **not one frozen acceptance run**: 155 driver/helper
cases; four named-wire cases; 16 actual PGlite host flows covering both
transports, placements and parent kinds with ctx-loss abort or implicit
disposal; seven later feature/snapshot guards; 12 worker artifact cases. Earlier
control/assignment runs include a captured-binding ordering failure and its
focused correction. The current draft has not received a consolidated
PostgreSQL/PGlite independent gate. No checkbox or complete-content milestone is
closed by these results.

Remaining in this same slice: bounded owner-alarm quiet renewal using the
original current entry/ordinal and fresh grants; hidden/orphan reservation
cleanup; completion/retry and shutdown coordination; failure/lost-reply tests;
final static/artifact/backend review. `close`, `retain`, `follow`,
retained-history adoption and public/default activation remain unavailable. No
legacy writer behavior is extended, no new authority registry/lease is
introduced, and no package is merged or published.

## Historical 13:16 working-tree status and remaining sequence

The pushed preservation checkpoint remains `33673b15` (local `7bc6e7a`,
identical tree `541e5878`). The following newer changes are **uncommitted
working code**, not an accepted or published milestone:

- Quiet owner renewal: 15 focused checks passed, including exact original
  lifetime/grant checks, late deadline/identity changes, 33-writer continuation,
  and cleanup with one held fence
- Orphan opening cleanup: two coordinator checks and eight actual host flows
  passed across Action/Processor, local/worker and both transports. Failure
  waits for actual cleanup; hidden reservations remain hidden
- SQL delivery-completion barrier added; 16 existing real abort/disposal flows
  passed. Direct bypass/retry causal tests remain open
- Fair cleanup pagination is being corrected: its latest combined diagnostic
  passed three cases and failed the held-worker-fence case because a healthy
  writer became revoked. A focused rerun reproduces that failure. This is the
  current blocker; quiet-renewal acceptance is not claimed
- Normal shutdown sweep, full fault coverage and the consolidated independent
  backend/static/artifact gate remain open

These diagnostics come from different intermediate sources. Counts below remain
**105 tasks, 72 checked, 33 open**; no completion checkbox changes.

The coordinated remaining sequence is:

1. Finish private content lifetime in the actual owner flow: renewal fairness,
   orphan cleanup, completion/retry barriers, actual close drain, and
   independent PostgreSQL/PGlite plus artifact/static acceptance
2. Complete supported content behavior: accepted seals, close/retain/follow,
   current-copy resolution, promotion, client repair and retained references;
   finish remaining read/vector/subscription/protected-value contracts
3. Complete recovery parity: retained history/takeover, replay and
   already-admitted stages, continuations/parked execution, handoff,
   cancellation and settlement
4. Migrate public `createCopilotz`, embedded/connected defaults, model/message
   and channel providers, Views UI and plugins; retire each superseded consumer
   and obsolete option/wrapper as its replacement passes
5. Run coherent full-suite, fault/load/resource and package-surface gates;
   finish faster PR feedback, dependency integration and operational/migration
   docs; obtain explicit review/merge/publication approval

Content lifetime is the current implementation track, not the final outstanding
piece of the entire refactor. The unchecked items below remain the authoritative
scope; optional hosting and production migration stay separate.

## 13:45 content safety checkpoint (still unaccepted WIP)

Quiet renewal, bounded keyset cleanup, orphan-open cleanup, SQL completion
barriers and normal close sweeping are implemented in the working tree. The
existing reverse-call capacity entries now expose their actual completion, so
host close joins a held physical call even after transport shutdown finishes. No
additional authority registry or transport drain API was added.

Scoped development evidence on intermediate sources: 40 complete coordinator
cases; 49 focused actual host cases; four held-worker-close cases across both
transports; 140 driver/helper cases after moving a test-only fixture out of
production modules. Removing the raw reverse-call join reproduces all four close
failures. Source review also corrected discovery-error classification and clock
reentrancy. These are not one frozen full acceptance run.

The earlier one-second/21-writer cold-burst failures remain real load evidence.
The revised held-fence case freezes construction only, then runs the original
protection window and a real 2.2-second hold without rewriting deadlines. That
isolates cleanup fairness rather than claiming burst capacity is solved.

The package-surface diagnostic identified five physical-store implementation
modules still awaiting genuine consumer composition, plus a misplaced test
fixture which has now been moved to runtime/testing. A new all-green static or
PostgreSQL gate is not claimed. Content semantics and public composition remain
open and are required by the real two-agent acceptance project.

## Current work

| Task                                 | Status                        | Next acceptance gate                                                                                                                                                                  |
| ------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Processor bound owner adapter  | Reviewed checkpoint           | Reviewed: independent 30 pure and seven real PostgreSQL cases; 83-case compatibility passed                                                                                           |
| Local nested Action authority        | Reviewed checkpoint           | Independent 144 pure and 114 PostgreSQL cases; private fresh same-owner mixed placement complete                                                                                      |
| Local Action effect capabilities     | Reviewed checkpoint           | Private fresh local effects: 300 PostgreSQL-gate cases, 71 pure and 12 role-bundle cases pass                                                                                         |
| Local named preparation / Views      | Reviewed checkpoint           | Fresh local Action/Processor preparation and retry capture pass; public/history gates remain                                                                                          |
| Faster test orchestration            | Representative measured       | 16 files: 15.4% faster, 7.7% higher peak RSS; reordered files require broader isolation validation                                                                                    |
| Reference-test reliability           | Reviewed correction           | 137 affected cases, independent 29-case check and three complete pipeline repeats passed                                                                                              |
| Local Processor host generations     | Reviewed checkpoint           | PostgreSQL 14 host plus two caller-facing helper cases pass; fresh same-owner retry scope complete                                                                                    |
| Ordinary registered Collection reads | Reviewed checkpoint           | PostgreSQL SQL43/Processor 53, final canonical 252, invocation222 and role 12 pass; public snapshot/content gates remain                                                              |
| Shared SQL transaction lifetime      | Reviewed prerequisite         | Ominipg 65 cases, Copilotz 31 plus five steps, four cleanup probes; private owner integration reviewed below; public composition remains gated                                        |
| Pooled SQL timeout progress          | Reviewed prerequisite         | Ominipg 77, Copilotz 31 plus five steps, four cleanup probes and one retained-listener diagnostic; reserved capacity and private integration reviewed below                           |
| Accounted snapshot pool capacity     | Reviewed prerequisite         | One existing pool, bounded pair admission; full scoped 102 Ominipg/31 Copilotz plus five steps; final 25 PG pool cases, seven probes and static pass                                  |
| Native PGlite snapshot lifecycle     | Reviewed prerequisite         | Native mutex/idle/readiness and trusted provider/config scope; 14 typed cases, four probes and static pass; private owner integration reviewed below; public composition remains open |
| Snapshot engine/session resources    | Reviewed backend flow         | 136 Ominipg, 31 Copilotz plus five steps, eight probes and static pass; private owner integration reviewed below; public composition remains open                                     |
| Owner snapshot host integration      | Reviewed private scope        | Final PG/PGlite 34 host+ 24 manager each pass; pure 209, role 12 and full static pass; concurrent load/public activation remain open                                                  |
| Snapshot latency diagnostic          | Initial measurements reviewed | [240 sequential selection samples](snapshot-selection-performance.md); concurrent load, capacity and public defaults remain open                                                      |
| Content writer lifetime              | WIP: renewal fairness fix     | [Private host content draft](owner-content-lifetime-plan.md); quiet owner renewal, orphan/close coordination and consolidated backend/artifact review remain open                     |
| Architecture cleanup                 | In progress                   | Dormant classifier retired; actual host fixed-core/atomic setup accepted: corrected PG70/PGlite381; real content routes in progress                                                   |

A cloud runner restart restored an older workspace. The pushed manager and
reconstructed integration have since completed fresh scoped PostgreSQL/PGlite
validation: final 34 host + 24 manager cases on each backend pass, with the
original failed run retained. The sequential snapshot latency diagnostic is also
complete. These scoped results do not imply full-suite acceptance or public
activation. SQL format isolation, memory/database/S3 physical stores and legacy
catalog admission guards now have scoped passing checks. The latest corrected
catalog gate passes 33 PostgreSQL and 31 PGlite cases plus two PostgreSQL-only
skips, including all 15 formerly blocked settlement cases on each backend. The
new private fresh owner catalog schema separately passes 61 PostgreSQL and 53
PGlite cases with 58 steps on each backend and eight explicit PostgreSQL skips.
All five causal old-version defects remain recorded beside corrected passes. The
unchanged full-static package-surface guard now refuses seven private modules
awaiting genuine host wiring. The private receipt-free mutation boundary now
separately passes 194 PostgreSQL and 187 PGlite cases with seven explicit
PostgreSQL skips, including genuine committed/aborted COMMIT-loss probes. Those
historical gates preceded the later reviewed reservation/checkpoint components
and current unaccepted host integration described above. The shared
operation/event catalog core now separately passes 335 PostgreSQL and 324 PGlite
cases with 11 explicit PostgreSQL-only skips. Legacy SQL/parameter parity is
unchanged in both notification modes; owner recovery still requires its explicit
cleanup hook. Confirmation-order schema checks additionally pass 72 PostgreSQL
and 64 PGlite tests, each with 63 steps; eight PostgreSQL-only cases are
explicitly skipped on PGlite. This schema prerequisite leaves real physical
confirmation and publication commands open.

The approved [lease-free owner attempt contract](owner-attempt-authority.md) is
implemented and independently checked in this scoped checkpoint. Both placements
use exact owner/assignment/attempt authority; worker execution also requires its
current authenticated session. Per-job renewals and running-attempt alarm
classifiers are removed: production runtime changes add 209 and remove 1,001
lines (net 792 removed), without adding another attempt table or worker facade.

Independent evidence: pure 154; PostgreSQL owner-migration 186; native
EventStore 30 including PGlite and PostgreSQL variants; role-bundle 12; lint,
formatting, architecture checks and the strict 46-export / 725-module package
surface. The 17-file canonical run registered 156 and initially passed 154 /
failed 2 because an old long-Action fixture still awaited renewal replies. The
corrected complete 12-case connected file passes on PostgreSQL. This is split
correction evidence, not a claim of one all-green 156 run or a new full-suite
acceptance. The first migration typecheck failure and its explicit worker-only
fixture narrowing are also retained.

The [current effect-authority prerequisite](owner-effect-authority.md) is now
independently checked: 313 scoped PostgreSQL cases pass on one frozen candidate
(canonical 156, core 77, related recovery 73 and lost delivery 7), with ordinary
typechecking and no skips. Final SQL/policy and private lifetime checks protect
fresh effects, duplicates, projections and late COMMIT replies. The same
existing boundary fence now covers Collection calls. Exact captured
input/metadata is compared after policy, including valid body-plus-digest
replacement.

The wider gate also found lease-era recovery test setup and a real terminal
cleanup defect. Fixtures now explicitly seed an ended predecessor rather than
infer recovery from elapsed time. Terminal abandoned-Action cleanup uses the
existing owner recovery writer in the same fenced transaction; live writes keep
their exact attempt restriction. Original failures and corrections are retained.
These are scoped gates, not a new full-suite acceptance.

[Private local Action effects](owner-local-effects.md) are now independently
reviewed. Local and worker effects share the owner protocol and policy; local
calls use the existing raw-call tracker and exact private attempt. Validation
passes 300 cases in PostgreSQL gates (canonical 192, core 77, related 31), plus
71 pure port/driver and 12 role-bundle cases. Unknown outcomes, denied grants,
held replies and same-attempt reconciliation preserve their distinct semantics.
This does not activate Processor effects or retained local-history recovery.

The [prepared-command lifetime fence](owner-prepared-authority.md) now reuses
the child proof map and existing boundary checks. Root-executed gates pass 393
cases under PostgreSQL configuration (preparation 87, core 114, canonical 192),
plus 12 role-bundle and 21 PGlite source-fixture cases, with independent source
and evidence review. The initial mock typecheck, fixture JSON encoding and
unconditional registration failures are retained alongside their corrections.

[Private local named preparation](owner-local-preparation.md) is now reviewed:
the broad independent gates pass PostgreSQL-configured 421 cases (preparation
87, core 114, canonical 220), pure 95 and role-bundle 12. Two lint-only
corrections then pass a separately frozen PostgreSQL replay-close pair, pure 95,
role 12 and all static/package checks. Original failures and split evidence are
preserved. One shared adapter carries direct/named calls for local Actions and
Processors; retry reuses the original View capture without rerendering.

The historical finite-deadline precision correction is now independently
checked: 99 PostgreSQL-configured recovery/host cases pass, plus nine focused
PGlite cases. The existing locked query preserves exact SQL timestamp text for
the existing CAS; NULL deadlines, original recovery eligibility and all
authority gates stay unchanged. No new parser, query or execution lease is
introduced.

[Ordinary registered Collection reads](owner-collection-reads.md) are now
independently checked: PostgreSQL-configured SQL/read 43 and Processor 53 cases,
222 invocation/port/driver cases, final canonical 252 and role 12 cases pass.
The four-file packaging correction followed retained 250/2 canonical and 9/3
role results; it admits only three pure worker modules and tests real artifact
reads. Original 29 implementation/test paths remain byte-identical across the
freezes. All six architecture/package gates pass (46 exports / 730 production
modules).

Local/worker Actions and Processors share get/list/aggregate through the
existing owner projection, query engine and raw-call tracker. No new read
receipt, cache, transport route, timer or job lease is added. Causal regressions
cover late Processor grant/body changes, protected aggregate/cursor sources, SQL
error disclosure and independent ctx/settlement grants. This is scoped
acceptance, not a new full-suite or public/history activation claim.

The [shared transaction lifetime prerequisite](owner-snapshot-prerequisites.md)
now has passing independent scoped gates: Ominipg 65, Copilotz 31 plus five
steps, and four cleanup probes. One lifecycle replaces duplicated PGlite/pooled
callback handling. Unknown BEGIN cleanup, retained executors, raw query drain
and failed rollback are covered; the review-found early public-close defect and
initial dependency/typecheck setup failures are preserved. Canonical CI
node-modules mode passes Drizzle without weakening its test. This dependency
work remains in Ominipg PR #4 with published pins unchanged.

The pooled timeout prerequisite now scopes waiting through the existing pending
request map, allowing a pinned transaction to free a connection awaited by an
unrelated timed-out query. Private routing capture, independent UNLISTEN
completion and encoding-failure cleanup are covered. Final independent gates
pass Ominipg 77, Copilotz 31 plus five steps, four cleanup probes and one
listener retention diagnostic. A wording-only correction passes ten focused
cases with two explicit PostgreSQL skips. The listener connection remains
charged after unsubscribe; no extra pool, connection budget or lane registry is
introduced.

The accounted PostgreSQL pool prerequisite now reserves snapshot/control
capacity within the existing connection total, including queued borrows and
retained LISTEN connections. It adds no second pool or execution lease.
Independent scoped gates pass 102 Ominipg and 31 Copilotz cases plus five steps;
a final test-only lint correction passes 25 actual-PostgreSQL pool cases, seven
fault/causal probes and static checks. Cleanup retry and reentrant shutdown
regressions are covered; failed physical cleanup is never treated as success.
The later callback checkpoint below exposes this control capability; owner
snapshot activation remains open.

The native PGlite prerequisite now reuses its transaction mutex, with sealed
query lifetime, raw drain and explicit rollback. Actual idle-state/readiness and
narrow provider/configuration certification avoid another lock or SQL parser.
Fourteen typed cases, four independent probes and static checks pass. The
executor is internal for trusted compiled reads; it is not arbitrary-SQL
confinement. The helper alone does not establish engine/session admission or
owner authorization; the next checkpoint records the backend integration.

The backend now carries snapshots through engine/session open, query and close.
It preserves independent PostgreSQL control-lane progress and native PGlite
exclusivity, handles EOF/close without pin deadlock, and retains cleanup
failures after resource removal. Accepted ordinary queued lane work still drains
before graceful shutdown. Independent gates pass 136 Ominipg, 31 Copilotz plus
five steps, eight reviewer probes and static checks.

The callback API now exposes exclusive PGlite and pooled snapshot/current
scopes, including typed Drizzle forwarding. Captured cancellation and final
query/COMMIT checks suppress late results; immediate admission rechecks prevent
reentrant signal getters from overwriting a live scope or admitting after close.
Independent acceptance passes 150 Ominipg, 31 committed Copilotz cases plus five
steps, 11 client probes and four transaction controls, with static/hash/cleanup
verification. Ominipg PR4 commit cac16762 and Verify39081896535 are green.
External sync and packed-release suites remain outside this scoped gate.

Managed-generation forwarding now passes independent scoped acceptance: 41 cases
plus five steps on actual PostgreSQL/PGlite, four unchanged reviewer probes,
static checks and full source/cleanup audits. The existing reference count pins
one backend scope through cleanup, with immediate lifetime revocation on
retirement and no replay onto a replacement generation. Final cancellation and
generation-witness ordering defects found in review are fixed with causal
regressions. Generic persistence close still suppresses database close errors;
its successful return does not prove physical cleanup. Owner historical
authorization, expiry and actual worker/local snapshot activation remain open.

Shared authority validation now reuses the existing assignment, Action and
Processor checks in a private exclusive read-only mode. Normal commands and
PostgreSQL current checks keep their locks. Independent broad gates pass 90
PGlite cases (one explicit PostgreSQL-only skip) and 235 PostgreSQL cases with
one baseline bigint-count assertion mismatch. The test-only portable correction
then passes 35 PostgreSQL cases and the corrected PGlite case, with static,
source-hash and database-cleanup checks. No coherent 236-case rerun is claimed.
The mode does not supply an epoch fence or prove exclusivity: host snapshot
routing and historical permissions remain open.

Ordinary Collection reads now share a bounded prepared evaluator with a private
synchronous finalizer. Final authorization precedes output
validation/disclosure, preserving error precedence after revocation without a
second query compiler. Independent final gates pass 184 PostgreSQL
SQL/authority/host/helper cases, 42 PGlite cases with three PG-only skips
covered separately, three reviewer probes and 12 role bundles. Static,
source-hash and database-cleanup checks pass. The initial output-error
precedence defect and two fixture forwarding corrections are preserved with
their fixes. Historical grants, owner snapshot resource lifetime and
worker/local activation are still next; performance benchmarks remain required
before production acceptance.

Snapshot cleanup now has an explicit per-invocation outcome, separate from the
returned value/error. Only no-open or exact close acknowledgement confirms
release; lost acknowledgement or missing/duplicate reports remain unknown. This
lets an owner distinguish temporary capacity refusal from unproved cleanup
without error-message classification or another resource registry. Backend
acceptance passes 157 Ominipg, 41 committed Copilotz cases plus five steps and
25 probes; Verify39085866437 is green for Ominipg423d1b23. Managed forwarding
passes 46 cases plus five steps and ten probes, with static/hash/cleanup checks.
Generic persistence close still supplies no physical-release proof. The owner
resource manager is now being implemented; historical permission and actual
worker/local invocation routing are not activated yet.

The private snapshot host integration has been reconstructed and safely pushed
at `8bad28e26d23796c88d8f1ffd2b6748af489d851`, identical source tree
`042c05c2e0896a0f052d6adcd8af39e5cb543571`. It captures existing local/worker
lifetimes, routes open/read/close outside the ordinary command queue, and wires
registered Action/Processor callbacks. Host shutdown joins independently owned
SQL cleanup. Missing cleanup proof quarantines the resource and stops owner
admission, including after invocation revocation.

Final independent correction replay passes **34 host + 24 manager cases on each
of actual PostgreSQL and native PGlite:116 passes, zero failures/skips**. Both
corrected test files pass lint/format, and the unchanged full static gate passes
with 46 exports and 734 production modules. The earlier source-identical review
also supplies PostgreSQL 35 compatibility and eight probes, PGlite seven probes
with one explicit pooled-only skip, pure 209 and role 12.

The original broad run remains recorded as 464 passes, two failures and one
skip. Both failures were fixture assumptions: cancellation can surface either of
two exact refusal codes depending on backend ordering; the grant-loss test must
restore its fixture policy after snapshot rejection to avoid denying a separate
later retry start. Corrected Processor cases now wait for successful retry
attempt 2 and zero active executions before asserting stable readiness.
Production bytes are unchanged across these test corrections. All 58 final
fixture databases and coordinator were exported/dropped, no sessions or
leftovers remain, and the database service stopped. This is scoped acceptance,
not a new full-suite or production-load pass.

The next snapshot prerequisite must preserve F5 isolation and default PGlite
behavior: PostgreSQL has separate pooled transactions, while PGlite serializes
its single engine. No weaker snapshot fallback or hidden external-database
requirement has been selected. Quiet-writer content protection, open-history
takeover and public local placement remain separate gates. Every slice must name
what it simplifies and eliminates before adding machinery.

## 1. Programming model and composition

- [x] One plugin composition model including Collections, Actions, Processors,
      Resources, Adapters and Views
- [x] Reviewed ordinary storage/owner `createCopilotz` surface with explicit
      limits
- [x] Whole-plugin workers with owner-mediated persistence over in-process and
      WebSocket transports
- [x] Code-only worker build and executable dependency checks
- [ ] Complete the public Collection/read/observation and HTTP ingress APIs
- [ ] Public owner-side mixed placement selection after private local parity
- [ ] Complete embedded/local and connected parity without implicit
      topology-dependent semantics

## 2. Durable owner and execution

- [x] Current-table fenced transaction boundary, command receipts, savepoints
      and event sequences
- [x] Placement-independent logical mutation identity and local callback return
      semantics
- [x] Shared SQL transaction lifetime prerequisite: unknown BEGIN cleanup,
      callback executor sealing and raw drain, with fail-closed rollback and
      public close drain; registered snapshots remain unavailable
- [x] Pooled timeout progress through existing request facts, immutable routing
      capture, independent unsubscribe and encoding-failure cleanup; PGlite
      retains its global gate and listener capacity remains charged
- [x] Shared PostgreSQL pool accounting and bounded two-client reservation,
      including queued checkouts/LISTEN and raw cleanup; no extra pool or budget
- [x] Internal native PGlite snapshot lifecycle and narrow
      provider/configuration certification; actual idle/readiness, sealed raw
      drain and confirmed rollback
- [x] Bounded snapshot engine/session resource flow: scoped lanes, prior-work
      drain, sync exclusion, cleanup quarantine, EOF/close and legacy lane drain
- [x] Scoped backend callback API and typed Drizzle forwarding: captured
      cancellation, reentrant admission protection, retained executor sealing
      and actual raw cleanup; PostgreSQL/PGlite checked, CI green
- [x] Managed-generation forwarding through existing references: immediate
      revocation, final cancellation/witness checks, no replay or plain
      fallback; actual PostgreSQL/PGlite scoped compatibility and fault probes
      pass
- [x] Reuse assignment/Action/Processor authority checks in certified exclusive
      read-only scopes; default command/current-PostgreSQL locks preserved; host
      routing, epoch fencing and historical grants remain separate
- [x] Shared bounded Collection evaluator and private synchronous finalizer;
      final authorization preserves output-error precedence, with actual
      worker/local read compatibility and protected-source/budget checks
- [x] Explicit backend snapshot cleanup outcome and generation-safe forwarding;
      known release stays separate from cancellation/errors, with missing or
      duplicate reporting fail-closed and no new wire operation
- [x] Private owner snapshot manager and genuine host integration: existing
      local/worker lifetimes, queue-free routing, registered callback flow,
      explicit cleanup ownership and actual PG/PGlite corrected acceptance;
      public composition and load/performance gates remain separate
- [x] Actual worker Action/Processor/Collection/child-Action flow
- [x] Current authority, assignment/claim, connection lifetime, cancellation and
      terminal settlement boundaries
- [x] Private fresh local Action/Collection execution, exact epoch/attempt
      authority and NULL lease
- [x] Private local Processor command prerequisite, independently checked on
      PGlite and PostgreSQL
- [x] Private one-attempt local Processor driver with strict receipt/lifetime
      validation
- [x] Local Processor bound owner adapter and actual lifecycle integration,
      including Collection writes/replay and unknown outcomes
- [x] Private fresh same-owner local Processor retry lifecycle and alarms;
      [actual host wiring](owner-host-local-processor.md), caller-facing held
      replies and sub-millisecond eligibility are independently verified on
      PostgreSQL: 14 host plus two helper cases, alongside the pure controller
      and adapter evidence; restart/public placement remain separate gates
- [x] Correct the analogous local Action receipt-hook reentrant-drain gap; both
      causal regressions retained, 124 compatibility cases and independent
      114-case pure review passed; separately fix Action controller revocation
      during owner-current callbacks, with a retained causal regression and
      113-case controller/port compatibility check
- [x] Shared ordinary child current-parent proofs, exact physical lineage and
      command-scoped final authorization fence: independent PostgreSQL147 plus
      one final test-only correction pass, with all151 fixture databases dropped
      and both service runs stopped; original failed/corrected evidence
      retained. Ordinary protected-format family refusal separately passes
      PostgreSQL53 plus one fixture cleanup probe, preserving ordinary
      application field names
- [x] Private fresh same-owner local nested Action authority and mixed
      parent/child placement, including Processor retries: independent 144 pure
      and 114 PostgreSQL cases pass, all112 fixture databases dropped and the
      service stopped. Exact current authority, fail-fast capacity and raw-call
      drain are preserved. Local preparation, effects, restart and public
      placement remain separate gates; the 152-case canonical inventory is not a
      claim of a combined canonical or full-suite run
- [x] Remove owner-path per-job leases/renewal, worker renewal loops and
      running-attempt alarm classifiers; exact attempt revocation and explicit
      loss recovery replace expiry. Connection liveness and genuine legacy
      EventStore behavior remain; F9 quiet-writer protection is still a separate
      implementation gate
- [x] Current effect authority after awaited policies and receipt reads, exact
      captured lifecycle equality, private effect/Collection boundary fences,
      and same-transaction terminal abandoned-obligation cleanup
- [x] Private fresh local Action effect capability parity through the shared
      protocol/policy and bound raw-call tracker, including same-attempt
      declared reconciliation without resending; retained local history remains
      separate
- [x] Prepared child admission uses the existing final private lifetime fence,
      including duplicate receipt access and post-COMMIT reply suppression;
      configured and unconfigured hosts both pass the complete canonical gate
- [ ] Public local placement activation and complete parity matrix

## 3. Recovery and continuations

- [x] Real PostgreSQL unresolved-COMMIT and process-death tests, including
      committed and aborted outcomes
- [x] Conservative ordinary history/Collection graph restart and canonical
      replay
- [x] Closed ordinary root Action plus ordinary-record prepared-child restart
- [x] Private exact-target exhausted/cancelled terminal cleanup with strict
      provenance and no blind retry
- [x] Effect state, duplicate-begin refusal and bounded reconciliation
      prerequisites
- [ ] General takeover/readiness across open, lost, retrying and effect-bearing
      histories
- [ ] Verify current Tool cursors and already-admitted stages on replay, beyond
      the corrected explicit Action identity
- [ ] Retained local history and restart parity
- [ ] `awaitOperation`, parked execution, durable handoff and exactly-once
      resumption admission
- [ ] Complete cancellation propagation, resume causation and settlement
      interaction

## 4. Data, authority and content

- [x] Memory append idempotency preserves original offset and owned bytes;
      causal wrong-offset regressions, seven memory cases, 65-case independent
      content compatibility and full static checks pass; legacy lifetime remains

- [x] Reviewed ordinary Collection writes and authorization at execution
      boundaries
- [x] Immutable ordinary-record/database-content preparation references and
      original-source reauthorization
- [x] Ordinary registered get/list/aggregate in local/worker Actions and
      Processors, bounded owner scope and source checks, current authority and
      raw drain
- [ ] Complete read/query, vector, snapshot and subscription integration
- [ ] Full logical content/current-copy catalog, body ownership, retention and
      retirement
- [ ] Streams, partial output, attempt-bound writers and client repair
- [ ] F9 owner-driven quiet-writer body protection for both placements,
      independent of per-job renewal
- [x] Historical finite-deadline recovery preserves exact locked SQL timestamp
      precision through the existing CAS; policy-time mutation still refuses,
      and current NULL-deadline attempts remain unchanged
- [ ] Protected values, credential slots and scope-bound delivery
- [ ] Cross-owner operations and remaining wire/device contracts

- [x] Preserve accepted object-store parts when an identical append retry wins
      after a stale loser read (S3/GCS-compatible mocks and legacy compatibility
      checked)

- [x] Isolate reserved owner physical object keys from legacy S3/GCS reads,
      writes and all maintenance listings; 81 checked compatibility cases and
      seven independent probes pass, including metadata-free orphan aliases

- [x] Private S3 reserve/append/fence with signed conditional writes, bounded
      manifests/responses, exact retries and retained losing parts; independent
      TCP-loss/retry/fence probes and compatibility pass
- [x] Shared private 1 MiB range-read admission before I/O across memory, SQL
      and S3; larger reads require paging
- [ ] Wire private physical stores into real owner catalog/execution
      composition; clear remaining package-surface reachability failures through
      genuine wiring and rerun the unchanged full-static gate

- [x] Legacy catalog format admission guards: composed event/index SQL,
      duplicate callbacks, supplied transactions, provisioning races and cached
      recovery/maintenance; scoped PostgreSQL/PGlite review passed
- [x] Repair the pre-existing settlement fixture to use exact owner attempts for
      delivery mutations; all 15 cases pass on both backends without restoring
      leases or weakening assertions

- [x] Private fresh owner stream format, exact retained-layout validation,
      reserving phase and legacy DDL reuse; independent PostgreSQL/PGlite
      schema, mutation and provisioning-race checks pass without host activation
- [x] Private registered receipt-free mutation boundary on the existing owner
      queue, with current lifetime fences and no automatic receipts or sequence
      events; scoped PostgreSQL/PGlite and real COMMIT-loss checks pass
- [x] Share the existing format-bound operation/event catalog core; private
      owner factory exposes only six members, with required recovery hooks kept
      separate and legacy SQL/parameter parity independently checked
- [x] Owner-only confirmation-order ordinal and zero-offset reservation shape,
      terminal revocation constraint and exact old-layout refusal; scoped
      PostgreSQL/PGlite schema and legacy DDL compatibility checks pass
- [x] Isolated catalog-first reservation/physical-confirmation coordinator on
      the existing private boundary, exact catalog-native replay and atomic
      publication event/ordinal; independent backend and COMMIT-loss gates pass
- [x] Separate tentative physical append from receipt-free offset acceptance;
      scoped PostgreSQL/PGlite, replay-after-tail and real COMMIT gates pass
- [ ] Catalog-first reservation, physical confirmation and visibility through
      the same local/worker content coordinator; confirmation-time ordinals,
      hidden failed reservations and accepted-prefix-only observation

## 5. Views, providers and clients

- [x] View primitive authoring, registry, resolution and bounded text rendering
- [x] Real `prepareNamed` ordinary-record → View → captured child execution on
      both transports
- [x] Capture reuse and current-permission checks, including the reviewed
      closed-history restart subset
- [x] Bounded Telegram ordinary-text effect Action with injected-provider loss
      tests
- [ ] Complete default model-context/message-router integration
- [ ] Default channel rendering/egress, multipart/media and remaining provider
      conversions
- [x] Private fresh same-owner local Action/Processor named preparation through
      the shared adapter, with mixed child placement, immutable retry capture,
      original-source gates and raw-call drain
- [ ] Broader content/protected preparation
- [ ] Live browser/React Views and UI support
- [ ] Consumer/plugin migration and compatibility completion

## 6. Validation, performance and release

- [x] Initial optional snapshot latency diagnostic: 240 timed selections across
      PostgreSQL/PGlite and local/loopback-worker Actions; explicit methodology,
      conventional medians and preserved setup failures; no production-load
      claim

- [x] Full validation of frozen tree `93912965304ed93dc11a38881f3c509fe9ff423d`
      (PR commit `fd629452`): 511 files, 2,777 passing cases, zero failures, two
      declared opt-in skips
- [x] Canonical 122 integration cases, four memory supplements, static/package
      checks and clean runtime/build matrix on that checkpoint
- [x] Independently verified source/log integrity and disposable database
      cleanup
- [x] Fix bounded jq worker admission and executor shutdown defects found by the
      earlier full run
- [x] Experimental checked serial-batching runner setup review
- [x] Correct the reference-test Action identity defect, independently reviewed;
      137 affected cases passed, ten PostgreSQL-only skips, plus three complete
      seven-case pipeline repeats; preserve the original failed repeat
- [x] Measure a frozen 16-file representative pair: 115 tests plus eight steps
      pass in both modes; grouped run 15.4% faster with 7.7% higher peak RSS
- [ ] Establish full-suite order/isolation equivalence and resource bounds;
      retain the representative orchestrator's file-order comparison failure
- [ ] Adopt faster developer/PR feedback and complete regression workflows after
      evidence
- [ ] Validate each newer increment and rerun the complete gate at coherent
      release checkpoints
- [ ] Complete failure/load testing and all retained conformance requirements
- [ ] Integrate approved dependency versions, update migration/operational
      documentation
- [ ] Obtain explicit merge/publication approval; no release is currently
      authorized

- [x] Contain native PostgreSQL client/pool error events through existing
      diagnostics without changing unknown COMMIT or cleanup accounting

Provider fault ownership is independently accepted in
[Ominipg PR4](https://github.com/AxionCompany/ominipg/pull/4), source
`6ac94e8a1cffa65f09f8c90b6eeced28e76b9eb7`. The existing diagnostic route now
owns borrowed/idle faults, preserves unknown COMMIT outcomes and retained
cleanup accounting, and avoids duplicate scoped/global reporting. Same physical
transaction probes pass with no uncaught output. Verify run39104252261 passed
all five jobs (Deno, Node22/24, Bun and Cloudflare-shaped bundle checks);
published dependency pins and public activation remain unchanged.

## 7. Consolidation and legacy retirement

- [x] Remove dormant reconciliation classifier and duplicate fixture; carry four
      missing safety cases into actual startup, with independent PG51/PGlite51
- [x] Migrate actual owner host/startup/settlement to fixed owner catalog;
      atomic setup/retry and refusal gates accepted: corrected PG70/PGlite381

- [x] Measure the PR additions and distinguish production code from tests/docs
- [x] Document each legacy runtime's proposed replacement and deletion gates in
      the [cleanup plan](refactor-cleanup.md)
- [x] Consolidate duplicated local Action/Processor raw-call and hook accounting
      without changing their authority or settlement semantics
- [ ] Migrate the complete public facade and embedded/default callers to the
      surviving architecture
- [ ] Retire superseded legacy composition, context and invocation paths after
      their caller and behavior gates pass
- [ ] Remove obsolete wrappers, option types, exports and compatibility branches
- [ ] Consolidate repeated fixture provisioning while preserving fault coverage
      and backend isolation
- [ ] Review net responsibility/source changes and rerun the coherent release
      gate; do not finish with duplicate supported execution architectures

## Related draft PRs and boundaries

- [Oxian #28](https://github.com/AxionCompany/oxian-js/pull/28): generic reverse
  calls and transport/dispatch/runtime compatibility
- [Ominipg #4](https://github.com/AxionCompany/ominipg/pull/4): PostgreSQL
  savepoint transaction-lane correction

Connected acceptance currently uses explicit reviewed sibling source mappings.
Published dependency pins are unchanged. Browser/edge bundle smoke checks use
Node VM environments; they are not a real browser-engine or Cloudflare
deployment.

The [Processor Action identity correction](processor-action-identity.md) changes
durable IDs in the legacy context. Existing in-flight IDs are not automatically
translated; production rollout requires a separate cutover decision.

Specific hosting adapters, production data migration, Compass cutover and the
preserved original unpushed work remain separate choices. They are not silently
included in a checked platform item.

## How this list is updated

Move items only after the stated evidence exists. Record a commit/PR checkpoint
for reviewed work; distinguish code in progress from tests that have passed.
Keep unsupported capabilities and blocked gates visible. Do not count an
individual fixture as complete runtime parity or rewrite a historical failed run
after a later correction.
