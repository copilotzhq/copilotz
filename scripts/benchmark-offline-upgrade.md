# Synthetic offline-upgrade rehearsal

This benchmark accepts only localhost PostgreSQL URLs on port 55439 and database
names beginning with `migperf_`. It never downloads or reads production data,
invokes git, or creates an authority manifest for an operator's database. The
automatically generated authority and key adapters are **test fixtures only**.

## Reproduce

Create an empty disposable database, then run one migration client at a time:

```sh
createdb -h localhost -U postgres -p 55439 migperf_small
deno run -A scripts/benchmark-offline-upgrade.ts \
  --url=postgres://postgres@localhost:55439/migperf_small \
  --events=50000 --schemas=3 --body-bytes=1024 \
  --output=/tmp/migperf-small.json

createdb -h localhost -U postgres -p 55439 migperf_large
deno run -A scripts/benchmark-offline-upgrade.ts \
  --url=postgres://postgres@localhost:55439/migperf_large \
  --events=250000 --schemas=3 --body-bytes=65536 \
  --output=/tmp/migperf-large.json
```

Allow enough free disk for the source, index/table rewrites, temporary files and
WAL; 10 GiB free is a practical starting point for this roughly 5 GB fixture.
`pg_stat_statements` must be preloaded when the cluster starts. The script
creates the extension in its own database. If it is unavailable, it explicitly
reports client SQL counts/timings instead; these are not server execution times.

The fixture restores `fixtures/retained-upgrade/baseline.json`, which was
generated using the real v7 code at `8736b9c8b86f09b8febf3e2510f904ebfd2be28c`.
It then expands that schema with deterministic synthetic records and canonical
event digests. No current schema is relabeled as v7. Each schema adds:

| Records                              | 50k fixture | 250k fixture |
| ------------------------------------ | ----------: | -----------: |
| Events                               |      50,000 |      250,000 |
| Event bodies                         |      40,000 |      200,000 |
| Invocations with confirmed terminals |       4,000 |       20,000 |
| Assets / physical bodies             |       4,000 |       20,000 |
| Domain and execution-owner nodes     |       8,000 |       40,000 |
| Settled deliveries                   |      10,000 |       50,000 |
| Legacy session records               |         500 |        2,500 |

The original fixture additionally contributes 20 events, 14 event bodies, one
asset and five physical bodies, including incomplete terminal streams, missing
and purge-pending observations, retained captures and two namespaces. Native
authorization sessions did not exist at v7; the benchmark adds 1,000 at v13 and
checks that v14 preserves them. `--orphan=yes` adds an invocation without a
terminal: preparation must refuse it without advancing the marker.

The event count must be divisible by 50. `--body-bytes` controls deterministic
incompressible payloads, independently of row count. The default is 1 KiB; 64
KiB is the byte-volume rehearsal. Run the same sizes and byte lengths when
comparing row scaling.

The report contains wall time, client statement count, and the top 15 SQL
statements for each step: drain, prepare, finalize v11, owner keys v12,
authority inventory, test-manifest generation, authority v13, and storage v14.
When available it also includes `pg_stat_statements` calls, execution time,
rows, reads and temporary writes, filtered to this database. Statistics resets
affect only the selected disposable database. Fixture generation and synthetic
manifest generation are listed separately from cutover work.

Additional options:

- `--source=/path/to/untouched/source` loads migration implementations from a
  filesystem copy. Make the copy before editing; the script never creates a
  checkout. Connection deadlines are disabled for both implementations so the
  comparison measures migration work, rather than the known 29-second cap.
- `--latency-ms=1` adds an explicit delay per client SQL call. It does not
  emulate server CPU or disk speed, and timer resolution can exceed 1 ms.
- `--steps=prepare,finalize-v11` selects steps; `--restore=no` keeps an existing
  synthetic schema. `--schema=owner_2 --schemas=1` selects one schema. When
  finalization alone is selected, the current preparer obtains its plan before
  timing the selected implementation.
- `--rollback=yes` runs each measured step inside an outer transaction and rolls
  it back. Use it for individual comparisons, not a complete advancing chain.
- `--checkpoint=yes` checkpoints after each step, outside its wall time.
  `--discard-schema=yes` drops each successfully completed synthetic schema and
  checkpoints before creating the next. These reduce peak disk requirements;
  they do not make a 5 GB rehearsal possible on a nearly full disk.

Reports are replaced atomically after each step. An in-flight baseline also
persists a count/timing sample every 2,000 calls. If a supervisor terminates a
slow baseline, these are lower bounds, not completed-step timings.

