# Storage identity and review findings

## Current state

- `runtime/events/schema.ts:466` makes node IDs schema-global; edges reference
  that single column. ID text currently inherits the database collation.
- `runtime/authorization/credentials-upgrade.ts:12` owns the drained, atomic v13
  → v14 transition and advances the owner epoch once.
- `runtime/collections/reducer.ts:474` joins asset nodes by ID; upgrade history
  also joins nodes without namespace (`runtime/actions/upgrade-history.ts:17`).
- `runtime/engine/database-scope.ts:439` admits Actions by composition alias;
  `runtime/actions/authorized-capture.ts:217` also accepts a stable-ID policy.
  `plugins/server/authoring/route-compiler/index.ts:115` exposes stable IDs.
- `runtime/application/ingress/authority.ts:111` attributes ingress to the
  principal, including session principals, instead of the authenticated actor.
- `server/actions.ts:3` imports Core metadata; `server/operations.ts` embeds
  thread selection. `server/facade.ts:252` polls operation results.

## Target and public API

The single unreleased v14 uses `(namespace, id)` node identity and composite
edge foreign keys with cascading deletion. Every physical text ID column uses
`COLLATE "C"`. Existing values remain unchanged. Collection name is not part of
the key: duplicate IDs within a namespace return a generic typed conflict. Fresh
provisioning and offline upgrade converge on the same catalog. The upgrade
remains transactional, drained, epoch-fenced and idempotent.

Generated IDs use the standard library's process-local monotonic ULID generator.
All app-facing Action configuration uses composition aliases, including policy,
exposure, routes, tool bindings and handler invocation. Stable IDs remain the
internal durable identity and lifecycle event names.

Session identity and principal are distinct and checked against the stored
session binding. Ingress retains actor attribution separately from principal.
Policy refusal of a tool Action produces a failed tool result and lifecycle
failure without failing its agent. Generic HTTP uses an extension seam for Core
observation selection and metadata. Handler invocation observes operation
completion. Request cancellation uses the supported serving API.

## Deletions

Remove stable-ID configuration fallbacks, redundant session equality rules, Core
imports from generic server code, and the 25 ms invocation polling loop. No
compatibility mode, new schema version, or alternate runtime is introduced.

## Guarantees and validation

Targeted tests cover namespace collisions, generic conflicts, namespace-safe
relations/assets/vectors/replay, bytewise identity, monotonic IDs, upgrade
catalog parity/data/edges/rollback/replay, alias consistency, session binding,
actor attribution, refused tools, generic HTTP and observed invocation. Run
check, formatting, lint delta and the full test type guard. Run the full suite
once on PGlite, then once on Postgres port 55435 with the timeout wrapper.

## Benchmark

A standalone Postgres script compares ULID `TEXT COLLATE "C"` and native UUID
keys at 1M rows (10M when reasonable): insert throughput, point lookups, ordered
range scans and index bytes. It records workload/methodology and results here;
this measurement does not change public IDs or storage column types.

## Risks

Changing collations rewrites indexes and requires the existing offline drain.
Schema-global scans must paginate by namespace plus ID. Content bodies are
schema-global and their reachability scans must continue seeing all namespaces.
Historical event IDs and operation IDs retain their existing uniqueness rules.
Benchmark results depend on local hardware, cache state and concurrent load.

## Measured results (2026-10-20)

PostgreSQL 18.3, local Apple arm64, `shared_buffers=128MB`,
`synchronous_commit=on`, database collation `C.UTF-8`, port 55435. One
connection, no concurrent benchmark queries. Other overnight work shared the
machine.

The script stages equivalent ordered 128-bit identities before timing. The ULID
has a fixed timestamp and increasing 80-bit suffix; UUID stores the same bits.
This isolates key representation, not UUIDv4 randomness or UUIDv7 generation.
Tables have a primary key and a 64-byte text payload. Timed insertion is one
logged `INSERT SELECT` ordered by sequence. Each table is analyzed, then
receives 100 point warmups, 1,000 seeded uniform point probes and 100 ordered
1,000-row range scans. Read times include the client round trip and returned
rows. Indexes are measured with `pg_indexes_size`. Caches are not flushed. The
1M run inserts text first; the 10M run inserts UUID first. Production namespace
prefixes are not included in these single-key measurements.

|       Rows | Key         | Insert rows/s | Insert seconds | Point mean / p95 ms | Range mean / p95 ms | Index MiB |
| ---------: | :---------- | ------------: | -------------: | ------------------: | ------------------: | --------: |
|  1,000,000 | ULID text C |        73,565 |          13.59 |       0.479 / 0.781 |       3.867 / 5.320 |     47.44 |
|  1,000,000 | UUID        |       226,096 |           4.42 |       0.201 / 0.281 |       1.764 / 2.569 |     30.10 |
| 10,000,000 | UUID        |        74,087 |         134.98 |      4.356 / 11.809 |      8.041 / 17.089 |    300.82 |
| 10,000,000 | ULID text C |        61,306 |         163.12 |      5.182 / 17.787 |     13.463 / 30.579 |    474.30 |

The text primary index is approximately 58% larger at both scales. UUID had
higher insertion throughput and lower mean read latency in these runs, but
latency is load/cache-sensitive (10M text point p50 was 2.73 ms versus UUID 3.19
ms). Treat the size result as stronger evidence than the timing ratios. The
first 10M attempt hit the driver's default statement deadline during staging;
the successful run used the script's 300-second request limit. Both 10M timed
insertions finished within that limit. Each run removed its private benchmark
schema, including on failure. No runtime ID type changed.

Reproduce with
`COPILOTZ_TEST_POSTGRES_URL=postgres://... deno run -A
scripts/benchmark-id-storage.ts 1000000 10000000`.
Raw results are retained in `plan/par/FIND.benchmark-1m.log` and
`FIND.benchmark-10m.log`.

## Audit conclusions

Collection reads, relation reads, vector reads and owner receipt identities
already include namespace; the missing asset manifest/protected-value lookups,
upgrade graph joins, offline cleanup and alarm pagination now do too. Physical
body identities and their cross-namespace reachability scans intentionally
remain schema-global. Owner bundles preserve namespace/id pairs and composite
foreign keys; tests import duplicate IDs in distinct namespaces.

Session principal/basis independence already existed in the implementation; the
contradictory documentation and equal-ID test fixtures concealed it. The
regression now uses separate account and session IDs, rejects a mismatched
principal, and checks tenant-isolated revocation. HTTP actor attribution is
passed explicitly into immutable ingress evidence.

Pre-capture refusal recovery accepts only an input-free, sanitized failed root
whose source event, delivery-derived run, namespace and correlation match the
request. It does not hydrate uncaptured protected input or grant a successful
result. Operation-read authorization still applies. Core browser and Admin
configuration use the same composition aliases as server exposure and policies.
