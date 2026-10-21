# SEC3 device, subscription and shard hardening

## Current behavior

- `server/facade.ts:614` upgrades `/device` without checking Origin and retains
  cookie headers; `server/device.ts:353` queues controls during authentication.
- `runtime/subscriptions/owner.ts:109` filters and sorts the entire cache on
  commits (`:518`), including detached states; admission counts detached states.
- `runtime/collections/predicate.ts:97` uses JavaScript string comparison while
  SQL uses database collation. Case folding is also platform dependent.
- `server/authentication.ts:171` accepts the first session cookie.
- `runtime/application/shard-controller.ts:58` reads before authorization.
- `runtime/application/shard.ts:190` indexes sessions by unqualified worker ID;
  `shard-relay.ts:243` forwards sessions of every principal kind.

## Target and public API

Device/server `allowedOrigins` accepts canonical HTTP(S) origins only. A
supplied Origin must equal the request URL's origin or an explicit allowed
origin. Reject before upgrade. Missing Origin is permitted for non-browser
clients, but all cookie authority is disabled: remove the upgrade Cookie header
and reject cookie credentials. Explicit nonempty header credentials are required
in hello. A matching Origin allows cookie credentials. Host authentication must
derive socket authority exclusively from the supplied request, never ambient
cookies.

Device limits include configurable active subscriptions (default 16), queued
control count and bytes. Only one hello is accepted before authentication.

Observer limits include active states overall/per principal, detached states per
principal, predicate nodes, predicate list values, query bytes, caches, cache
rows and cache bytes. Live predicates reject jsonEquals and locale-dependent
case folding; string ranges use explicit C SQL collation and code-point JS
ordering. Unsupported/expensive predicates report subscription_query_refused;
admission quotas report subscription_capacity_exceeded. All numeric limits are
validated.

Maintain sorted matching IDs per state. Compile query and policy predicates once
at admission, including constant scalar/JSON encodings. On a collection change,
evaluate only its old/new row; insert/remove one matching ID using binary
search, then project the bounded selected window. No
subscriptions-times-cache-row scan on commit. Initial admission may scan the
bounded cache once. Detached states retain resume history but are evicted
oldest-first under capacity pressure and have per-principal bounds. Attached
readers alone consume active admission.

Internal cache sequence still follows every owner push for gap detection. Public
progress uses namespace-local counts of append-only durable events. Invisible
Collection mutations and other namespaces emit no frame. Row subscriptions
retain namespace-local non-Collection progress for Action settlement;
progress-only subscriptions emit only policy-visible Collection invalidations.
Action result sequences use the same namespace-local event count.
Snapshot/window/delta ordering, authority gates, checkpoint identity, replay and
refill remain intact.

Default Action cookie is __Host-copilotz_session; validate Secure, Path=/ and no
Domain for any __Host- name, reject duplicate configured cookies.

Shard controller gains required header authentication before bounded reading,
retaining input authorization after parsing. Shard session keys include
principal kind; only worker sessions reach owner authority. Credential HMAC uses
HKDF with a credential-specific label; shipped protected-value commitment keys
are unchanged.

## Deletions and guarantees

Delete full-cache commit selection, implicit cookie socket authority without a
matching Origin, first-cookie-wins parsing, and unqualified cross-kind session
replacement. No compatibility mode or feature flag.

## Verification

Run copied review probes before/after and remove copies. Add bounded real
observer and real facade/socket regressions for origin, quotas, predicate cost,
detach capacity, invisible writes, Unicode SQL parity, cookie ambiguity,
buffering, shard body admission, principal isolation and HMAC separation. Cover
PGlite/Postgres and Node/Deno device transport. Run check, fmt, lint, type guard
and full suites once per backend with the night timeout wrapper. Record failures
and probe numbers in plan/par/SEC3.result.md.

## Risks

Ordered arrays require O(matches) element moves but never predicate evaluation
across unchanged rows. Cache and admission bounds limit memory. Public progress
is namespace-local, rather than schema-wide. Cookie defaults and shard
controller authentication are intentional new-version API changes.

## Implementation refinements

The existing event log is append-only; counting namespace events at initial
cache admission and in the existing Action result-sequence query establishes
matching local coordinates without schema changes or new per-command round
trips. Commits increment the cache-local counter only for namespace events.
`query.ts` explicitly collates ID ordering and ID cursors as C, alongside scalar
range compilation; FIND's column collation remains independently useful for
index access.

`collectionChange.previous` carries the already-planned old record (one line in
kernel). Progress-only caches still perform no row scan. The reserved
`shard:<kind>:<id>` wire namespace separates non-worker kinds; workers retain
owner-issued IDs and cannot use that reserved prefix.
`createShardWorker({kind})` qualifies non-worker activation IDs; logical
dispatch targets are qualified in the shard. Admission binds the namespace to
the authenticated principal kind, and the relay filters both sending and
receiving.
