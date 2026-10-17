# Owner, worker and Views implementation checklist

Updated: 17 October 2026, 19:58 UTC.

This is the maintained coordination checklist for
[Copilotz PR #93](https://github.com/copilotzhq/copilotz/pull/93). It tracks
scoped deliverables, not a percentage complete. A checked item means the named
scope is implemented and reviewed; it does not imply its whole workstream is
production-ready. All changes remain draft: **no merge or publication**.

## Current work

| Task                                | Status                  | Next acceptance gate                                                                               |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------- |
| Local Processor bound owner adapter | Reviewed checkpoint     | Reviewed: independent 30 pure and seven real PostgreSQL cases; 83-case compatibility passed        |
| Local nested Action authority       | Reviewed checkpoint     | Independent 144 pure and 114 PostgreSQL cases; private fresh same-owner mixed placement complete   |
| Local Action effect capabilities    | Reviewed checkpoint     | Private fresh local effects: 300 PostgreSQL-gate cases, 71 pure and 12 role-bundle cases pass      |
| Local named preparation / Views     | Reviewed checkpoint     | Fresh local Action/Processor preparation and retry capture pass; public/history gates remain       |
| Faster test orchestration           | Representative measured | 16 files: 15.4% faster, 7.7% higher peak RSS; reordered files require broader isolation validation |
| Reference-test reliability          | Reviewed correction     | 137 affected cases, independent 29-case check and three complete pipeline repeats passed           |
| Local Processor host generations    | Reviewed checkpoint     | PostgreSQL 14 host plus two caller-facing helper cases pass; fresh same-owner retry scope complete |
| Architecture cleanup                | In progress             | Shared local-port bookkeeping consolidated; migrate callers and retire superseded paths next       |

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

Next is the bounded historical finite-deadline precision correction.
Quiet-writer content protection, open-history takeover and public local
placement remain separate gates. Every slice must name what it simplifies and
eliminates before adding machinery.

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

- [x] Reviewed ordinary Collection writes and authorization at execution
      boundaries
- [x] Immutable ordinary-record/database-content preparation references and
      original-source reauthorization
- [ ] Complete read/query, vector, snapshot and subscription integration
- [ ] Full logical content/current-copy catalog, body ownership, retention and
      retirement
- [ ] Streams, partial output, attempt-bound writers and client repair
- [ ] F9 owner-driven quiet-writer body protection for both placements,
      independent of per-job renewal
- [ ] Historical finite-deadline sub-millisecond recovery precision correction;
      current normalization fails closed, and new NULL-deadline attempts are
      unaffected
- [ ] Protected values, credential slots and scope-bound delivery
- [ ] Cross-owner operations and remaining wire/device contracts

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
