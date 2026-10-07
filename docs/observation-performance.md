---
title: "Observation Performance"
description: "Measured database cost of idle and active operation observation in Copilotz 0.85.0, how the observation path keeps it low, and what the local benchmark does not prove."
section: Operate
order: 60
status: stable
---

# Observation Performance

## The pain

A chat product keeps one HTTP observation open for each open conversation, and
most of those conversations sit idle. If each viewer polls the database on its
own, database CPU grows with the number of open tabs rather than the amount of
work being done. A small database tier can be saturated by conversations where
nothing is happening.

## The problem

Observation has two costs, and they need to be measured separately:

- **Idle observation**: viewers that wait for new Events or stream bytes while
  nothing is written. This cost should be close to zero.
- **Active writer plus observer**: lanes that append stream bytes while viewers
  decode them. The writer pays for durable appends whether or not anyone is
  watching. Observers add read cost on top of that.

A reduction in one workload does not carry over to the other. A local benchmark
also does not tell you how much headroom a particular production database has.

## The solution

Since 0.85.0, observation inside one runtime uses these pieces:

- **Shared readers.** Within one application, viewers of the same operation
  share live Event and Body readers. The readers are keyed by schema, namespace
  and operation, and a 5-second safety reconciliation also runs. Historical
  replay is still per viewer. Once a viewer is authorized for an operation, it
  can share that operation's reader with other authorized viewers. The SQL cost
  is not constant as the number of operations grows. Readers are not shared
  across replicas, so each process runs its own.
- **Indexed selection discovery and batched access checks.** Typed catalog hints
  and selection metadata let a reader find relevant operations through indexes,
  without scanning history per viewer. Access checks are batched only for
  viewers with equivalent permission predicates. Many replicas or many distinct
  permission sets therefore add their own costs, which this benchmark did not
  measure.
- **Bounded per-viewer queues.** Each subscriber receives its own payload stream
  through a bounded queue. A slow viewer gets a retryable renewal error and
  reconnects from its checkpoint, so it does not hold unbounded memory or block
  other viewers.
- **Indexed BodyStore range reads.** Replay reads the existing Body from its
  committed offset. Chunks are never copied into a second journal.
- **Five-minute HTTP renewal.** By default the server plans an HTTP observation
  renewal after 5 minutes. It can renew earlier, for example when a viewer's
  queue reaches capacity. On a planned renewal, the published client reconnects
  on its own. This renewal is separate from retention. Settled operations stay
  replayable for a 24-hour grace period, and that data expires only when
  `app.maintenance(...)` runs. `operationRetentionMs` changes the grace period,
  and `null` disables retirement and pruning. Whether replay is possible depends
  on maintenance and on the data that has been kept, not on the cursor alone.

Readers use the existing database BodyStore and operation catalog. No broker and
no new durable payload feed are involved. Application code does not change:
`app.attach(...)`, HTTP observation and the published client use these readers
automatically. See [Streams](./streams.md) for the replay contract.

Some of these optimizations need a newer observation catalog. Upgrading it is an
**explicit offline step** in a SQL session that the host controls, and old
writers must be stopped before it runs. The v5 Event schema is unchanged. Older
cursor generations are rejected, and operation-local ordinals are not the same
as Event positions. Follow
[Events, Deliveries, and Recovery](./events-deliveries-recovery.md) and
[Upgrading](./upgrading.md). The Core history index is separate. On an existing
PostgreSQL database it can be created concurrently, outside a transaction; a
fresh PGlite host calls the provisioning helper without the concurrent option.
Installing the package does not create this index. It is not part of the
observation catalog upgrade, and it does not change visibility. Its measured
45–48× improvement applies to history query time, not to the CPU figures on this
page. See [History Performance](./history-performance.md).

## Reference

### Method

The benchmark used the real scoped application, collection access reads, HTTP
operation coordinator, native multipart response and canonical client decoder.
The active test ran clients in a separate Deno process and wrote through the
existing database BodyStore and operation catalog APIs. It did not introduce a
broker or another durable payload feed.

The released baseline was an archived checkout at commit `3999759` (0.84.3). The
current path included indexed selection discovery, batched access checks, the
shared application operation reader, typed catalog hints, bounded per-viewer
queues and indexed BodyStore range reads. Each trial used a separate synthetic
schema and ran sequentially after the native PostgreSQL test suite finished.

PostgreSQL 18.3 ran locally without a CPU quota, using a `pg` 8.23.1 SQL adapter
with unnamed queries. `fsync`, `synchronous_commit`, `full_page_writes` and JIT
were on; shared buffers were 128 MiB. Backend CPU came from OS cumulative CPU
for the observer or writer connection PIDs. Stable pool lifetimes prevented
retired PIDs from invalidating the counter. The macOS counter had 10 ms
resolution. SQL counts below exclude explicit `BEGIN` and `COMMIT`; PostgreSQL
statement counts include them. SQL execution time excludes parsing and planning,
so it differs from OS CPU.

