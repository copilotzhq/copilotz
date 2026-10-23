# Agent turn latency benchmark

Measured 2026-10-21/22, Deno 2.9.2, PostgreSQL 18.3, this checkout’s 0.90.0
baseline. No git commands were used. Both PostgreSQL and PGlite measurements use
fresh databases. PostgreSQL was initially unavailable, then became reachable on
port 55437 during final verification; its benchmark and targeted validation are
now complete.

## Reproduce

Run from the repository root, one process at a time:

```sh
nice -n 10 deno run -A scripts/benchmark-turn.ts --backend=postgres --n=5 --out=/tmp/turn-postgres.json
nice -n 10 deno run -A scripts/benchmark-turn.ts --backend=pglite --n=5 --out=/tmp/turn-pglite.json
nice -n 10 deno run -A scripts/report-turn.ts /tmp/before.json /tmp/after.json
```

The PostgreSQL runner requires a server on **55437** and a role allowed to
create databases. `BENCH_DATABASE_URL` defaults to
`postgres://postgres@localhost:55437/postgres`. It creates and drops a unique
`perf_turn_*` database and schema. PGlite uses a fresh private in-memory
database. The injected Ominipg connection has `pgPoolMax: 1`; the owner remains
the sole serialized writer. Managed PostgreSQL with that capacity uses the
existing owner-command Collection snapshot path, since the dependency’s native
snapshot requires a two-connection reservation. Custom providers and background
sync retain their native admission checks.

Options: `--model-ms=0`, `--chunks=0`, `--idle-ms=30000`. `--chunks=N` emits N
one-byte progressive content frames in a burst; zero emits only the provider’s
final result. `--n=0` runs only the idle scenario. Each turn has a bounded
timeout. Results are saved incrementally; errors retain partial counters.
Startup, thread seeding, subscriber admission, verification reads and cleanup
are excluded from workload counts.

All recorded commands used `nice -n 10`, but this sandbox prints
`setpriority: Operation not permitted`; lowered priority could not be confirmed.
Workloads were bounded and never ran concurrently. No full test suite was run.

Full SQL histograms, per-command durations, delivery diagnostics, CPU profiles
and logs from these runs are kept outside the repository; rerun the commands
above to reproduce them.

## Composition and measurement contract

- Normal gateway and owner, a real Oxian hypervisor with in-process transport,
  and a database-free worker with the ordinary capability protocol. The injected
  hypervisor wraps host-call admission only for counting; it uses the gateway’s
  real capability handlers and lifecycle callbacks.
- Core, Core chat HTTP Actions (`sendConversation`), web channel plus
  external-egress processor, Usage, Memory (including consolidation processors),
  and a product Agent, echo Tool, and near-no-op processor on `message.created`.
  The send uses the same protected ingress helper and inline relay admission as
  the public host Action caller. It does not measure an HTTP socket, browser
  rendering or product-specific authentication policies.
- Live message Collection subscription with a fixture read policy, already
  admitted before timing. Message visibility is arrival in the subscriber’s
  batch, not the database insert. Final reply visibility excludes the
  intermediate Agent tool-call message. Tool turns assert two provider calls and
  exactly one echo execution; plain turns assert one provider call. Completed
  deliveries must succeed on their first attempt.
- Each sample gets a fresh thread. Memory is installed at its real default
  20,000-token threshold; these short conversations do not trigger a
  consolidation model call. Web chat has no external provider binding, so egress
  runs its normal eligibility checks without network delivery. These are
  explicit limits of the composition, not disabled production features.
- Five sequential samples per scenario, including the first cold turn; no
  warm-up exclusion or confidence interval. Plain and tool scenarios are
  followed by isolated no-op deliveries and a 30-second idle window after
  detachment has drained. The retirement bug did not appear: all four matched
  idle windows recorded zero commands and zero SQL.
- Milestones are cumulative from send. `turnSettled` is the operation’s ordinary
  settlement promise; `allDeliveriesSettled` additionally verifies that detached
  work has drained. Subscriber admission/detachment is outside the range. Counts
  are process-wide during each interval, including concurrent usage, egress,
  alarms, and publication work.
