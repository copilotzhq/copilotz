# Owner-controlled attempts without per-job leases

Approved by the user on 17 October 2026. This decision supersedes the recovered
F5 §4.2 and REGISTER §2 requirement that worker execution retain a delivery
lease and renewal heartbeat. It applies to the Copilotz owner-managed path,
including both local and worker Actions and Processors. It does not assert that
the code migration is complete.

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
