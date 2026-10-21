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

## Round 2: ordered windows, session outcomes and portable hosting

Current merged code: owner admission (`runtime/subscriptions/owner.ts:255`) only
allows ID ordering, and SDK delta application (`client/live-query.ts:174`) sorts
IDs. SQL ordering (`runtime/collections/query.ts:42`) derives typed fields from
the Collection schema. Physical timestamp columns can retain microseconds, so
live ordering must use SQL-produced keys instead of parsing public row dates.
The projection statement (`runtime/collections/reducer.ts:545`) already writes
those columns in the same statement. Device hosting currently relies on a
private Request WeakMap (`runtime/subscriptions/hosting.ts:14`), which CLI
workers cannot populate. Authorization observes individual channels, but device
authentication has no session-wide observer (`server/facade.ts:673`). Operation
observation (`server/operations.ts:289`) does not use the completed logout
receipt exception.

Target:

- Admit schema-declared scalar ordering and physical createdAt/updatedAt,
  ascending/descending, with ID in the same direction. Match PostgreSQL null
  placement; text ordering is explicit C/code point. Initial bounded cache reads
  physical timestamp keys. Existing projection statements return exact timestamp
  keys into owner push without another SQL round trip. Each state
  removes/reinserts only the changed ID in its sorted members; refill uses the
  bounded cache, with no database read or full predicate rescan on commit.
  Ordered batches carry the selected IDs so SDKs preserve the owner's exact
  order without reinterpreting timestamp precision or schema types.
- Authorize only the completed self-revocation operation using the initiator's
  credential-proof digest and durable clear effect. No permission for another
  operation, mutation, record discovery, or active observation follows from that
  receipt. Recheck this receipt after an admission refusal to cover revocation
  committing between lookup and admission; preserve result policy on retry.
  Preserve ordinary operation policy for all other paths.
- Retain a socket-level authority observer, release it on
  close/reauthentication, and close revoked sessions with a terminal session
  notice and code 4401. Expose a small device auth-event subscription in
  client/, without changing client/web.
- Stable, safe subscription refusal reasons and debug diagnostics contain only
  collection, principal kind and reason; never query values or credential data.
- HTTP authorization refusal maps absent credentials to 401, supplied-but-denied
  credentials to 403, including Core HTTP routes through the shared facade.
- Default to Oxian 0.23.0 upgradeWebSocket. Delete the private request registry
  and adapter bridge; Oxian owns listener socket tracking/drain. Retain explicit
  upgradeDevice for raw Fetch hosts/tests that do not install Oxian hosting.
  Origin admission remains before any upgrade. Local deno.json links are only a
  development override, to be stripped before commit/release.

Verification: live windows equal list() after inserts, ties, ordering updates,
deletes and refill on both backends, including message where threadId, createdAt
desc, limit 100. Two real tabs prove logout result recovery, peer socket closure
and client auth event; negative proofs/other operations remain refused. Test
safe refusal diagnostics and HTTP 401/403. Run an actual Oxian CLI start fixture
with both worker transports, checking snapshot/101 and foreign-Origin refusal.
Run focused tests and both full backend suites, check/fmt/lint delta/type guard.

Risks: ordered ID arrays still move bounded entries but never scan predicates
across unchanged rows. New batch ordering is a protocol addition for updated
clients. Oxian must release 0.23.0 before Copilotz. Deno's native WebSocket
assembles messages before delivery, so only Node can bound pre-delivery
reassembly; both retain device post-delivery limits.
