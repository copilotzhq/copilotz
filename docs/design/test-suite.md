# Faster retained-suite feedback

## Status and measured bottleneck

The additive Node orchestrator in `scripts/test-suite.mjs` is an **experimental
serial-batching candidate**, not the release gate. The existing
`deno task test`, connected runner, dependency pins, checks, and CI are
unchanged. It introduces no Deno APIs, dependencies, assertion changes, timeout
changes, or parallel workers (F1 §§5 and 8, Node-first tooling during the
transition).

Read-only timing of the historical 501-file immutable acceptance ledger found:

- 3,923.39 seconds of primary command elapsed time (65.4 minutes)
- 1,835.19 seconds in 498 parseable Deno summary durations (30.6 minutes)
- 2,075.60 seconds outside those summaries for the same 498 commands (34.6
  minutes), with a median 4.13 seconds per file

These rounded Deno timers are not a profiler. The difference combines executable
startup, dependency resolution/type checking, module initialization, and any
other work outside the reported timer. It does not individually measure any of
those costs. The baseline includes failed files and is not a speed comparison
against corrected code. Inter-command source verification and separate service,
connected, static, and matrix stages are not included in these numbers.

Batching aims to amortize repeated process/type-graph preparation while keeping
file execution serial. One representative timing result is recorded below; it is
not a full-suite speed or equivalence claim. In particular, process memory,
worker teardown, file isolation, and retained test/backend coverage must be
established in a released benchmark lane before adopting the candidate as an
authoritative gate.

## First corrected-source representative measurement

A frozen 16-file comparison on tree `d1c8152ad49214cb6b02e43d372c32ccd4e67854`
ran with the same source, reviewed runner, runtime binaries, configuration and
initial dependency-cache contents in both modes. Each mode used its own
disposable PostgreSQL database. Both test processes passed **115 tests and eight
nested steps**.

| Measurement       | Per-file reference | One grouped batch |
| ----------------- | -----------------: | ----------------: |
| Command wall time |          208.436 s |         176.251 s |
| `wait4` peak RSS  |      3,122,800 KiB |     3,362,652 KiB |

This one grouped run was **32.2 seconds (15.4%) faster**, with **7.7% higher
per-process peak RSS**. The comparison was reference-first, not randomized or
repeated; it does not establish a guaranteed improvement or extrapolate to the
complete suite. Matching dependency-cache contents does not reset the OS page
cache. Summed sampled RSS is a different metric and can double-count shared
pages.

The comparison orchestrator correctly retained a nonzero outcome: its exact
ordered inventory differed because Deno ran files in a different order in the
grouped invocation. A separate post-run audit found identical multisets of all
16 file headings and 123 path/name/status records, with each individual file's
case/step order unchanged. That audit does not rewrite the original comparison
failure or prove full-suite isolation. The installed-runtime probe also shows
that CWD and environment mutations can cross file boundaries despite fresh
module/global state.

Both modes exported their database evidence, dropped their own database and
stopped the service. No test sessions or known child processes remained. The
candidate therefore stays experimental. Broader order-sensitive fixtures,
resource bounds and complete retained-suite coverage must be validated before
changing the release gate. Daily scoped checks remain the practical fast loop.

## Daily workflow

Inspect the full path/hash inventory without starting any runtime or service:

```sh
node scripts/test-suite.mjs --plan
```

Run the exact files relevant to the current edit, with ordinary checking:

```sh
node scripts/test-suite.mjs --file runtime/owner/boundary.test.ts \
  --output /tmp/copilotz-boundary-feedback-001
```

This is explicitly `scoped-feedback`, even if the caller lists every file. It
cannot stand in for regression coverage. No inferred dependency graph or
changed-file heuristic silently removes tests. When the affected set is
uncertain, use the complete retained suite.

Run a complete discovered inventory in serial batches of at most 32 files:

```sh
node scripts/test-suite.mjs --output /tmp/copilotz-suite-001
```

`--batch-size 1` is the per-file reference mode; values 1–128 are accepted.
There is no `--parallel`, `--filter`, `--no-check`, or generic process timeout.
Explicit file paths are sorted and partitioned exactly once. This controls batch
membership, not Deno's execution order within a batch. All seven roots are
required: `contracts/package`, `runtime`, `plugins`, `server`, `client`,
`scripts`, `build`. Discovery accepts `test.*`, `*.test.*`, and `*_test.*` for
the retained JavaScript/TypeScript extensions, including zero-case fixture
files. Missing roots, symlinks, unknown selected files, and duplicate selections
fail closed.

Use `--root` for a prepared frozen checkout, `--config` for its already reviewed
source configuration, and `--deno` for the installed runtime executable. The
runner never creates sibling mappings, changes published pins, provisions a
service, installs dependencies, or sanitizes the supplied environment. Callers
must supply the same approved backend/source/cache environment to reference and
candidate runs. Config bytes are hashed and their path is passed unchanged. The
output directory must be new and its parent must already exist.