- Owner commands count top-level submissions, not helpers joining the same
  command. SQL calls count instrumented `query` invocations, including
  SAVEPOINT/RELEASE. SQL round trips are **estimated as SQL calls + 2 ×
  transaction/snapshot invocations**, not packet capture; BEGIN/COMMIT and
  snapshot internals are driver-owned. Host calls are separately observed Oxian
  calls, including event-driven long polls. Deliveries count placement requests;
  durable created-to-settled timings come from the delivery rows and include
  queueing. Verification reads use an uninstrumented handle and run after the
  principal settlement milestone.
- Raw results contain SQL histograms and command-kind attribution.
  `read/publication` in `commandSql` also includes the common fence,
  authorization, alarm refresh, and commit-scope machinery outside handler
  execution; it is not exclusively read traffic. Command durations include
  queueing. Host-call durations overlap and include long-poll wait, so their sum
  is not transport overhead.

## Before / after

Percentiles below use nearest rank. Prefer work counts over speedup ratios: the
PostgreSQL plain-turn p50 was essentially unchanged despite fewer SQL calls, and
the PGlite baseline varied from 290 to 353 ms across earlier runs. Scheduling
and group composition also cause some count variation.

The PostgreSQL baseline holds the single-connection snapshot compatibility fix
constant. Without it, Ominipg’s native snapshot requires two connections and
cannot run Core history reads at `pgPoolMax: 1`. The comparison therefore
measures the delivery/deadline and primitive-read optimizations, rather than
silently increasing pool capacity. PGlite uses the original baseline snapshot
behavior.

### PostgreSQL

Backend: postgres. Cells show before → after; cumulative medians from send, five
samples by default. SQL round trips include estimated transaction boundaries.

**plain**

| Stage                |            ms | Owner commands |     SQL calls | SQL round trips (est.) |  Host calls |  Deliveries |
| -------------------- | ------------: | -------------: | ------------: | ---------------------: | ----------: | ----------: |
| sendAccepted         |     3.6 → 3.6 |      1.0 → 1.0 |     5.0 → 5.0 |              7.0 → 7.0 |   0.0 → 0.0 |   1.0 → 1.0 |
| messageVisible       |   19.9 → 23.1 |      4.0 → 4.0 |   32.0 → 32.0 |            40.0 → 40.0 | 10.0 → 10.0 |   1.0 → 1.0 |
| modelStarted         |   79.5 → 84.6 |    26.0 → 24.0 | 215.0 → 191.0 |          257.0 → 231.0 | 49.0 → 49.0 |   4.0 → 4.0 |
| replyVisible         | 151.9 → 158.1 |    48.0 → 46.0 | 394.0 → 360.0 |          474.0 → 438.0 | 75.0 → 75.0 |   7.0 → 7.0 |
| turnSettled          | 196.0 → 196.9 |    65.0 → 62.0 | 524.0 → 470.0 |          628.0 → 572.0 | 92.0 → 92.0 | 10.0 → 10.0 |
| allDeliveriesSettled | 196.2 → 197.0 |    65.0 → 62.0 | 524.0 → 470.0 |          628.0 → 572.0 | 92.0 → 92.0 | 10.0 → 10.0 |

No-op created → settled p50 (includes queueing): 26.0 → 25.0 ms.

**tool**

