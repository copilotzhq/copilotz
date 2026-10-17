# Owner, worker and Views implementation checklist

Updated: 17 October 2026, 16:56 UTC.

This is the maintained coordination checklist for
[Copilotz PR #93](https://github.com/copilotzhq/copilotz/pull/93). It tracks
scoped deliverables, not a percentage complete. A checked item means the named
scope is implemented and reviewed; it does not imply its whole workstream is
production-ready. All changes remain draft: **no merge or publication**.

## Current work

| Task                                | Status                    | Next acceptance gate                                                                               |
| ----------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| Local Processor bound owner adapter | Reviewed checkpoint       | Reviewed: independent 30 pure and seven real PostgreSQL cases; 83-case compatibility passed        |
| Local nested Action authority       | Reviewed checkpoint       | Independent 144 pure and 114 PostgreSQL cases; private fresh same-owner mixed placement complete   |
| Local Action effect capabilities    | Paused for simplification | Extend exact local attempt authority and raw-call accounting to the existing effect flow           |
| Faster test orchestration           | Representative measured   | 16 files: 15.4% faster, 7.7% higher peak RSS; reordered files require broader isolation validation |
| Reference-test reliability          | Reviewed correction       | 137 affected cases, independent 29-case check and three complete pipeline repeats passed           |
| Local Processor host generations    | Reviewed checkpoint       | PostgreSQL 14 host plus two caller-facing helper cases pass; fresh same-owner retry scope complete |
| Architecture cleanup                | In progress               | Shared local-port bookkeeping consolidated; migrate callers and retire superseded paths next       |

The next implementation is the approved
[lease-free owner attempt contract](owner-attempt-authority.md). This replaces
per-job worker renewal with exact owner/session/assignment authority. The
recovered specification is amended; the runtime migration and replacement tests
are pending. Every slice must name what it simplifies and eliminates before
adding further machinery.

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
- [x] Current authority, assignment/claim, heartbeat, cancellation and terminal
      settlement boundaries
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
- [ ] Remove owner-path worker per-job leases/renewal and replace expiry
      recovery with exact attempt revocation, retaining session and content
      protection
- [ ] Local Action effect capability parity
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
- [ ] Local named preparation and broader content/protected preparation
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
