# Owner-driven content lifetime: next coordinated slices

Status: private contract/memory prerequisite implemented and scoped-reviewed;
owner integration remains WIP, 18 October 2026. No public stream activation or
production migration is implied.

## Approved contract and recovered-spec discrepancy

The approved [owner-attempt contract](owner-attempt-authority.md) supersedes
worker-job-heartbeat renewal for content. One bounded owner alarm protects quiet
writers in both placements. Each renewal proves the exact catalog-bound current
attempt; worker writers also require their current authenticated Started
session. Append activity does not renew protection. Revocation is ordered as
`revoking` → physical fence → `revoked`; reassignment requires confirmed
revocation.

The restored foundation files predated that approved amendment. This checkpoint
reconciles the restored F5/F9 and conformance text, REGISTER, F4 delegation, F2
fencing, F7 deadlines and OWNER-DESIGN identities with the committed contract.
The [portable reconciliation patch](recovered-owner-attempt-amendment.patch)
preserves the exact changes. Recovered originals and their hash manifest remain
under
`foundations/history/archive/pre-recovery-owner-attempt-reconciliation-2026-10-18`.
PHASE3 allocations remain historical. This restores an approved decision; it
does not reopen it or change connection-liveness semantics.

## Private physical contract checkpoint

The private contract and memory implementation now use exact create-only
reservation identities, fixed `owner-physical-v1` records, no lease/protection
or maintenance API, readable generation fences, and missing-key tombstones that
refuse delayed reserve. Fencing does not compact, adopt or remove bytes. A
fenced copy never yields a successor writer. The existing chunk-slicing helper
is shared without changing its legacy behavior.

Private append accepts nonempty chunks up to 1 MiB. The future producer must
normalize empty writes before allocating append IDs; this does not change legacy
empty-append behavior. Memory ordering tests cover delayed calls, not backend
in-flight CAS. Database/S3 implementations, format isolation, owner catalog
commands/alarms and actual execution routing are still required.

Independent scoped evidence: 75 complete-file private/legacy cases and 6 scratch
adversarial probes pass with normal typechecking; five-file lint/format and
exact hash checks pass. Initial typecheck/lint setup corrections are retained.
No full static/integration pass is claimed for the new private modules before
genuine host wiring. They are not exported through the public content entry
point.

## Private physical schema and legacy isolation checkpoint

The standalone SQL physical schema now provisions only into an empty relation
namespace and reopens only its exact retained format, without ALTER or repair.
Core, catalog and physical provisioning share the existing schema admission
lock. Legacy engine startup, additional scopes, maintenance and direct BodyStore
operations refuse the owner physical format; a provisioned hint cannot bypass
that check or cache absent tables.

Final independent scoped evidence: 93 PostgreSQL compatibility cases and 85
PGlite cases pass; six PostgreSQL adversarial groups and four applicable PGlite
groups pass. Eight optional PostgreSQL cases and two pooled concurrency groups
are explicitly skipped on PGlite and covered by PostgreSQL. Tests establish
held-preflight/lock races, read-only refusal, all legacy mutators, and retained
layout checks including identity/generated columns, unlogged tables and domains.
Initial fixture failures and the causal identity-layout defect remain recorded.
Normal typechecking, eight-file lint/format and source hashes pass. All 63
fixture databases and their coordinator were exported/dropped; sessions and
leftovers were absent and PostgreSQL stopped.

This establishes storage-format isolation only. The database writer adapter has
separate scoped results below. S3, catalog-bound authority, owner renewal and
execution routing remain pending; neither public content admission nor a
production migration is enabled.

## Private database writer checkpoint

The private database adapter now uses real transactions for create-only reserve,
offset/byte-bound append replay and readable, idempotent fencing, including
absent-key tombstones. It retains the original reservation generation and
exposes its successor only in a fenced head. It never renews, reassigns, adopts
or deletes a tentative tail. Indexed range selection proves contiguous coverage
from metadata before transferring payload bytes; malformed coverage returns no
payload and refuses the read.

Independent scoped gates pass 113 PostgreSQL and 105 PGlite compatibility cases,
14 PostgreSQL adversarial cases and three applicable PGlite cases. Eight
PostgreSQL-only compatibility cases remain explicit PGlite skips. The PostgreSQL
gate covers held row/unique-insert race orders and ten real COMMIT-loss
outcomes, including a successor fence waiting for an unresolved append
transaction. Normal typecheck, lint/format, hashes and disposable database
cleanup pass.

A separate provider-only control reproduces late uncaught error text without
this adapter. Bare Deno exits successfully after cleanup and its exception
monitor does not fire, so host termination is not demonstrated. Source review
identifies missing ownership of native PostgreSQL client/pool error events. That
Ominipg correction remains a blocker to end-to-end fault containment; the
physical transaction results are not a blanket clean integration claim.