| Stage                |            ms | Owner commands |      SQL calls | SQL round trips (est.) |    Host calls |  Deliveries |
| -------------------- | ------------: | -------------: | -------------: | ---------------------: | ------------: | ----------: |
| sendAccepted         |     3.5 → 3.4 |      1.0 → 1.0 |      5.0 → 5.0 |              7.0 → 7.0 |     0.0 → 0.0 |   1.0 → 1.0 |
| messageVisible       |   18.5 → 18.8 |      4.0 → 4.0 |    32.0 → 32.0 |            40.0 → 40.0 |   10.0 → 10.0 |   1.0 → 1.0 |
| modelStarted         |   74.6 → 71.4 |    26.0 → 24.0 |  215.0 → 191.0 |          257.0 → 231.0 |   49.0 → 49.0 |   4.0 → 4.0 |
| replyVisible         | 381.1 → 352.2 |  131.0 → 119.0 |  999.0 → 878.0 |        1214.0 → 1072.0 | 199.0 → 199.0 | 18.0 → 18.0 |
| turnSettled          | 420.1 → 399.8 |  148.0 → 135.0 | 1125.0 → 986.0 |        1365.0 → 1204.0 | 216.0 → 216.0 | 21.0 → 21.0 |
| allDeliveriesSettled | 420.3 → 400.0 |  148.0 → 135.0 | 1125.0 → 986.0 |        1365.0 → 1204.0 | 216.0 → 216.0 | 21.0 → 21.0 |

No-op created → settled p50 (includes queueing): 22.0 → 20.0 ms.

**noop**

| Stage       |          ms | Owner commands |   SQL calls | SQL round trips (est.) | Host calls | Deliveries |
| ----------- | ----------: | -------------: | ----------: | ---------------------: | ---------: | ---------: |
| turnSettled | 14.1 → 14.9 |      6.0 → 6.0 | 37.0 → 34.0 |            49.0 → 46.0 |  4.0 → 4.0 |  1.0 → 1.0 |

No-op created → settled p50 (includes queueing): 6.0 → 7.0 ms.

Idle commands/s: 0.0 → 0.0. Idle SQL calls: 0.0 → 0.0.

### PGlite

Backend: pglite. Cells show before → after; cumulative medians from send, five
samples by default. SQL round trips include estimated transaction boundaries.

**plain**

| Stage                |            ms | Owner commands |     SQL calls | SQL round trips (est.) |  Host calls |  Deliveries |
| -------------------- | ------------: | -------------: | ------------: | ---------------------: | ----------: | ----------: |
| sendAccepted         |     6.0 → 6.0 |      1.0 → 1.0 |     5.0 → 5.0 |              7.0 → 7.0 |   0.0 → 0.0 |   1.0 → 1.0 |
| messageVisible       |   33.0 → 32.8 |      4.0 → 4.0 |   32.0 → 32.0 |            40.0 → 40.0 | 10.0 → 10.0 |   1.0 → 1.0 |
| modelStarted         | 130.5 → 128.1 |    25.0 → 23.0 | 208.0 → 184.0 |          248.0 → 222.0 | 49.0 → 49.0 |   4.0 → 4.0 |
| replyVisible         | 254.0 → 268.8 |    46.0 → 44.0 | 383.0 → 348.0 |          461.0 → 424.0 | 75.0 → 75.0 |   7.0 → 7.0 |
| turnSettled          | 339.8 → 338.9 |    63.0 → 60.0 | 506.0 → 455.0 |          612.0 → 557.0 | 92.0 → 92.0 | 10.0 → 10.0 |
| allDeliveriesSettled | 340.0 → 339.2 |    63.0 → 60.0 | 506.0 → 455.0 |          612.0 → 557.0 | 92.0 → 92.0 | 10.0 → 10.0 |

No-op created → settled p50 (includes queueing): 40.0 → 40.0 ms.

**tool**

