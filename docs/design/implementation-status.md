# Owner, worker and Views implementation checklist

Updated: 18 October 2026, 06:07 UTC.

This is the maintained coordination checklist for
[Copilotz PR #93](https://github.com/copilotzhq/copilotz/pull/93). It tracks
scoped deliverables, not a percentage complete. A checked item means the named
scope is implemented and reviewed; it does not imply its whole workstream is
production-ready. All changes remain draft: **no merge or publication**.

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
| Content writer lifetime              | WIP: DB physical checked      | [Memory/DB fencing and SQL format isolation](owner-content-lifetime-plan.md) checked; provider fault containment, S3 and owner integration remain open                                |
| Architecture cleanup                 | In progress                   | Shared local-port bookkeeping consolidated; migrate callers and retire superseded paths next                                                                                          |

A cloud runner restart restored an older workspace. The pushed manager and
reconstructed integration have since completed fresh scoped PostgreSQL/PGlite
validation: final 34 host + 24 manager cases on each backend pass, with the
original failed run retained. The sequential snapshot latency diagnostic is also
complete. These scoped results do not imply full-suite acceptance or public
activation. Current implementation work is the private content writer path; SQL
format isolation is now independently checked; database/S3 writers and owner
integration remain pending.

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

- [ ] Contain native PostgreSQL client/pool error events through existing
      diagnostics without changing unknown COMMIT or cleanup accounting

## 7. Consolidation and legacy retirement

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
