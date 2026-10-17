# Owner, worker and Views implementation checklist

Updated: 17 October 2026, 12:03 UTC.

This is the maintained coordination checklist for
[Copilotz PR #93](https://github.com/copilotzhq/copilotz/pull/93). It tracks
scoped deliverables, not a percentage complete. A checked item means the named
scope is implemented and reviewed; it does not imply its whole workstream is
production-ready. All changes remain draft: **no merge or publication**.

## Current work

| Task                                         | Status                                       | Next acceptance gate                                                                            |
| -------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Local Processor durable commands             | Reviewed checkpoint                          | Integrate with the driver and bound owner adapter                                               |
| Local Processor one-attempt execution driver | In progress                                  | Independent review, failure/lifetime cases, then bound owner adapter                            |
| Faster test orchestration                    | Experimental runner implemented and reviewed | Equivalent same-source benchmark; not yet the authoritative gate                                |
| Reference-test reliability                   | Investigating                                | Diagnose the repeat PGlite unavailable-root terminal-cursor failure before comparing speed      |
| Local Processor host generations             | Next                                         | Known ended-attempt receipt, predecessor revocation/drain, exact retry wake and shared capacity |

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
- [ ] Local Processor driver, bound adapter and generation-aware retry lifecycle
- [ ] Local nested Action authority and mixed parent/child placement
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
- [ ] Resolve the separately repeated reference-test flake; preserve the passing
      full-run evidence and failing repeat separately
- [ ] Measure batched/per-file coverage equivalence, speed and resource bounds
- [ ] Adopt faster developer/PR feedback and complete regression workflows after
      evidence
- [ ] Validate each newer increment and rerun the complete gate at coherent
      release checkpoints
- [ ] Complete failure/load testing and all retained conformance requirements
- [ ] Integrate approved dependency versions, update migration/operational
      documentation
- [ ] Obtain explicit merge/publication approval; no release is currently
      authorized

## Related draft PRs and boundaries

- [Oxian #28](https://github.com/AxionCompany/oxian-js/pull/28): generic reverse
  calls and transport/dispatch/runtime compatibility
- [Ominipg #4](https://github.com/AxionCompany/ominipg/pull/4): PostgreSQL
  savepoint transaction-lane correction

Connected acceptance currently uses explicit reviewed sibling source mappings.
Published dependency pins are unchanged. Browser/edge bundle smoke checks use
Node VM environments; they are not a real browser-engine or Cloudflare
deployment.

Specific hosting adapters, production data migration, Compass cutover and the
preserved original unpushed work remain separate choices. They are not silently
included in a checked platform item.

## How this list is updated

Move items only after the stated evidence exists. Record a commit/PR checkpoint
for reviewed work; distinguish code in progress from tests that have passed.
Keep unsupported capabilities and blocked gates visible. Do not count an
individual fixture as complete runtime parity or rewrite a historical failed run
after a later correction.