| Stage                |            ms | Owner commands |      SQL calls | SQL round trips (est.) |    Host calls |  Deliveries |
| -------------------- | ------------: | -------------: | -------------: | ---------------------: | ------------: | ----------: |
| sendAccepted         |     5.1 → 5.8 |      1.0 → 1.0 |      5.0 → 5.0 |              7.0 → 7.0 |     0.0 → 0.0 |   1.0 → 1.0 |
| messageVisible       |   29.2 → 32.0 |      4.0 → 4.0 |    32.0 → 32.0 |            40.0 → 40.0 |   10.0 → 10.0 |   1.0 → 1.0 |
| modelStarted         | 113.9 → 119.6 |    25.0 → 23.0 |  206.0 → 185.0 |          250.0 → 225.0 |   49.0 → 49.0 |   4.0 → 4.0 |
| replyVisible         | 590.8 → 578.1 |  125.0 → 115.0 |  955.0 → 848.0 |        1171.0 → 1045.0 | 199.0 → 199.0 | 18.0 → 18.0 |
| turnSettled          | 655.8 → 638.9 |  142.0 → 131.0 | 1080.0 → 955.0 |        1324.0 → 1178.0 | 216.0 → 216.0 | 21.0 → 21.0 |
| allDeliveriesSettled | 656.1 → 639.1 |  142.0 → 131.0 | 1080.0 → 955.0 |        1324.0 → 1178.0 | 216.0 → 216.0 | 21.0 → 21.0 |

No-op created → settled p50 (includes queueing): 33.0 → 33.0 ms.

**noop**

| Stage       |          ms | Owner commands |   SQL calls | SQL round trips (est.) | Host calls | Deliveries |
| ----------- | ----------: | -------------: | ----------: | ---------------------: | ---------: | ---------: |
| turnSettled | 19.9 → 21.1 |      5.0 → 5.0 | 31.0 → 28.0 |            41.0 → 38.0 |  4.0 → 4.0 |  1.0 → 1.0 |

No-op created → settled p50 (includes queueing): 7.0 → 7.0 ms.

Idle commands/s: 0.0 → 0.0. Idle SQL calls: 0.0 → 0.0.

## Changes and attribution

1. **Delivery/deadline SQL fusion.** Claim updates the delivery and deadline in
   one statement using `UPDATE ... RETURNING`, preserving PostgreSQL's CTE
   snapshot rules. Settlement combines delivery-deadline synchronization,
   namespace lookup and reconciliation-deadline insertion. Each delivery wake
   acknowledges its selected revisions with one array statement. Owner fencing,
   lease checks, captured command time, revision comparison and rollback remain
   in place. The PostgreSQL delivery-only ablation removes 37 SQL calls per
   plain turn and 68 per tool turn; isolated no-op SQL falls 37 → 34. PGlite
   isolated no-op SQL falls 31 → 28.
2. **One command for a primitive authorized read.** Read and final descendant
   disclosure checks share one fenced command when no selector I/O intervenes.
   Named selectors retain the fresh outer disclosure command. The matched last
   samples remove three `collections.disclose` commands per plain turn and
   eleven per tool turn. Against the PostgreSQL delivery-only ablation, final
   medians fall 487 → 470 SQL calls for plain turns and 1,057 → 986 for tool
   turns; total commands fall 65 → 62 and 148 → 135. The extra command variation
   includes alarm scheduling; it is not all attributable to read commands. Tests
   cover result refusal, selector revocation and independent publication
   authority.
3. **Single-connection PostgreSQL snapshots.** Managed `pgPoolMax: 1` selects
   the existing fenced owner-command snapshot path. Ominipg 0.10.1's native
   PostgreSQL snapshot reserves a reader/current pair and refuses capacity below
   two. This compatibility prerequisite is held constant in the PostgreSQL
   performance comparison. Snapshot consistency while a writer queues passes on
   both backends. Custom providers/background sync retain native admission
   checks. The benchmark's instrumentation preserves the private snapshot
   marker.

Five-sample PostgreSQL ablation, cumulative settlement medians (separate runs;
timing differences are not additive causal estimates):

| Scenario                 | Baseline commands / SQL / ms | Delivery changes only | Both performance changes |
| ------------------------ | ---------------------------: | --------------------: | -----------------------: |
| Plain                    |             65 / 524 / 196.0 |      65 / 487 / 205.7 |         62 / 470 / 196.9 |
| Tool                     |          148 / 1,125 / 420.1 |   148 / 1,057 / 416.2 |        135 / 986 / 399.8 |
| Isolated no-op operation |                6 / 37 / 14.1 |         6 / 34 / 13.8 |            6 / 34 / 14.9 |