## Equivalence and regression checks

```sh
createdb -h localhost -U postgres -p 55439 migperf_equivalence
deno run -A scripts/compare-offline-upgrade.ts /path/to/untouched/source \
  postgres://postgres@localhost:55439/migperf_equivalence 1000 \
  > /tmp/migperf-equivalence.jsonl
```

The comparator runs old and new implementations against the same synthetic state
using savepoints in one transaction. It checks exact returned inventories and
fingerprints, every table's row count and exhaustive content digest, column
definitions, constraints and indexes. It supplies identical synthetic upgrade
IDs, physical version/reservation tokens and generated edge IDs at the SQL seam;
both runs share the same transaction timestamp and wrapped test owner key.
Nothing is omitted from the resulting row digests. This controls intentionally
random outputs without masking retained fields or changing either migration's
classification and verification logic.

Regression tests compare terminal matching with the legacy predicate, including
wrong namespaces, action/run IDs, null keys and missing terminals. They also
cover whitespace-normalized body references, corrupt digests, native versus
ordinary prefix readers and exact inventory fingerprints, duplicate active
deliveries, JSON-null ingress, oversized offline manifests, and unchanged online
timeout defaults. Existing tests cover interrupted preparation/finalization,
lost acknowledgements, changed reviewed bytes, mismatched plans, owner-key
reencryption and authority replay.

## Changes and complexity

- Offline connections forward `statementTimeoutMs: null` and use a 24-hour
  client deadline. This includes bundle import/export connections created inside
  the migration API, not only their CLI wrapper.
- History verification uses 2,000-event keyset pages and batched body lookups,
  preserving the original JavaScript ID trimming and canonical digest checks.
  Invocation/terminal matching extracts JSON keys once and groups them. A
  materialized anti-join alone was insufficient: the planner still chose a
  quadratic join at the larger size, so the final query has no join at all.
- Content ownership builds indexes over nodes, edges and recursive asset
  references once. It preserves the original report order. Physical conversion
  groups parts once per bounded batch instead of filtering all parts for every
  body, and batches metadata and chunk writes.
- Native content inventories fetch bounded prefix batches. Logical-copy inserts,
  ownership edges and changed documents use set-based SQL, with the original
  conflict and changed-source checks. Arbitrary external adapters retain their
  original verifier; they are not identified merely by a `kind` string.
- Owner-key conversion scans JSON columns together per table, retains only cells
  that can carry a schema or body identity, verifies every body, and keeps plain
  database bytes out of the retained transfer array. Changed cells are batched.
- Authority inventory materializes qualifying event IDs using a union, avoiding
  the wide OR/EXISTS join. Receipt and invocation lookups use maps; bindings and
  ingress updates are batched. Offline manifests retain strict data-only capture
  without the online aggregate 1 MiB limit. Individual runtime inputs still use
  the online validator.
- v14 groups identity-column alterations by table, rebuilding affected indexes
  once per table. All transactions, readiness markers, epoch fences and replay
  receipts remain in place. Long phases report progress to stderr.

Scanning and hashing work scales with rows, references and bytes. Required
ordering and PostgreSQL index builds can be O(n log n); there are no intentional
per-row full-table or full-inventory scans in these rewritten paths. Dense
ownership graphs cost proportional to their actual reference count. The complete
review plan remains in client memory; physical conversion also needs memory for
the largest individual body. This is not a streaming plan-file format change.

## Measured results and remaining rehearsal limits

Measurements were taken on local PostgreSQL 18.3 on an Apple ARM machine,
`shared_buffers=128MB`, `work_mem=4MB`, without injected network latency. This
is not a measurement on the production 1-vCPU host. Server statistics were
unavailable because `shared_preload_libraries` was empty; the reports identify
the client timing fallback explicitly.

The 64 KiB, three-schema fixture failed during generation with
`No space left on
device`. The 1 KiB production-row-count fixture completed one
entire schema; the second ran out of disk during finalization despite
checkpoints and disposal of the first. Failed transactions were rolled back.
These failed runs do not certify a 5 GB or three-schema production cutover.

The result table and machine-readable reports below are updated from completed
measurements; interrupted baselines are explicitly marked as censored. A full
byte-volume run, server-side statement statistics, and an actual 1-vCPU
rehearsal remain necessary before choosing a cutover window.

