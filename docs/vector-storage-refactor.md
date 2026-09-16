# Vector storage addition to the authoring refactor

## Agreed outcome and proposed design

The user requested adding a fix for JSON-stored Memory embeddings to this
refactor on 2026-09-15. The outcome is in scope; the following storage layout is
the recommended design, not implemented functionality.

Current Memory persists vectors inside Collection record JSON and ranks a
bounded candidate scan in application code. Public searchMemory uses lexical
scoring. Knowledge also loads vectors and computes similarity in application
code; it is a potential consumer of the same capability, not a reason to put
Memory or Knowledge semantics into runtime.

## Storage recommendation

Assets are nodes with a generic body-storage mechanism, not a separate physical
Assets table. Retain Asset ownership/content provenance where appropriate, but
keep the searchable vector in a small optional relational projection with a real
pgvector column. A record may have several embeddings (different fields, chunks,
model revisions); an Asset may be shared without sharing access rights. Do not
force every memory summary into an Asset just to hold a vector.

A minimal entry identifies tenant namespace, owning Collection/record, indexed
field or chunk, embedding profile, source revision/digest, and the vector. An
Asset reference is optional. The embedding profile identifies the model,
revision, dimensions and distance metric; identical dimensions alone do not make
two vector spaces compatible. Index layout must follow the configured
profile/dimensions and the supported extension's actual limits.

Memory owns what text to embed, generation through context adapters, eligible
records and access rules. An optional generic persistence capability owns SQL
storage/upsert/delete and nearest-neighbor queries. The base runtime remains
usable without the vector extension. Keep the API small and use existing
transaction/persistence seams instead of plugin factories or a second lifecycle
framework. Exact public API names remain to be finalized.

## Search and correctness

- Use database-side exact distance search first; remove the arbitrary 1,000-row
  preselection from Memory's semantic path. Return IDs and scores, then hydrate
  only selected records.
- Include current namespace, permitted Memory spaces, record validity/status,
  and domain filters in the SQL result selection before the result limit. Keep
  authorization tied to the owner, not to a shared Asset or content hash.
- Preserve access revocation and verify authorization again before returning
  protected content where the existing read boundary requires it.
- Use both consolidation matching and public searchMemory as integration paths.
  Preserve explicit lexical behavior when embedding is not configured. If
  semantic search is configured but vector storage is unavailable, report the
  configuration error rather than silently scanning JSON.
- Add approximate indexing only with measurements and filtered-recall tests.
  pgvector approximate index scans can filter after scanning and return fewer
  matches; SQL authorization filtering remains mandatory and index tuning is not
  a replacement for it.
- Keep record and projection changes consistent across transaction failure,
  retries, edits, deletes and archive/access changes. Specify a durable rebuild
  source or re-embedding procedure; vectors must not depend on an unrecoverable
  process-local write.

## Fresh-data implementation and evidence

User decision, 2026-09-15: no data migration, backfill, compatibility readers,
dual writes, or legacy format support. Compass is the only Memory consumer and
is internally used. The new milestone targets clean schemas and fresh Memory
data. This planning decision does not authorize deleting any existing database.

1. Verify PostgreSQL and bundled PGlite vector loading/type/index capabilities.
2. Add optional provisioning and a small generic vector persistence contract.
3. Integrate Memory writes, consolidation candidates and public semantic search.
4. Remove embedding arrays from Memory record schemas and the unused physical
   nodes.embedding column in the new schema. Add no old-format fallback.
5. Verify tenant/space access and revocation, more than 1,000 candidates,
   profile/dimension mismatch, revisions, deletes, retries and current-format
   restart/rebuild. Measure ranking correctness, transfer and query performance.
6. Document fresh setup and the breaking change. Application reset/deployment is
   separate work; do not build migration machinery for the few existing users.

Reference: https://github.com/pgvector/pgvector (exact search, filtered
approximate indexes, supported vector/index dimensions). Ominipg supports
loading vector for PGlite, but current Memory does not issue vector SQL.
