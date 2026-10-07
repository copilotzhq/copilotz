# Indexed Message history reads

Public Message history and private Agent preparation now use the same
thread/time/ID access path. Provision `provisionCoreHistoryIndexes` from
`@copilotz/copilotz/core` once per physical schema, after the Event schema.
Existing databases can pass `{ concurrently: true }` outside a transaction; the
operation rejects an invalid or conflicting index and runs `ANALYZE` to collect
expression statistics. Normal readers execute no provisioning SQL.

The index is `(namespace, type, (data ->> 'threadId'), created_at, id)`.
PostgreSQL can use it in either direction and preserve timestamp ties. Its
leading namespace/type keys also support parameterized queries without requiring
PostgreSQL to prove a partial index's constant Collection type. Statistics
prevent the severe thread-selectivity underestimate that caused the planner to
sort a complete history before selecting a page. Small bounded ranges may still
use a cheap bitmap scan and sort.

The private Agent window adds the indexable `where.threadId` constraint to its
existing complete predicate. Scope, audience, branch, anchor, range, and cursor
validation stay in place. Returned records and prepared transcript bytes are
unchanged. No extra history SQL statement or content read is introduced.

## Evidence and reproduction

A production read-only diagnosis on PostgreSQL 18 found a public history page
estimated at nine records but containing over 4,400 matching Messages. The
default plan scanned about 5,740 Messages and accessed over 113,000 cached
blocks. Large internal consolidation roots amplify the cost of inspecting JSON.
They are retained snapshots, not additional public history to display. The
diagnostic ordered scan returned identical IDs in 12.3 ms instead of 666.8 ms;
its planner overrides were transaction-local and rolled back.

The committed native regression exercises the actual Core named query and Agent
window loader. Its fixture has 5,740 Messages, one dominant thread, 20 small
threads, 8,000 other Collection records, timestamp ties, hidden audiences, and
roughly 130 MB of logical internal snapshot JSON. With ordinary PostgreSQL
planner settings, two local runs measured the first public page at 21–22 ms
before provisioning and 0.45–0.49 ms afterwards (about 45–48 times faster). The
optimized page used 36 cached blocks. Ascending, descending, before/after, and
small-thread pages returned exactly the same records. Agent preparation also
returned identical records and added zero SQL statements.

```sh
# Use an isolated native PostgreSQL fixture database.
COPILOTZ_TEST_POSTGRES_URL=postgres://localhost/copilotz_test \
  deno test -A plugins/core/collections/message/history.postgres.test.ts

# Visibility, revision branches, scopes, immutable preparation, and query counts.
deno test -A plugins/core/collections/message \
  plugins/core/processors/message-router/agents/prepared-transcript.test.ts
```

These are per-query execution measurements, not an observed reduction in
whole-database CPU. Production rollout must compare aligned load windows and
meet the agreed minimum 10% whole-database CPU improvement before promotion.
Installing the package alone does not create the index in existing databases.
Automatic statistics maintenance must remain enabled as histories grow.

## Existing Compass schemas

From this release's Git checkout, supply `DATABASE_URL` privately and run the
provisioning CLI against the current schema inventory. The preview validates all
selected Event schemas before an apply run can mutate any of them:

```sh
deno run -A scripts/provision-core-history.ts \
  --schema public --schema tenant_copilotz_com

# Explicit installation; old and new application readers can continue running.
deno run -A scripts/provision-core-history.ts \
  --schema public --schema tenant_copilotz_com --apply
```

Use the actual discovered schema names rather than assuming the example tenant
inventory is complete. Each schema builds independently and then collects
statistics; a multi-schema run is not atomic. A failed concurrent build can
leave an invalid index. Inspect and remove that failed index before retrying.
Completed schemas are safe to provision again. An index installation alone can
improve existing public readers; the matching package release also exposes the
indexable constraint during private Agent preparation. Hosts should call the
same provisioning helper when creating new Core tenant schemas.
