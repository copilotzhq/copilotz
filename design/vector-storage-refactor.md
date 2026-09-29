# Optional vector persistence

## Storage and composition

[Vector storage](../runtime/vectors/index.ts) is an optional generic persistence
capability. The host calls `provisionVectorStorage(session, schema)` after base
provisioning. PostgreSQL requires pgvector; PGlite is opened with
`pgliteExtensions: ["vector"]`. Base runtime operation never requires either.

The table stores namespace, owner type/id, logical field, embedding profile,
dimensions, source field/revision, a typed `vector` column, and an optional
Asset reference. A profile identifies model, revision, dimensions and distance
metric. A record can carry independent vectors for different fields or profiles.
It does not need a fabricated Asset to hold a short summary vector.

`context.vectors.search` joins current owner records and applies the existing
bounded Collection predicate compiler before distance ordering and LIMIT. It
returns records and distances. Runtime knows no Memory space, Agent, thread,
editorial status or visibility policy. Memory supplies those predicates.

`context.transaction` includes `tx.vectors.upsert`. Vector writes enter the same
mutation plan and SQL transaction as record writes. Immutable vector Event
bodies are replay authority; the physical vector table is a projection. Owner
deletion cascades projection cleanup. Source-text revision checks exclude stale
vectors. Invalid dimensions, non-finite values and zero cosine vectors fail
explicitly.

## Memory

Memory supplies its embedder through `adapters.memoryEmbedding.default` and its
profile through `resources.memory.embeddingProfile`. Consolidation and public
`searchMemory` share SQL vector retrieval. Authorization, form, kind, status and
editorial validity filters apply before ranking. Embedding-enabled retrieval
never loads a fixed set of JSON vectors to rank in JavaScript.

Memory record JSON contains no embedding array. Without an embedder, the
existing bounded lexical mode remains explicit. A configured embedding error is
surfaced; it does not silently choose another ranking strategy.

## Validation and limits

Tests cover transactional rollback and retries, unawaited planned writes, tenant
and profile isolation, authorization-before-LIMIT, source changes, deletion and
current-format replay. Memory integration verifies consolidation, public search,
typed column storage and replay. The same generic vector contract runs against
PGlite and the PostgreSQL CI service with pgvector installed.

Search uses exact SQL distance. No approximate/HNSW index or dimension-specific
schema is created. This keeps the first implementation direct and supports mixed
profiles. Index tuning can follow measured workloads.

The local PGlite ranking fixture contains 1,202 vectors, including 1,201
authorized candidates. A limit-one search correctly returns the best authorized
record beyond position 1,000 and transfers 105 bytes of result JSON. One local
run took 184 ms for the search; this is a correctness fixture, not a production
latency benchmark. Its `EXPLAIN ANALYZE` checks the SQL limit plan. Memory's
integration test separately verifies revoked-space access through public search.

This release starts on a fresh v5 schema. No migration, backfill, compatibility
reader or dual write is included. No existing database is deleted or deployed by
this refactor.