## Legacy object-store append race correction

While preparing the S3 physical path, a response-held test reproduced an
existing same-writer retry race in both S3 and GCS-compatible modes. A losing
append read stale metadata, then deleted an immutable part that an identical
retry had just committed. The resulting accepted body was unreadable.

Cleanup now requires observed metadata from a different reservation/generation
and an explicit absence of that key from its accepted parts. Same-writer or
missing metadata retains the speculative part. The existing different-writer
takeover cleanup assertion remains unchanged. This is a narrow legacy safety
correction, not owner S3 adapter activation.

Independent evidence: both original causal failures reproduced; the corrected
complete S3 file passes 16 cases and related legacy content passes 61, with no
failures/skips. Lint, format and all frozen source/dependency hashes pass. Tests
use local S3/GCS-compatible mocks; no live-cloud or full-suite claim is made.

## 1. Catalog authority, physical fence and bounded renewal

Implement these together for explicit private fresh-schema host composition:

- Extend the existing OperationCatalog stream records and body references with
  exact attempt binding, writer generation, absolute protection deadline and
  revocation state
- Reuse existing owner epoch, assignment and local/worker Action/Processor
  authority resolution; owner-control authority alone is insufficient
- Add an idempotent physical generation fence to progressive-capable BodyStore
  adapters using their CAS facilities. A local in-memory flag is not a physical
  fence
- Preserve adapter capabilities: native GCS remains an immutable tier, and
  S3-mode ready-copy collection remains disabled
- Record revoking before storage fencing; confirm revoked only after the exact
  generation fence is known. Unknown fencing keeps reassignment closed
- Reuse owner_alarms with bounded batches and scheduling that prevents later
  writers starving beyond their protection deadlines
- Refuse incompatible retained formats explicitly; do not migrate production
  databases or silently reinterpret legacy writer records

Keep public stream/content admission closed until the following slices prove
accepted-prefix and completion behavior. Do not create another stream catalog,
attempt registry, generic command bus, or permanent lease-mode toggle.

## 2. Checkpoints, accepted seals and recovery

- Reuse catalog checkpoint SQL under a narrow internal owner mutation boundary
  with exact attempt/generation and expected-start checks
- Checkpoints use the committed offset as their receipt. They must add neither
  owner_receipts rows nor sequence events; read projections remain read-only
- Bound checkpoint cadence and outstanding work. Unknown checkpoint outcome
  fails the attempt without adopting a tentative physical tail
- Add catalog-authoritative seal intent/acceptance and idempotent recovery
- Preserve the catalog prefix on failure/cancellation rather than accepting the
  physical body's current length
- Followers end on catalog terminal state and enforce its terminal offset

## 3. Current copies, promotion and consumer migration

- Resolve logical body identity to its current physical copy through the catalog
- Move promotion and retirement decisions out of read/maintenance adapters into
  owner commands; verify targets before switching the current copy
- Repair followers from their last delivered offset without splicing attempts
- Migrate content ownership, retained references, default model/channel
  consumers and public composition only after their compatibility/recovery gates
  pass

## Simplification and deletion gates

The migrated owner path has no per-writer renewal timer, append-based renewal,
expiry-based writer reassignment, or physical-head-only acceptance. Reuse
OperationCatalog; retain physical content_bodies/content_body_parts as storage.

Legacy consumers currently prevent unconditional deletion: engine/context.ts,
engine/database-scope.ts, content exports/maintenance, Action content-retention
ownership, database-repository physical locations, protected values and owner
preparation-source. Identify and migrate each caller before removing its shared
behavior. Keep the existing quiet-writer guarantee until its replacement passes.
When touching the memory adapter, also prove duplicate append identity includes
its original offset, matching database/S3 behavior.

## Required evidence for slice 1

- Quiet local/worker Action and Processor writers survive multiple protection
  periods on both transports with no worker-job renewal calls
- Appends and append retries never extend protection
- Revocation during policy, COMMIT or acknowledgement suppresses stale renewal
- Reconnect, copied witnesses and takeover cannot restore an old writer
- Held/unknown fencing blocks reassignment; repeated recovery safely finishes it
- Renewal pagination does not starve later writers
- Incompatible retained schemas refuse before mutation
- Existing legacy consumers retain their guarantees until explicitly migrated

Later slices additionally require receipt-free checkpoint accounting, lost
checkpoint/seal acknowledgements, tentative-tail exclusion, catalog-only
terminal completion, current-copy repair and retention/tombstone races.
