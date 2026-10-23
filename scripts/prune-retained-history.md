# Offline retained-history pruning

`prune-retained-history.ts` removes selected, closed event history at owner
schema **v7 or v11**. It never upgrades the schema. Other versions, including
the interrupted-upgrade marker `0`, are rejected before planning deletions.

Stop intake, schedulers, workers, maintenance, and all other writers before
apply, and keep them stopped through pruning and the upgrade. Use a restored
backup to review the result first. Do not run two pruners, migrations, or DDL
concurrently. The tool assumes the operator's `--writers-stopped` assertion is
true; it cannot fence external writers between its separately committed
transactions.

## CLI

The connection uses the same environment variable as the upgrade CLI. PostgreSQL
and persistent PGlite URLs are supported. Patterns are exact strings or a single
trailing `*`; they are not SQL `LIKE` patterns. Quote wildcards in the shell.

```sh
export COPILOTZ_MIGRATION_DATABASE_URL='postgres://postgres@localhost:55439/prune_history'

deno run -A scripts/prune-retained-history.ts \
  --schema=owner_archive \
  '--event-type=copilotz.schedules.tick.*' \
  '--event-type=copilotz.server.*' \
  --action-id=copilotz.schedules.tick \
  --event-type=sandboxEnvironment.updated \
  --dry-run > prune-preview.json

deno run -A scripts/prune-retained-history.ts \
  --schema=owner_archive \
  '--event-type=copilotz.schedules.tick.*' \
  '--event-type=copilotz.server.*' \
  --action-id=copilotz.schedules.tick \
  --event-type=sandboxEnvironment.updated \
  --apply --writers-stopped > prune-result.json
```

Dry run is the default. Both modes use the same exhaustive inventory and closure
planner; there is no sampling or limit on the refusal list. Apply replans from
current data rather than trusting a saved report; comparisons require unchanged
data and identical selectors. Apply removes the safe subset and leaves refused
components untouched. Matching one side of an invocation pair refuses that pair;
include both types or their common prefix. An operation with any unselected
semantic history is also refused. Expand selectors explicitly if that history
should be considered.

Repeated `--action-id` arguments constrain **only server event families**. For
an internal invoke, the target Action ID comes from captured child Action
history, linked through `parentActionRunId`; server requests resolve through the
captured `requestId`. Explicit captured action IDs are also recognized. Aliases
are not Action IDs. Missing or ambiguous identities that are not entirely in the
supplied list do not match. Non-server families are unaffected by this option.
Without an action filter, every matching server type is considered, subject to
all safeguards.

JSON goes to stdout; inventory and committed-batch progress go to stderr. Errors
terminate the command with a nonzero exit status. A report containing refusals
is a successful inspection, not a command failure.

## Programmatic API

```ts
import { openManagedOminipgDatabase } from "../runtime/persistence/ominipg.ts";
import { pruneRetainedHistory } from "./prune-retained-history.ts";

const database = await openManagedOminipgDatabase({
  url: Deno.env.get("COPILOTZ_MIGRATION_DATABASE_URL")!,
  pgPoolMax: 1,
  requestTimeoutMs: 86_400_000,
});
try {
  const report = await pruneRetainedHistory(database.session, {
    schema: "owner_archive",
    eventTypes: ["copilotz.schedules.tick.*"],
    // apply: true,
    // writersStopped: true,
    batchSize: 5000,
    progress: (message) => console.error(message),
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await database.close();
}
```

The API accepts a `SqlSession`; callers must configure its driver with a long or
unlimited request timeout. The CLI uses a 24-hour driver timeout. Inventory and
delete transactions set `statement_timeout=0`. `batchSize` is a positive integer
(default 5,000 rows). `afterBatch(committedBatches)` is an optional asynchronous
callback after commit; throwing stops the run between durable batches.

A connected closure, including invocation pairs, commits atomically even if it
exceeds the target batch size. Individual DELETE statements remain bounded by
`batchSize` and use set-based joins, not one query per event. The tool locks the
owner tables within each delete transaction and verifies the version and
original row hashes. A changed/missing planned row rolls back that entire batch.

