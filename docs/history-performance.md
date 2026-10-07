---
title: History Performance
description: Provision and verify the indexed PostgreSQL access path for Core Message history.
section: Operate
order: 70
status: stable
---

# History Performance

## The pain

On PostgreSQL, public Message history pages and private Agent preparation both
read a thread's Messages in time order. In a large shared Core schema those
reads can become slow and expensive. One production read-only diagnosis on
PostgreSQL 18 found a public history page that the planner estimated at nine
records, but it actually contained more than 4,400 matching Messages. The
default plan scanned about 5,740 Messages and accessed more than 113,000 cached
blocks before it returned a single page.

## The problem

Core stores Messages on the shared Collection node table, alongside every other
Collection type. Without a matching index and statistics for the expression
`data ->> 'threadId'`, PostgreSQL badly underestimates how selective a thread
is. It then sorts the complete history before choosing a page. Large internal
memory consolidation roots make each inspected row more expensive because their
JSON has to be read. Those roots are retained snapshots, not extra public
history to display.

Installing or upgrading the package does not create an index in an existing
database. Normal readers never run provisioning SQL, so an operator has to take
an explicit step.

## The solution

Install one chronological history index in each physical Core schema, then
collect statistics:

```text
core_message_thread_created_idx
  ON <schema>.nodes (namespace, type, (data ->> 'threadId'), created_at, id)
```

- PostgreSQL can scan this index in either direction and keep the order of
  timestamp ties through `id`.
- The index is not partial. Its leading `namespace` and `type` keys work with
  parameterized and generic prepared plans, because PostgreSQL cannot prove a
  constant `type = 'message'` predicate for those plans. The tradeoff is that
  writes to every Collection type on the shared node table maintain the index
  and pay for its storage.
- `ANALYZE` gathers the expression statistics that stop the thread-selectivity
  underestimate. Keep automatic statistics maintenance (autovacuum analyze)
  enabled as histories grow. Small bounded ranges may still use a cheap bitmap
  scan followed by a sort.
- Private Agent preparation adds the indexable `where.threadId` constraint to
  its existing complete predicate. Validation of scope, audience, branch,
  anchor, range, and cursor stays as it was. The history read path adds no SQL
  statement and no content read. Write overhead is a separate cost, covered in
  the previous point.

The index changes none of the following: stored Message content, the Event
schema version, visibility, scope, branch or cursor semantics, returned records,
and prepared transcript and prompt cacheable bytes. It is also separate from the
offline indexed-observation catalog migration, which only databases that still
have the legacy observation catalog need (see [Upgrading](./upgrading.md)).
Fresh and current schemas don't need that migration. Neither step replaces the
other.

### Operator flow for existing databases

