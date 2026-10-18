# Refactor consolidation and legacy retirement

Cleanup is a completion gate for this refactor, not an optional pass after
release. The final product must not require maintaining parallel legacy and
owner-mediated application architectures for the same supported behavior.

## Measured starting point

Compared with main `8736b9c8`, PR checkpoint `064bb1a8` / tree `e3e2d03` adds
101,577 lines and removes 854 across 277 text files. Path-based classification:

| Category                    |  Added | Removed |
| --------------------------- | -----: | ------: |
| Tests and fixtures          | 65,084 |      30 |
| Test support                |    407 |       0 |
| Production and other source | 33,061 |     778 |
| Documentation               |  2,305 |      45 |
| Tooling/configuration       |    720 |       1 |

This measures changed lines, not unique functionality or executable complexity.
The source category includes build/entrypoint code. Tests explain most
additions, but do not justify the remaining production growth. Counts exclude
uncommitted drafts. The removal target is redundant responsibility, not an
arbitrary line quota or fewer safety checks.

## Target architecture

- One `createCopilotz` programming model, shared authored Action/Processor
  execution, and explicit placement-specific authority and transport adapters
- Owner-mediated persistent operations in each supported placement
- General-purpose plugin workers; ingress/egress is a worker capability
- Simple embedded defaults without a new external database or network service
  prerequisite
- One supported public behavior contract after migration, rather than permanent
  parallel legacy and owner-specific facades

## Simplification review before every implementation slice

Begin with the guarantees required by the owner architecture, not a port of
existing mechanisms. For every slice, record:

1. Which invariant the old mechanism protects and which component now owns it
2. Whether owner serialization, epoch fencing, authenticated session/attempt
   authority or an existing shared capability already supplies that guarantee
3. What can be eliminated, what can be consolidated and what remains necessary;
   name the concrete callers, options, commands, timers and persisted fields
4. The counterexample tests that prove the replacement, including interruption,
   unknown outcomes, stale authority and external-effect ambiguity where
   relevant
5. The exact deletion in this slice, or a named blocker and follow-on deletion

Apply this review before adding new layers, not only during final cleanup.
Preserving a guarantee does not require preserving its old implementation. Where
the approved specification explicitly requires the mechanism, raise the conflict
and obtain the user's amendment before changing it.

### First architecture-level candidate: worker delivery leases

The recovered approved F5 owner contract §3 already calls for removing old
coordination mechanisms when owner serialization plus tests covers their
invariant. However, §4.2 explicitly retains worker leases/heartbeats while
removing them for local execution. The user approved changing this split on 17
October 2026. The [amended attempt contract](owner-attempt-authority.md) is now
the accepted scoped runtime checkpoint: per-job renewals and running-attempt
alarm classifiers are removed. F9 quiet-writer protection, general retained
history migration and full-suite release acceptance remain separate gates.

The proposed replacement retains owner epoch/holder fencing and authenticated
session/assignment/attempt authority. Review worker renewal commands, projected
lease budgets, heartbeat drivers, EventStore mutation predicates, expiry alarms,
recovery and retained formats together. A disconnected worker is unauthorized,
not proven physically stopped: remote capacity accounting and external effects
need their own evidence. Connection liveness, retry availability/backoff and
optional execution deadlines are independent concerns. F9 open-body lifetime
renewal and observation head heartbeats must be assessed separately rather than
removed by a broad heartbeat search. Legacy consumers require an explicit
migration or retirement gate.

## Replacement map and deletion gates