Earlier PGlite ablations are retained externally: delivery SQL changed
plain/tool SQL 508 → 471 and 1,085 → 1,011; primitive reads then reduced tool
SQL to 955 and commands 142 → 131. Those earlier runs preceded the
instrumentation marker correction; the final matched tables above supersede
their timing comparisons.

Existing group commit was retained. It amortizes fencing/commit across queued
work, but sequential awaited operations cannot join a transaction that already
committed. There is no added coalescing delay, writer, pool capacity, runtime
variant or production feature flag. Provider effect begin/confirm, checkpointed
completions and receipt replay are unchanged.

The final PostgreSQL plain turn still uses about **62 commands, 470 SQL calls,
92 host calls and 10 deliveries**. Nine ordinary claims and settlements
accompany the inline ingress relay. The isolated no-op uses six commands:
append, observation attachment, claim, settlement, operation reconciliation and
deadline acknowledgment. Its delivery is 7 ms; in a plain turn the no-op
processor's created-to-settled p50 is 25 ms including queueing. PGlite
equivalents are 7 and 40 ms.

The last PostgreSQL plain sample attributes 50 SQL calls to fencing, 41 to
owner-alarm refresh, 19 to delivery-row reads, 21 to logical-body/copy lookups
and 18 to the main operation-completion candidate query. These are individual
histogram counts, not medians. There are also 23 SAVEPOINT/RELEASE pairs from
grouped commands. Repeated database work between awaited capability operations
remains the main fixed cost; reducing it further needs larger atomic stage
commands while preserving durable provider completion and fresh authorization
boundaries.

The worker's `next` timeout is 10 seconds, but invocation/terminal notifications
resolve it immediately. Operation settlement uses an event watch with a 250-ms
fallback poll. No measured fixed polling delay justifies shortening either
interval. The unchanged 92/216 host calls and 10/21 deliveries remain
substantial costs. No retirement loop appeared in any of the four 30-second
matched idle windows: all recorded zero commands and SQL.

## CPU and progressive frames

`final-postgres.cpuprofile` contains 3,386 samples over 4.86 seconds, including
startup, seeding, verification and shutdown. Weighted self samples are **56.78%
idle, 8.57% runtime source, 4.57% Ominipg, 1.22% PostgreSQL driver and 1.96%
GC**. Worker capability `request` accounts for 1.00% inclusive sampled stacks.
This is an application CPU profile, not PostgreSQL server profiling: idle
includes asynchronous database wait. Combined with 572/1,204 estimated round
trips per plain/tool turn, it points to sequential round trips as the remaining
latency amplifier; it does not quantify performance under CPU load.

`final-pglite.cpuprofile` (in the external results directory) contains 5,268
samples over 7.48 seconds, including startup, seeding, verification,
serialization and shutdown. Weighted self samples: **39.62% WASM, 22.58% PGlite
JavaScript, 6.69% runtime source, 5.91% idle, 1.73% GC**. Worker capability
`request` accounts for 0.65% inclusive sampled stacks; encoding and decoding are
spread across multiple frames. Inclusive shares overlap and do not measure async
round-trip wait. This profile cannot characterize PostgreSQL server CPU or the
app’s 15–20 seconds of platform delay under load.

A separate one-sample progressive-output diagnostic compared 1 and 32 frames.
Both used **72 commands and 97 host calls** for the cold plain turn, and **141
commands and 221 host calls** for the tool turn. Plain SQL was 561/563 and tool
SQL 1,052/1,052; timings were 443/461 ms and 766/794 ms. Both used four body CAS
commands. Existing LLM batching (16 KiB or 50 ms) already prevents one write per
burst token. This does not establish the cost of tokens arriving slowly over a
real network. Stream opening/sealing/retention still adds fixed work; it was not
changed.

Profile reproduction:

```sh
nice -n 10 deno run -A --cpu-prof --cpu-prof-dir=/tmp --cpu-prof-name=turn.cpuprofile scripts/benchmark-turn.ts --backend=pglite --n=5 --idle-ms=0 --out=/tmp/turn-profile.json
nice -n 10 deno run -A scripts/benchmark-turn.ts --backend=pglite --n=1 --chunks=32 --idle-ms=0 --out=/tmp/turn-stream.json
```

## Validation and remaining work

PGlite delivery-store tests (26 passed, one PostgreSQL case initially skipped),
alarm lifecycle/race tests, deadline rollback/revision/key tests, authorization
conformance, collection reads, group commit, primitive-read/selector revocation
and single-connection snapshot consistency passed. The full composition
benchmark validates plain/tool turns and live subscribers on both backends.

With the PostgreSQL URL set, the targeted batch passed 44 tests and initially
failed one assertion expecting the deliberately removed duplicate result-policy
check. That expectation was updated; all seven async-context isolation tests
then passed. The PostgreSQL durable-deadline recovery test also passed. Coverage
includes lease expiry at captured command time, stale ownership, atomic
rollback, revision re-arm, fresh selector authorization, independent publication
identity, snapshot consistency and group-commit rollback/replay. No full suite
was run.

`deno task check`, explicit type checks, changed-file `deno lint` and
`deno fmt --check` passed. Logs, source snapshots, CPU profiles and full raw
results are retained in the external results directory. The temporary validation
database was dropped.

| Target                          | PostgreSQL after | PGlite after |
| ------------------------------- | ---------------: | -----------: |
| Send → first model p50 <150 ms  |          84.6 ms |     128.1 ms |
| Plain turn platform p50 <300 ms |         196.9 ms |     338.9 ms |
| Isolated no-op delivery <20 ms  |             7 ms |         7 ms |
| Idle owner commands ≈0/s        |      0 over 30 s |  0 over 30 s |

**Remaining:** queued no-op deliveries during plain turns are 25 ms on
PostgreSQL and 40 ms on PGlite, above 20 ms. The isolated PostgreSQL targets
pass, but this does not explain away the real app's seconds of delay: these
fresh schemas avoid the CONTENT retirement bug, and CPU-loaded PostgreSQL, slow
streaming, external channel sends and active memory-consolidation model calls
remain unmeasured. No target is claimed impossible under the constraints. The
next performance work is reducing the unchanged capability/delivery counts and
common fencing/alarm SQL through broader atomic commands, with recovery and
authorization tests; removing those checks outright would break the stated
guarantees.

Targeted PostgreSQL rerun against a fresh disposable `perf_*` database, one
command at a time:

```sh
COPILOTZ_TEST_POSTGRES_URL=postgres://postgres@localhost:55437/perf_validation nice -n 10 deno test -A runtime/engine/deadline-batch.test.ts runtime/events/delivery-deadline-transition.test.ts runtime/collections/read-command.test.ts runtime/persistence/single-connection-snapshot.test.ts runtime/engine/group-commit.test.ts runtime/events/command-clock.postgres.test.ts runtime/collections/policy-command-lifetime.postgres.test.ts runtime/engine/queued-async-context-isolation.postgres.test.ts runtime/authorization/conformance.test.ts runtime/collections/reads.test.ts
```

Production files changed: `runtime/events/store.ts`, `runtime/engine/alarms.ts`,
`runtime/execution/alarms.ts`, `runtime/collections/kernel.ts`,
`runtime/persistence/ominipg.ts`.

New tests: `runtime/engine/deadline-batch.test.ts`,
`runtime/events/delivery-deadline-transition.test.ts`,
`runtime/collections/read-command.test.ts`,
`runtime/persistence/single-connection-snapshot.test.ts`. Updated
`runtime/engine/queued-async-context-isolation.postgres.test.ts` to expect one
result check for a primitive read.

Also added `scripts/benchmark-turn.ts`, `scripts/report-turn.ts`, this report
and five compact JSON results under `(local results, not committed)`.
`runtime/content/catalog.ts` and the retirement loop in `database-repository.ts`
were not edited.
