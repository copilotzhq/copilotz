# Owner-driven content lifetime: next coordinated slices

Status: private memory/SQL/S3 physical prerequisites scoped-reviewed; owner
integration remains WIP, 18 October 2026. No public stream activation or
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

Private append accepts nonempty chunks up to 1 MiB. Private range reads now
share a 1 MiB per-call bound across memory, SQL and S3; callers page larger
reads. The future producer must normalize empty writes before allocating append
IDs; this does not change legacy empty-append behavior. Memory ordering tests
cover delayed calls, not backend in-flight CAS. Subsequent SQL and object-store
checkpoints are described below; owner catalog commands/alarms and actual
execution routing remain required.

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

A separate provider-only control reproduced late uncaught error text without
this adapter. Bare Deno exited successfully after cleanup and its exception
monitor did not fire, so host termination was not demonstrated. Source review
identified missing ownership of native PostgreSQL client/pool error events.

That correction is now independently accepted in
[Ominipg PR4](https://github.com/AxionCompany/ominipg/pull/4), source
`6ac94e8a1cffa65f09f8c90b6eeced28e76b9eb7`, with published pins unchanged. The
same ten physical COMMIT-loss outcomes pass with zero uncaught output; the
provider-only control reports exactly one public diagnostic while preserving API
rejection and actual server COMMIT. Broader scoped gates pass 145 pure/PGlite
and 164 actual-PG Ominipg cases, four real sync cases/twelve steps and five
observer/sync probes. Full Ominipg static semantics and frozen hashes pass. All
73 fixture databases plus coordinator and four fixture replication slots were
exported/recorded and removed; sessions and leftovers were absent and the server
stopped. Verify run39104252261 passed all five jobs. This is not a full Copilotz
integration, package publication or public activation claim.

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

## Reserved object namespace prerequisite

Legacy S3 and GCS-compatible body stores now refuse the reserved
`__copilotz_owner_physical_v1__` path segment at their final raw-request
boundary. All three listing consumers exclude it before classification or
cleanup, including nested orphans without metadata. Native GCS checks its joined
prefix/body key before token lookup or network access. Path aliases and corrupt
legacy metadata cannot reference owner physical parts through legacy APIs.

Shared S3 transport mechanics are extracted without changing their existing
request semantics. No physical writer, lease policy or catalog is introduced by
this prerequisite. Native GCS progressive support remains unavailable.

Independent checked evidence: 81 repository cases and seven adversarial probes
pass, with no failures/skips; three expected baseline failures are retained.
Six-file lint/format and frozen source/dependency hashes pass. These tests use
local mock object services and do not establish live-provider CAS behavior or
full-suite acceptance.

## Private S3 writer and bounded reads checkpoint

The private S3 adapter uses the reserved owner namespace, a stable
caller-supplied scope and hashes of unambiguous scope/body identities. Stored
metadata verifies the complete scope and original writer identity; the hash
alone is not treated as authority. This format does not reuse legacy `prefix` or
`protectionMs`. Changing scope selects another namespace; owner epochs must not
change it.

One conditional JSON manifest references immutable create-only parts whose keys
are derived internally. HEAD followed by If-Match GET binds metadata to its
actual version. Appends compare original offset, append ID and exact owned
bytes; fencing retains the original generation and bytes, exposing the next
generation only in the fenced head. Absent-key fences create tombstones. Losing
operations never delete speculative parts, because an identical concurrent retry
may have accepted them. No lease, renewal timer, adoption, retirement or second
catalog is added.

Bounds are explicit private limits, not established public production defaults:

- Each append and each range read is at most 1 MiB. The read limit is shared by
  memory, SQL and S3 and checked before I/O; callers page larger ranges
- New manifest growth defaults to 1 MiB and 4,096 parts. Configurable private
  growth caps cannot exceed the fixed 4 MiB / 8,192-part decoding ceiling
- Serialized UTF-8 metadata is counted before part upload, including escaped
  identifiers. Open records retain the two bytes needed to encode `fenced`
- Lower growth caps on reopen do not prevent exact replay, reads or fencing
- Reads verify each selected immutable part's full length and digest. They may
  fetch a whole part to return a smaller range; empty ranges require no part GET

The new request path pins `aws4fetch` 1.0.20 and uses only its supported
`sign()` API. Actual payload SHA-256, conditional headers and the session token
are signed. Native fetch owns the request and every response body; redirects are
refused, all-status bodies are bounded, cancellation is awaited, and there are
no application-level automatic mutation retries. Conditional guards must remain
safe if the underlying HTTP stack retries an identical request. There are no
presigned bearer URLs, credential logs, private dependency imports or copied
signing implementation. Existing legacy S3-lite consumers remain unchanged.
Explicit GCS mode refuses progressive composition; native GCS remains an
immutable tier.

The deadline applies to each HTTP request, including body consumption. It is not
a deadline for a multi-request physical operation. Abort, rejection or an HTTP
error after dispatch does not prove rollback: exact reserve/append/fence retries
reconcile the retained state. Current loopback tests distinguish a committed
mutation followed by HTTP503 from a pre-commit HTTP503; neither is presented as
a dropped socket.

Independent final evidence passes 86 combined private cases, 92 legacy object
compatibility cases, 115 actual PostgreSQL cases and 107 PGlite cases with eight
explicit PostgreSQL skips. Normal typechecking, changed-file lint/format,
forbidden-API/generated/core-ownership checks and source/dependency hashes pass.
All 56 fixture databases plus the coordinator were exported/dropped; sessions
and leftovers were absent and PostgreSQL stopped.

The unchanged full-static task stops at its package-surface check: private
memory/database/S3 factories and the S3 manifest/request modules are not yet
reachable through real public host composition. This remains an open integration
gate. They were not exported or allowlisted merely to bypass it; no full static
or full-suite acceptance is claimed.

Earlier Buffer input/subview and response-chunk ownership failures are retained.
Both boundaries now copy into plain Uint8Arrays. Private PUTs require exactly
one create-only or strong-version condition before dispatch. Fixed AWS signing
vectors, independent condition/body/token verification and native redirect/abort
checks pass.

Real TCP tests distinguish eight zero-response closures from eight truncated
response bodies. A zero-response closure causes two identical wire PUTs from one
application fetch call in this runtime: pre-commit retry returns 200,
post-commit retry returns 412 and the adapter reconciles the exact retained
state. Body, authorization and condition equality are checked. Truncated
responses produce one wire PUT and an unavailable outcome, with correct
pre/post-commit retry state. Fencing between native retry attempts defeats stale
writes. Original incorrect test expectations that every zero-response close must
reject the API remain recorded rather than being relabeled as lost-ack failures.

Remaining activation gates include real endpoint conditional-write conformance,
owner execution integration and workload measurements. Rewriting and reading a
bounded manifest still costs O(number of parts); it must be measured with actual
producer batching before choosing public defaults. No public stream admission or
live-provider performance claim follows from these private checks.

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