There is no persistent checkpoint table. Successfully deleted components no
longer match on restart; an interrupted transaction rolls back. Re-run the same
command to continue. A second completed run deletes nothing. No sequence, epoch,
ordinal, retained head, or schema marker is renumbered.

## Reference discovery and safety

The inventory uses PostgreSQL catalogs on both backends, and a read-only,
repeatable-read cursor over every owner table. Incoming foreign keys are
discovered from `pg_constraint`/`pg_attribute`, including composite keys and
keys from other schemas. Referencing external tables are inventoried as
protected records. FK children are deleted explicitly before their parents, so
`ON DELETE CASCADE` never silently expands the plan. Cyclic deletion
dependencies are rejected. Partitioned or inherited tables, foreign tables,
materialized views, RLS, DELETE triggers, and DELETE rewrite rules are rejected
rather than given incomplete inventories.

Most runtime relationships are **not foreign keys**. The implementation also
examines all retained text/JSON values and JSON keys for candidate event, body,
operation, delivery, stream, Action-run, receipt-key, authorization-effect-key,
and selection-head identities. It parses JSON encoded in strings, as used by
owner alarm/deadline keys. Exact identity collisions across namespaces
conservatively protect history. This does not interpret arbitrary
application-specific encodings, ciphertext, or references stored outside the
connected database; those require a separate application inventory.

Ownership rules were traced from the retained v7 fixture DDL and these sources:

- `runtime/events/schema.ts`: event bodies, deliveries, open actions, effects,
  owner receipts, alarms and deadlines.
- `runtime/streams/catalog.ts`: root operations, operation-event indexes,
  streams, operation selections, and shared selection heads.
- `runtime/actions/upgrade-history.ts`: causation, body captures/digests,
  operation roots/indexes, and invocation/terminal pairing.
- `runtime/actions/drain.ts`: explicit terminal allowlists for deliveries,
  operations, streams, and effects.
- `runtime/actions/lifecycle.ts` and `runtime/application/ingress/`: Action-run
  identity, server requests, wrapper and target Action linkage.
- `runtime/authorization/schema.ts`: invocation captures and authorization
  effects.

The report's `references` contains the actual discovered FK definitions and
semantic reference families, including extension tables. Unknown referencing
rows are protected; they are never assumed to be disposable noise.

The candidate closure contains selected events, their bodies and deliveries,
operations rooted at those events, operation indexes/streams/selections, and
heads whose associations all belong to the closure. Receipts, effects, and
authorization captures are included only when tied to candidate operations/runs
and not shared with retained event/body/operation identities. Authorization
sessions/channels, content storage, graph records and other tables are
protected.

Every incoming reference from a retained row refuses the whole connected
component. This protects nodes, edges, assets, protected values, open actions,
owner alarms/deadlines, causation descendants, shared bodies and shared
receipts. Non-terminal or unknown delivery/operation/stream/effect states also
refuse their components. Invocation and terminal events and bodies stay
together. Orphaned or unidentifiable invocation histories are not silently
repaired by deletion.

The planner first gathers identity strings, then streams full rows through a
1,000-row cursor. It retains compact identities, states, FK pair keys, row
hashes and only strings that match the identity universe. Payloads are discarded
after each page. Memory grows with identities and references rather than body
bytes. The database executes serial queries through one CLI connection.

## Report and follow-up

The report contains:

- `before`, `after`, `deleteCounts`: every inventoried table, including empty
  ones. Dry-run `after` is projected; apply verifies actual owner-table row
  counts.
- `typesBefore`, `typesAfter`, `remainingFamilies`: exact type counts and every
  remaining type sorted by frequency, allowing further family selection.
- `refusals`: each matched event that remains, with all component refusal
  reasons.
- `tupleBytesDeleted`: sum of `pg_column_size` for planned/deleted rows, an
  estimate of reusable tuple space, not promised filesystem savings.