Prerequisite: a Git checkout that matches your installed package release, with
Deno installed. The script lives in the repository at
[`scripts/provision-core-history.ts`](https://github.com/copilotzhq/copilotz/blob/main/scripts/provision-core-history.ts).
It is not a command in the installed package. Supply `DATABASE_URL` privately,
for example through your secret manager or the shell environment. Don't put it
in a committed file. The script never prints the URL or driver errors.

1. **Discover the physical schemas.** Find every schema that holds a Core Event
   schema in your deployment. The schema names below are only illustrative and
   are not a default inventory.

2. **Preview (read-only).** This is the default mode. It runs in one
   repeatable-read, read-only transaction. It validates every selected Event
   schema and reports `indexPresent` and `indexValid` (PostgreSQL's
   `indisvalid`) for each one:

   ```sh
   # Read-only preview: validate Event schemas and report index presence/validity.
   deno run -A scripts/provision-core-history.ts \
     --schema public --schema tenant_example
   ```

   The preview does not compare the full index definition. If a valid index with
   the same name but a different definition exists, the preview reports
   `indexValid: true`, and `--apply` still rejects it.

3. **Apply.** Apply validates all selected Event schemas again before the first
   mutation. Then, for each schema in sorted order, it runs
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, verifies the exact definition, and
   runs `ANALYZE`. Old and new application readers can keep running during the
   build.

   ```sh
   # Apply: build each index concurrently, verify its definition, then ANALYZE.
   deno run -A scripts/provision-core-history.ts \
     --schema public --schema tenant_example --apply
   ```

4. **Handle failures.** A run across several schemas is not atomic: earlier
   schemas stay provisioned when a later schema fails. A failed concurrent build
   can leave an invalid index behind, and an existing index with an unexpected
   definition fails verification. Nothing is repaired automatically. Inspect the
   index before you decide what to do:

   ```sql
   SELECT n.nspname AS schema, c.relname AS index, i.indisvalid,
          pg_get_indexdef(i.indexrelid) AS definition
     FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'core_message_thread_created_idx';
   ```

   Once you have confirmed that it is the failed or conflicting index, repair it
   through an operator-reviewed change that follows your database's change
   process. Then retry. Rerunning against schemas that completed successfully is
   safe.

Installing the index alone already helps existing public history readers. The
matching package release also sends the indexable constraint during private
Agent preparation.

### New schemas from a host

Hosts that create Core schemas themselves should call the public helper once per
physical schema, after the Event schema exists. This definition module performs
no top-level I/O. Your host provisioning code passes in the SQL executor and the
schema name:

```ts
// provision-core-history.ts
import { provisionCoreHistoryIndexes } from "@copilotz/copilotz/core";
import type { SqlExecutor } from "@copilotz/copilotz/events";

/**
 * Install Core's chronological history index in one physical schema.
 * Call it after that schema's Event schema has been provisioned.
 * Set concurrently only for an existing populated schema, and only when the
 * executor is outside a transaction (CREATE INDEX CONCURRENTLY requires it).
 */
export async function provisionHistoryIndex(
  executor: SqlExecutor,
  physicalSchema: string,
  concurrently = false,
): Promise<void> {
  // Validates the Event schema, creates or verifies the index, then runs ANALYZE.
  await provisionCoreHistoryIndexes(executor, physicalSchema, { concurrently });
}
```

## Reference

`provisionCoreHistoryIndexes(executor, schemaName = "public", options?)`:

| Input                  | Meaning                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executor`             | `SqlExecutor` for the target database.                                                                                                                                      |
| `schemaName`           | Validated physical schema name. Its Copilotz Event schema must already exist and validate.                                                                                  |
| `options.concurrently` | Uses `CREATE INDEX CONCURRENTLY`. Must run outside a transaction.                                                                                                           |
| Result                 | Resolves after it verifies a valid, non-unique, non-partial btree with the exact five keys and runs `ANALYZE`. Rejects an invalid index or one with a different definition. |

The helper is idempotent for a correctly provisioned schema.

### Evidence and reproduction

**Production diagnosis (read-only).** A diagnostic ordered scan returned
identical IDs in 12.3 ms instead of 666.8 ms. The planner overrides it used were
transaction-local and were rolled back.

**Committed native regression.** This test runs the actual Core named query and
the Agent window loader. Its fixture contains:

- 5,740 Messages, with one dominant thread and 20 small threads
- 8,000 other Collection records
- timestamp ties and hidden audiences
- roughly 130 MB of logical internal snapshot JSON

Under ordinary planner settings, two local runs measured the first public page
at 21–22 ms before provisioning and 0.45–0.49 ms afterwards, about 45–48 times
faster. The optimized page used 36 cached blocks. Ascending, descending,
before/after, and small-thread pages returned exactly the same records. Agent
preparation also returned identical records and added zero SQL statements.

Run these from the same release checkout:

```sh
# Use an isolated native PostgreSQL fixture database.
COPILOTZ_TEST_POSTGRES_URL=postgres://localhost/copilotz_test \
  deno test -A plugins/core/collections/message/history.postgres.test.ts

# Visibility, revision branches, scopes, immutable preparation, and query counts.
deno test -A plugins/core/collections/message \
  plugins/core/processors/message-router/agents/prepared-transcript.test.ts
```

**What the evidence does and does not show.** These numbers come from per-query
`EXPLAIN ANALYZE` execution measurements. They do not show a measured reduction
in whole-database CPU, and no production rollout result is claimed here. The
original deployment experiment set itself a target: compare aligned load-window
CPU before and after, and promote only if whole-database CPU improves by at
least 10%. That target belonged to that deployment and is not a library
guarantee. Measure your own workload the same way, and include the write and
storage overhead of the non-partial index.

## What this unlocks

Long threads in large shared schemas get bounded, index-ordered history pages
for public readers and Agent preparation. Results and transcripts stay the same,
and rollout is explicit, previewable, and safe to retry.

## Next steps

- [Events, deliveries, and recovery](./events-deliveries-recovery.md) covers
  Event schema provisioning.
- [Upgrading](./upgrading.md) covers the offline indexed-observation catalog
  migration.
- [Observation performance](./observation-performance.md) covers observation
  cost and limits.