## Evidence and failures

`plan.json` contains the discovered path/SHA256 inventory, selected paths, batch
membership, exact flags, config identity, and mode. Each batch has raw stdout,
stderr, command/timing/status JSON, and the final `summary.json` names
unlaunched files. The runner does not serialize environment secrets or database
URLs.

An ordinary failed batch stays failed and later batches continue. There is no
automatic retry, including after an apparent typecheck failure: rerunning
stateful files could repeat effects. Every member of a failed or interrupted
batch is listed without individual completion evidence. A batch result cannot
identify which members actually completed; inspect raw output and retain any
separate scoped diagnosis without rewriting the failed attempt. Startup failures
are explicit. SIGINT/SIGTERM stop new batches and are forwarded to the child
process group on POSIX; Windows forwards to the direct child. Forced kills may
leave a `running` batch record and require explicit inspection/cleanup.

Successful checked batches establish only a candidate retained-suite outcome.
They do not establish the other release gates, source immutability, unchanged
backend coverage, or safe grouping. This tool is for developer feedback; the
immutable acceptance orchestrator remains responsible for complete provenance,
service ownership, database evidence/export, and cleanup.

## Equivalence and benchmark protocol

After the active authoritative run releases the runtime lane:

1. Select one exact Copilotz tree, exact sibling/config identities, and
   installed runtime versions. Produce reference and grouped plans from that
   same source; compare sorted path/hash inventories and every selected file.
   New tests added since a historical run are an explicit inventory difference,
   not an omission
2. Reuse comparable prepared caches, with their starting identities recorded.
   First compare a representative pure/DB/worker selection in per-file and
   grouped modes. Keep original assertions, backend flags, checking, and
   deadlines. Include zero-case fixtures and actual crash/fault files
3. Compare actual test names, passed/failed/ignored counts and reasons, backend
   branches, and per-file discovery from raw output. Inspect the installed
   runtime's real multi-file module/process behavior; do not infer isolation
   merely because the existing connected runner accepts sixteen file arguments
4. Inspect process/worker counts and resident memory throughout; record peak
   RSS, CPU and wall time with external process-tree instrumentation. The
   current JSON records wall time only. Record source/cache artifacts, open
   handles, leftover children, generated outputs, and database/session cleanup
   before and after. A single successful grouped run does not prove safe
   parallelism
5. Run the complete same-source comparison once the initial isolation checks
   pass. Keep fresh equivalent disposable database state and identical source
   mappings; do not overlap the two runs. Retain every failure and its evidence
6. Report measured wall/resource changes and unknowns. Adopt only after review
   of inventory, test/backend equivalence, isolation, and failures. Batch size
   is tunable; 32 is a candidate, not a measured optimum

Source inspection of the pinned Deno 2.9.2 implementation supports this design:
[the test runner](https://github.com/denoland/deno/blob/v2.9.2/cli/tools/test/mod.rs)
checks the selected graph before execution and creates a main worker per
specifier. Its task buffer uses the configured concurrency;
[argument resolution](https://github.com/denoland/deno/blob/v2.9.2/cli/args/mod.rs)
returns one when parallel mode is absent. This suggests per-module JavaScript
isolation and shared preparation, not separate operating-system processes.
Installed-binary behavior, resource lifetime, and full equivalence still require
measurement.

No parallel sharding is implemented. Shared PG schemas/connections, service
ownership, cache writes, generated bundles, process-global working directories,
module state, nested workers, and CPU-sensitive deadlines make unreviewed
parallelization unsafe. In particular, existing bounded jq admission remains
unchanged. Serial batching still needs checking for shared process/resource
lifetime differences.

The complete gate continues to require the canonical connected cases, all
retained primary files with PostgreSQL enabled, the four complete memory-only
supplements (`parallel-tool-plan`, `text`, `event-store`, and
`startup-graph-schema.integration`), independent architecture/package/format
checks, published-pin checks versus separately labeled mapped diagnostics, and
the full runtime/build matrix. Paid-provider and unprovisioned MinIO omissions
remain explicit; no coverage is silently replaced with scoped feedback.

## Tooling tests

```sh
node --test scripts/test-suite.test.ts
```

These setup tests exercise discovery, hashing, exact partition equivalence,
argument/config preservation, serial scheduling, failure continuation, no
retries, cancellation, evidence preservation, and scoped/full labels using
synthetic files, injected child results, and tiny real Node subprocess lifecycle
checks (logs, launch errors, default cancellation, and POSIX descendant
cleanup). They do not run or benchmark the Copilotz suite and do not establish
any foundation behavioral conformance case. All foundation conformance cases
remain the responsibility of the retained behavioral suites.