- `relationBytesBefore`, `relationBytesAfter`, `filesystemBytesReclaimed`:
  actual relation sizes and their nonnegative reduction. Ordinary DELETE
  commonly returns **zero bytes to the filesystem** until storage maintenance.
- `vacuumCommands`: schema-qualified `VACUUM (ANALYZE)` commands for precisely
  the touched tables; run these outside a transaction after apply. They make
  dead space reusable and update planner statistics. The pruner reports commands
  rather than running VACUUM automatically.
- `committedBatches`, `elapsedMs`: completed work and total planning/apply time.

Then run the existing upgrade CLI's `drain` and `prepare`. Pruning does not
settle pending work: retained open operations/deliveries must still drain on the
old runtime. At v11, `prepare` intentionally reports the next owner-key
migration gate; the v7 retained-data preparation step has already completed.

## Reproducing validation

Use synthetic data only. These tests reject PostgreSQL URLs unless the port is
55439 and the database name starts with `prune_`. They create isolated schemas
and remove them in `finally`. Run one test process at a time.

```sh
# PGlite, including 100,002 noise events plus retained real-record fixtures:
deno test -A scripts/prune-retained-history.test.ts

# Create prune_history on the local test server first, then:
PRUNE_TEST_DATABASE_URL=postgres://postgres@localhost:55439/prune_history \
  PRUNE_TEST_EVENTS=300000 \
  deno test -A scripts/prune-retained-history.test.ts

deno task check
deno fmt --check scripts/prune-retained-history.ts \
  scripts/prune-retained-history.test.ts scripts/prune-retained-history.md
deno lint scripts/prune-retained-history.ts scripts/prune-retained-history.test.ts
```

Fixtures restore the existing synthetic old-runtime v7 schema and retained
messages/documents, assets, streams and Action captures. v11 fixtures are
produced by the actual reviewed upgrade, not by relabeling v7. Large fixtures
add ticks, internal scheduler invokes, valid SHA-256 event bodies, status churn,
terminal deliveries, operations and operation-event indexes using set-based
inserts. Smaller fixtures add each refusal independently, shared selection
heads/receipts, authorization captures/effects, and cross-schema cascading
foreign keys.

Tests compare digests of every retained real-data table before/after pruning,
verify dry-run immutability and agreement with apply, preserve blocked
histories, inject interruptions both inside a transaction and after commit,
resume, and check idempotence. The large v7 test then proves `drain` and
`prepare` succeed. Outstanding work in the refusal fixture remains outstanding,
as required.

## Implementation validation report — 2026-10-23

| Backend         | Noise events inventoried |  Dry run |    Apply | Committed batches | Tuple bytes deleted |
| --------------- | -----------------------: | -------: | -------: | ----------------: | ------------------: |
| PGlite          |                  100,002 |  7.773 s | 12.894 s |                51 |          62,037,592 |
| PostgreSQL 18.3 |                  300,000 | 62.570 s | 78.429 s |               151 |         188,169,664 |

Apply timings include a fresh exhaustive inventory, reference planning, batched
transactions, and final count verification. Each run retained the original
old-runtime fixture and 15 protected noise events. PostgreSQL fixture generation
took 37.294 s; post-prune preparation took 1.356 s. The 300k fixture contains
200k Action bodies, 50k deliveries, 50k operations, and 150k operation-event
index rows in addition to the events and retained records. No production data
was used.

PostgreSQL used the local server on port 55439, database `prune_history`, one
client connection, and `max_parallel_workers_per_gather=0`. This is a serial
local benchmark, **not a measurement on dedicated 1-vCPU hardware**. It meets
the minutes scale target in that environment. An earlier run completed apply in
212.861 s; shared-host load affects timings. The first attempt hit a server
WAL-disk `ENOSPC` while generating the fixture, before pruning; its synthetic
schema was removed and the complete suite was rerun successfully.