Seconds per schema, with **client SQL call counts** in parentheses. The 50k
optimized values are medians of three sequential schemas; the 250k values are
one completed schema. Both use 1 KiB assets, so their row/byte ratios match.
Connection setup and transaction-control statements are outside the client-call
counter. The 250k fixture has 250,020 events and 200,014 event bodies.

| Step                |               Before 50k |  After 50k |                   Before 250k |  After 250k |
| ------------------- | -----------------------: | ---------: | ----------------------------: | ----------: |
| Drain               |                 0.01 (7) |   0.01 (7) |                      0.02 (7) |    0.03 (7) |
| Prepare             |          199.95 (60,246) | 1.84 (118) | >119.6 (≥60,000), resume only | 10.14 (326) |
| Finalize v11        |         342.65 (112,558) | 5.25 (295) |      >45.6 (≥4,000), censored | 34.57 (671) |
| Owner keys v12      |             2.39 (8,057) |  0.80 (43) |                  not measured |   4.35 (51) |
| Authority inventory |                 0.64 (2) |   0.40 (2) |                  not measured |    3.11 (2) |
| Authority v13       | refused: manifest >1 MiB |  1.63 (35) |                  not measured |  16.08 (61) |
| Storage v14         |             not measured |  0.84 (64) |                  not measured |   5.21 (64) |

The large baseline prepare probe started at the already converted marker 0: its

> 119.6 s is a lower bound on resumed inventory work, not a completed initial v7
> conversion. The finalize probe's last durable sample was 45.6 s / 4,000 calls;
> the supervisor's 120 s limit included unmeasured plan acquisition, so it is
> not reported as 120 s of finalization. No interrupted value is used as a
> completed scaling sample. The untouched baseline also cannot accept the full
> 50k manifest, so subsequent before-step measurements are unavailable. The
> requested complete before/after matrix remains unfinished.

For 5× more rows, optimized SQL-call counts grow from 118 to 326 for prepare,
295 to 671 for finalization, 43 to 51 for owner keys and 35 to 61 for authority.
Fixed DDL/inventory calls account for the sublinear call-count ratios. Wall time
also includes index rebuilds, sorting, temporary I/O, hashing and garbage
collection; these two measurements alone do not establish a universal linear
runtime bound. They do demonstrate that the completed production-row-count steps
finish in seconds to under a minute locally.

Raw per-step top statements and evidence:

- [50k baseline](fixtures/retained-upgrade/benchmarks/before-50k.json)
- [50k optimized, three schemas](fixtures/retained-upgrade/benchmarks/after-50k.json)
- [250k baseline probes](fixtures/retained-upgrade/benchmarks/before-250k-censored.json)
- [250k optimized, one complete schema](fixtures/retained-upgrade/benchmarks/after-250k.json)
- [Seven exact equivalence comparisons](fixtures/retained-upgrade/benchmarks/equivalence.json)

The measured row-count work sums to about 73 seconds per schema, excluding test
manifest generation, fixture creation and checkpoints. Multiplying by three
would be about 3.7 minutes on this local machine with 1 KiB assets; that is an
extrapolation, not a completed three-schema large run.

For the 5 GB / 1-vCPU cutover, a **20–40 minute planning allowance** for
migration work is provisional, not a measured forecast or a safe activation
deadline. It assumes roughly 50–100 MiB/s effective storage throughput, adequate
client memory and no competing producers. Physical conversion, inventory and key
verification read retained bytes several times; conversion also rewrites byte
parts and generates WAL. Preparation and finalization are likely to dominate.
Slower storage, large individual bodies or external adapters can exceed this
allowance. Choose the actual cutover window only after the full-byte rehearsal
on comparable hardware; backup, human review and application validation are
additional time.

## Validation performed

- PostgreSQL: 48 tests passed across lifecycle upgrades, retained upgrades,
  receipt upgrades, history validation, authority upgrades/inventory, manifest
  validation, embedded content, native prefixes, persistence, offline CLI,
  content migration, owner bundles and the package migration contract.
- PGlite: 44 tests passed across the same scope; four PostgreSQL-only tests were
  skipped. The newly added authority-candidate regression was run separately.
- All seven old/new equivalence comparisons passed, including exact preparation
  and resume fingerprints and exhaustive data/DDL comparisons through v14.
- `deno task check` passed. `deno fmt --check` passed on all changed files;
  `deno lint` and `deno check` passed on all changed TypeScript files.

No git commands were run. Every benchmark database and record used for this work
was synthetic. Large failed databases were removed after collecting the reports;
the cluster recovered from the disk-full interruption. No production timing or
server-side statistics are claimed.