The idle fixture contained 1,500 thread nodes, 3,000 completed operations and
60,000 indexed historical events. Every client resumed at the latest history
checkpoint. The active fixture contained 1,000 thread nodes, 100 root events and
operations, and 100 stream lanes, without the historical fixture. Payloads were
synthetic and compressible. Memory values are sampled RSS, not a memory cap or
production sizing result.

These measurements were taken on 2026-10-06 against the 0.85.0 observation path.
They are not a fresh measurement of any later release.

### Idle conversations

For 1,000 distinct idle conversations, the reduction in observer database CPU
was **142.9×** compared with 0.84.3. With staggered HTTP reconnects added at the
steady five-minute renewal rate, it was **120×**.

| Path                              | Distinct viewers | Interval | Reconnects |     Observer DB CPU | App SQL | SQL execution time |
| --------------------------------- | ---------------: | -------: | ---------: | ------------------: | ------: | -----------------: |
| Released 0.84.3                   |            1,000 |     30 s |          0 | 123.83% of one core | 113,083 |          26,756 ms |
| Current                           |            1,000 |     30 s |          0 |   0.87% of one core |     125 |             165 ms |
| Current                           |            1,500 |     30 s |          0 |   1.30% of one core |     250 |             249 ms |
| Current with staggered reconnects |            1,000 |     30 s |         99 |   1.03% of one core |     619 |             125 ms |

The matched 1,000-viewer CPU samples were 37,150 ms and 260 ms, a 142.9×
reduction. Query count fell 904.7×. The renewal trial lasted 30 seconds and
opened a real replacement HTTP observation at 3.333 reconnects per second,
matching `1,000 / 300 seconds`. It measures bootstrap overhead at the
five-minute steady rate. It is not a five-minute soak, and it does not test the
automatic lifetime timer itself.

Every current idle trial reported zero observation errors, zero live
observations after cancellation and zero pending pool requests. Combined server
and client RSS after measurement was about 294 MB for 1,000 viewers, 300 MB for
1,500 viewers and 238 MB with reconnects. The baseline accumulated 823 pending
pool requests at immediate cancellation and exited after its outstanding
database work drained.

### Active conversations

The writer appended 256 bytes to each of 100 durable lanes ten times per second,
while 900 additional conversations remained idle. All 1,000 clients were ready
before writing began. Each active lane had one viewer. Fixed-width sequence
records verified actual decoded delivery, byte continuity and duplicates. The
writer-only trial used the same 1,000-thread fixture and 100 active lanes.

| Path                | Viewers | Records written / received | Actual updates/s |     Observer DB CPU | Writer DB CPU | Observer SQL | p99 commit ACK to client |
| ------------------- | ------: | -------------------------: | ---------------: | ------------------: | ------------: | -----------: | -----------------------: |
| Released 0.84.3     |   1,000 |            15,000 / 15,000 |            997.0 | 217.54% of one core |        52.91% |      237,150 |                    67 ms |
| Current             |   1,000 |            15,000 / 15,000 |            998.3 |  25.69% of one core |        65.89% |       18,263 |                     5 ms |
| Current writer only |       0 |                 15,000 / — |            998.1 |                  0% |        71.87% |            0 |                        — |

Both HTTP trials delivered every record, with zero byte gaps, duplicates,
missing commit timestamps or observation errors. Current maximum commit ACK to
client latency was 11 ms; the baseline maximum was 91 ms. This latency starts
after the catalog offset commit acknowledgment and excludes the preceding append
work.

Observer CPU fell 8.47× and observer query count fell 12.99×. Total writer plus
observer CPU fell from 270.45% to 91.58% of one core, a 2.95× reduction.
Writer-only CPU of 71.87% shows a substantial write cost before observers are
added. The current write path also pays for typed hints and selection metadata;
the baseline writer CPU is therefore reported separately. Local run variability
affects the comparison.

The idle and active ratios come from different workloads. Do not combine or
multiply them, and do not read them as a 100× improvement for the complete
active workload.

Current server and separate client RSS were about 382 MB and 219 MB; the
baseline used 517 MB and 210 MB. Every body and catalog lane was sealed at the
end, and the harness waited up to 30 seconds for decoded records before
canceling. Both paths reported zero live observations and empty pool queues
afterward. A sampling timer initially kept the completed baseline harness
process alive; it was terminated after saved results and cleanup, and the timer
cleanup was fixed in the portable harness.

These short uncapped local trials verify delivery at the measured rate. They do
not guarantee headroom on a one-vCPU database or certify the capacity of a
production Cloud SQL tier. The current observer and writer total is already
about 92% of one local core before unrelated workload and background costs.

### Slow viewers

A separate 1,000-client trial stopped frame processing for 10% of clients,
including ten active viewers, for 25 seconds. Meanwhile, 100 lanes each wrote 16
KiB ten times per second. All 25,000 records recovered with zero gaps,
duplicates or observation errors. The ten active slow viewers received retryable
renewal errors and reconnected from checkpoints updated only after actual frame
processing.