| Current responsibility                                                                                                         | Replacement or consolidation                                                                                   | Gate before removal                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Legacy embedded/gateway/worker branches in `create-copilotz.ts`                                                                | Unified storage/owner/default composition                                                                      | Migrate the complete public facade and its existing caller tests; preserve simple embedded defaults                                  |
| Legacy application assembly in `runtime/application/copilotz.ts`, `gateway.ts`, `worker.ts`, and `application.ts`              | Owner host/dispatch plus whole-plugin worker composition                                                       | Actual ingress, HTTP facade, observation, cancellation, shutdown and operation APIs must work on the replacement                     |
| Legacy Processor context construction and invocation paths in `runtime/engine/context.ts` and relevant Action caller internals | Shared registered Action/Processor kernels with bound owner capabilities                                       | Existing core routing, providers, deferred work, content/protected values and capability semantics must pass through the replacement |
| Duplicated local Action/Processor raw-call and receipt-hook bookkeeping                                                        | One internal raw-call tracker used by both ports                                                               | Preserve error classification, bounds, reentrant admission/drain and unknown-outcome behavior with unchanged regression tests        |
| Overlapping local lifecycle controllers and drivers                                                                            | Share demonstrated common lifetime machinery; retain genuinely different Action/Processor settlement contracts | Same private authority and quiescence guarantees, including retry generations, held replies, stale callbacks and capacity            |
| Temporary compatibility wrappers, branch-specific option types and obsolete exports                                            | Remove after the last supported caller moves                                                                   | Caller/import inventory, package reachability and public API/build tests show no dependency                                          |
| Repeated test provisioning and fixture scaffolding                                                                             | Shared setup helpers where isolation and fault injection remain explicit                                       | Retain test cases, failure assertions, exact backend coverage and cleanup checks; measure runtime impact                             |

The first three rows are replacement candidates, not a declaration that every
file in those directories is obsolete. Shared EventStore, Collection, registry,
content and authoring facilities may remain necessary. Audit concrete functions
and callers before deleting whole modules. Standalone public APIs require an
explicit compatibility treatment rather than accidental removal.

## 18 October review: prioritize migration over more isolated components

The latest eight content/catalog source checkpoints, through the accepted
reservation/confirmation tree `1b96e87f9338a9a71601ca4a12d5159254c0540c`, add
2,926 production lines and remove 326 (excluding one configuration line): 2,527
added lines are in ten new production files; nineteen existing production files
change by +399/-326. Tests change by +3,529/-19, mostly nine new test files
(+3,345). These counts describe the scoped checkpoints, not the full PR.

Most of this is replacement owner infrastructure. The frequently reported legacy
checks predominantly execute existing tests unchanged: progressive/body-store,
catalog/query/selection, GCS and application compatibility tests are examples.
The old-path edits mainly enforce format/namespace isolation so an old
entrypoint cannot mutate a new owner's storage while both remain reachable. They
are not a reason to retain the old execution architecture permanently.

The real risk is integration lag. `owner-host.ts` still constructs the full old
catalog, and the public factory still has embedded/gateway/worker branches
beside its owner-backed branch. Eight private modules remain outside genuine
host reachability after the reservation checkpoint. Additional isolated
capabilities must not become the default way to progress this refactor.

The immediate sequencing rule is therefore:

1. Finish and record the scoped append/checkpoint validation (now passed)
2. Retire the audited dormant reconciliation classifier after moving its
   remaining counterexamples into actual startup tests; retain its used alarm
   encoder/type
3. Move a real owner-host caller onto the narrow replacement and remove its old
   catalog/recovery dependency, with actual Action/Processor execution tests
4. Implement the remaining content lifetime behavior together with its real
   local/worker callers and settlement/alarm integration, rather than
   accumulating another independent subsystem
5. Move the public/default facade and remaining consumers; delete their
   superseded composition, lease-based stream writer and automatic
   promotion/maintenance paths
6. Remove temporary old-entrypoint guards only when the entrypoints they protect
   are actually retired; preserve new-format refusal and migration safety

No interim legacy-support release is assumed. A change to a retiring path needs
an explicit surviving invariant, shared consumer or migration blocker. Preserve
behavioral counterexamples by exercising the replacement, not by requiring the
retiring implementation to remain indefinitely. No broad legacy deletion is safe
merely because the owner path does not call a module: public embedded, engine
and standalone exports still do. The next migration must name and move those
callers.

### Retired dormant reconciliation classifier