Six integration tests pass on both PostgreSQL and PGlite. They exercise actual
v7 and upgraded v11 schemas, every refusal family, positive/negative Action-ID
filtering for requests and internal invokes, partial invocation selectors,
shared bodies/receipts/heads, authorization and stream closure, cross-schema
FKs, transaction rollback, resume, idempotence, exact dry-run/apply counts, and
retained record/history digests. `prepare` succeeds from v7 after explicit
synthetic settlement; at v11 it correctly reports the next owner-key migration
step.

Files:

- `scripts/prune-retained-history.ts`: CLI, API, inventory, closure planner,
  transactional deletion and reporting.
- `scripts/prune-retained-history.test.ts`: synthetic fixtures, backend
  validation and repeatable scale benchmark.
- `scripts/prune-retained-history.md`: operator/API documentation and this
  report.

Repository validation: `deno task check`, `deno fmt --check` on all three files,
and `deno lint` on both TypeScript files pass.

## Reviewed retirement of unterminated invocations

An empty `open_actions` table and a successful drain do not certify that every
old request recorded a terminal result. Ordinary event-type pruning still
refuses these histories. Use a separate, explicitly reviewed retirement:

```sh
deno run -A scripts/prune-retained-history.ts --schema=SCHEMA \
  --list-unterminated > abandoned.json
# Review abandoned.json, then dry-run the exact bound listing:
deno run -A scripts/prune-retained-history.ts --schema=SCHEMA \
  --abandoned=abandoned.json > retirement-preview.json
deno run -A scripts/prune-retained-history.ts --schema=SCHEMA \
  --abandoned=abandoned.json --apply --writers-stopped > retirement-result.json
```

The inventory shares the upgrade's SQL predicate: namespace, run ID and action
ID with an invoked body and no confirmed terminal (including its null-action
rule). It lists every refused invoked body, even one without an event, with
event IDs and times, the exact closure's table/tuple/hash identities,
retained-reference status, and refusal reasons. `digest` binds the schema,
version and full invocation list. Keep those fields unchanged. To approve a
subset, add a top-level `bodyIds` array of exact listed body IDs; inspect
namespaces too because IDs may repeat between namespaces. An omitted subset
selects all entries.

Retirement requires exactly one body for the run in its namespace, regardless of
action ID or status. Any second body, including a terminal or progress capture,
blocks retirement. All existing reference, FK, open-action, delivery, operation,
stream and effect checks still apply. Connected components are indivisible.
Refused components remain and are reported; safe components can retire. Review
`refusals` and `deleteCounts` before continuing. Changed closures require a new
listing and review. Resume with the same file after interruption: already absent
bodies are skipped, and committed closures are never deleted twice. Keep writers
stopped throughout listing, review and apply; a digest is an integrity binding,
not a signature or permission to ignore concurrent writers.

After retirement, run `drain`, then `prepare --storage=./migration-storage.ts`
as shown in [the offline upgrade guide](upgrade-retained-data.md).

### Attestation and abandonment without deletion

Listing now adds `terminal: "attested" | "unattested"`. Attested rows include
`attestation` with wrapper run/body IDs, status and original digests. Invalid
wrapper evidence includes `attestationRefusal`; investigate it before
conversion. The wrapper reference still protects its target from retirement.

Use **drain → list → optional retirement of unreferenced noise → reviewed
abandonment decision → prepare/finalize**. Unattested runs referenced by
terminal operations or application rows can be preserved and cancelled during
upgrade. Select their exact `{ namespace, runId, actionId, bodyId }` identities
and use `abandonmentDecisions(entries)` to create the upgrade's digest-bound
file. See
[the decision format and commands](upgrade-retained-data.md#old-invocations-without-their-own-terminal-body).
Pass that file to the upgrade CLI's `--abandoned` on prepare and apply. The
pruner's `--abandoned` continues to mean reviewed **deletion** of its closure
listing; do not interchange the two files. Neither decision can override live
work, an open action, multiple bodies, or an existing terminal.