Bodies and catalog lanes were sealed before the final drain. The all-client p99
delay of 22,623 ms includes the deliberate stall and is not a healthy-client
latency measurement. Server and client RSS were about 590 MB and 369 MB. This
run used indexed BodyStore reads and five-second status reconciliation. It ran
**before** the final merged range query and typed hint optimizations, so it does
not measure the final code path.

Focused reader tests also cover shared live fanout, independent replay offsets,
bounded slow queues, reference cleanup, late joins and terminal completion.
Multipart tests cover keeping queued payload bytes through normal terminal
completion. The benchmark is a short correctness and performance experiment, not
a long-lived memory soak.

### Run the portable harness

The harness consists of repository benchmark scripts, not application code or a
package export:
[`scripts/benchmarks/observation-idle.ts`](https://github.com/copilotzhq/copilotz/blob/main/scripts/benchmarks/observation-idle.ts)
and
[`scripts/benchmarks/observation-stream.ts`](https://github.com/copilotzhq/copilotz/blob/main/scripts/benchmarks/observation-stream.ts).
Run them from a clone of the repository.

> **Warning:** These opt-in scripts require an explicitly configured **isolated
> localhost PostgreSQL database**. They reject remote hosts and use only the
> fixed `bench_observations_*` schemas. The stream harness drops and recreates
> its own synthetic schema at each trial. The idle harness keeps its synthetic
> fixture for paired runs. Never point them at a database that holds data you
> need in those schemas.

The harness requires Deno and PostgreSQL. CPU attribution supports macOS through
`ps`, and Linux through `/proc/<pid>/stat` with `getconf CLK_TCK`. The Linux
implementation is included for portability; the figures above were measured on
macOS. Windows CPU attribution is unsupported. Fetching the pinned opt-in
`npm:pg@8.23.1` dependency may require initial network access.

Set `COPILOTZ_BENCH_POSTGRES_URL` through your shell or environment manager.
Optionally set `COPILOTZ_BENCH_OUTPUT_DIR` to append raw JSON records to files;
otherwise results are printed to standard output. For released comparisons, set
`COPILOTZ_BENCH_BASELINE_ROOT` to an archived checkout. Use that checkout's Deno
configuration for the baseline so its bare imports resolve to its own code.

From the repository root:

```sh
# Short portability smoke test: two clients and one active lane.
deno run -A --config deno.json scripts/benchmarks/observation-stream.ts 2 1 1 256

# Current idle and steady renewal measurements.
deno run -A --config deno.json scripts/benchmarks/observation-idle.ts current 1000 30
deno run -A --config deno.json scripts/benchmarks/observation-idle.ts current 1500 30
deno run -A --config deno.json scripts/benchmarks/observation-idle.ts current 1000 30 3.333333333

# Current active, writer-only and slow-viewer measurements.
deno run -A --config deno.json scripts/benchmarks/observation-stream.ts 1000 100 15 256
deno run -A --config deno.json scripts/benchmarks/observation-stream.ts 0 100 15 256
deno run -A --config deno.json scripts/benchmarks/observation-stream.ts 1000 100 25 16384 slow

# Archived baseline. COPILOTZ_BENCH_BASELINE_ROOT must be set.
deno run -A --config "$COPILOTZ_BENCH_BASELINE_ROOT/deno.json" scripts/benchmarks/observation-idle.ts baseline 1000 30
deno run -A --config "$COPILOTZ_BENCH_BASELINE_ROOT/deno.json" scripts/benchmarks/observation-stream.ts 1000 100 15 256 normal baseline
```

Stream arguments are viewer count, active conversation count, duration in
seconds, bytes per record, optional `slow` or `normal`, and optional `current`
or `baseline`. Idle arguments are mode, viewer count, duration, and optional
reconnects per second. Run trials one after another: repeated stream runs
intentionally reuse and reset their own schema. The benchmark scripts are not
part of the test suite and do not run in CI automatically.

## What this unlocks

Open conversations that nobody is writing to no longer cost much database CPU.
You can keep many viewers attached and let the published client handle planned
renewals transparently. A reconnecting or slow viewer resumes from its
checkpoint only while the history it needs is still retained. If a viewer's
replay exceeds capacity, it must start again from a fresh canonical history
bootstrap, which is a different path from a planned renewal. You will still need
to measure capacity for active streaming on your own database tier, with your
own replica count and permission mix.

## Next steps

- [Streams](./streams.md): replay, retention and HTTP renewal.
- [Events, Deliveries, and Recovery](./events-deliveries-recovery.md):
  observation catalog upgrade and cursors.
- [History Performance](./history-performance.md): the Core history index.
- [Upgrading](./upgrading.md): offline upgrade steps for release versions.
- [Deploy and scale](./getting-started/part-5-operate-and-scale/21-deploy-and-scale.md):
  gateway and worker topology.