`createOwnerReconciliation`, its inventory/classify command kinds, cursor/page/
classification types and key helper have no production registration or public
barrel export. Only their own test fixture calls them. Production startup and
lost-Action recovery import the target union and exact durable alarm encoder
from that file; those must remain unchanged.

The existing exhaustive startup proof/repair replaces the unused paginated
classifier's role. Its remaining counterexamples now run through actual startup:
succeeded status without canonical lifecycle, dangling open_actions owner
delivery, a leased Processor and aggregate added-alarm capacity refusal. Private
pagination and classifier-receipt semantics retire with the unused factory.

### Dormant classifier removal: scoped acceptance

The accepted change removes a net 604 production lines while preserving the
original target union and byte-identical alarm encoder. The old factory-only
suite is replaced by one alarm identity test; three previously unmatched
negatives now execute through actual startup proof/repair, and a fourth case
verifies added-alarm pre-write capacity refusal with unchanged durable alarms
and receipts.

Behavioral mapping for the retired fixture:

- Never-started, current/future and ordinary pending reservations: existing
  startup reservation and alarm-repair tests
- Claimed Action/effects and lost work: existing startup blockers and actual
  lost-Action recovery tests
- Canonical terminal versus delivery status alone: existing canonical-history
  test plus the new terminal-without-history startup counterexample
- Orphan assignments, missing source and dangling open Action: existing startup
  source/graph checks plus the new independently discovered dangling-action case
- Leased prior Processor: new startup case proves no delivery mutation, attempt
  reset, assignment retirement, delivery wake or readiness
- Atomic repair, unknown COMMIT, changed authority and current-state reproof:
  existing startup transaction tests and tagged lost-Action control tests
- Alarm growth: new one-existing-alarm/maxItems-one case reaches final capacity
  refusal after inventory succeeds and leaves no repair receipt
- Local-placement retained history: existing owner-host local recovery refusal
- Pagination cursors, classifier dispositions/receipts and its separate
  maxAlarms option: intentionally retired with the unused private API

No replacement retry/classifier service or new configuration option is added.
Independent scoped validation passes 51 tests on PostgreSQL and 51 on PGlite.
Removing only standalone open_actions discovery in evidence copies fails the new
exact-reason assertion on both backends, proving the moved counterexample
exercises that path. All 102 owned databases were exported/dropped; PostgreSQL
stopped with no sessions or leftovers, and source/dependency hashes match. The
same eight-module package reachability blocker remains. The separate host
catalog migration has not started in this checkpoint.

## Required evidence for each cleanup checkpoint

1. Name the duplicated or superseded responsibility and its surviving owner
2. Identify remaining production callers and the blocker for each migration
3. Move callers and tests to the replacement without weakening assertions
4. Remove the old implementation and unused options/exports in the same bounded
   checkpoint where feasible; otherwise record the exact follow-on deletion
5. Run affected runtime/package checks and review the change's source delta
6. Re-run the coherent full gate before release; production data migration,
   Compass cutover and package publication remain separately authorized

Do not turn every duplicated branch into a generic framework. Shared helpers
should have a narrow purpose, real production consumers and observable
simplification. Keep placement-specific ownership, retry and settlement rules
explicit where their contracts differ.

## Current concrete cleanup

The local Action and Processor ports independently implemented the same bounded
raw-call queue, unknown-error classification and receipt-hook drain accounting.
The consolidation replaces both copies with one internal helper. It does not
merge their start/settlement protocols or authorize retries. Existing behavioral
regressions remain in both adapters. Independent checked port/driver/controller
tests pass 144 cases; actual boundary/Processor compatibility passes 44 cases
with one explicit PostgreSQL-only skip in that run. Both old copies are removed;
the three production files have a net reduction of 46 lines. This narrow cleanup
does not close the broader legacy-retirement gates.

The broader legacy migration remains blocked by the public/API and capability
parity items in the [implementation checklist](implementation-status.md). Those
items must lead to retirement of the superseded paths, not merely add a second
implementation beside them.
