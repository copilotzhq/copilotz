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
