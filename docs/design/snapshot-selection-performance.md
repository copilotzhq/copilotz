# Snapshot selection: initial latency diagnostic

Measured 18 October 2026. This measures the current Copilotz selection path,
including authorization and transport, not the database snapshot mechanism
alone. It is **not production-load acceptance**.

## Result and recommendation

Snapshots cost more in all measured cases. Keep them explicit for selections
whose multiple reads must agree. Use ordinary reads for independent lookups and
prefer one bounded query when that expresses the required selection. Finish
snapshot selection before provider calls or other slow application work.

For ten reads, measured median overhead ranged from approximately 117ms to 314ms
across these configurations. A single worker read added about 200ms in the
combined path, which includes additional resource open/close protocol and read
authorization. This is a combined-path observation, not a causal allocation of
all overhead to network or SQL.

## Median selection time, milliseconds

| Backend    | Placement   | Sequential reads | Ordinary | Snapshot | Difference |
| ---------- | ----------- | ---------------: | -------: | -------: | ---------: |
| PostgreSQL | owner-local |                1 |     49.5 |     95.6 |       46.0 |
| PostgreSQL | owner-local |                5 |    237.4 |    347.6 |      110.2 |
| PostgreSQL | owner-local |               10 |    478.6 |    732.0 |      253.4 |
| PostgreSQL | worker      |                1 |    141.6 |    343.4 |      201.9 |
| PostgreSQL | worker      |                5 |    671.3 |    925.9 |      254.6 |
| PostgreSQL | worker      |               10 |   1388.5 |   1702.3 |      313.8 |
| PGlite     | owner-local |                1 |     68.9 |    120.1 |       51.3 |
| PGlite     | owner-local |                5 |    344.8 |    441.7 |       96.9 |
| PGlite     | owner-local |               10 |    647.7 |    764.5 |      116.8 |
| PGlite     | worker      |                1 |    164.6 |    372.2 |      207.6 |
| PGlite     | worker      |                5 |    801.0 |   1034.7 |      233.7 |
| PGlite     | worker      |               10 |   1594.7 |   1848.2 |      253.5 |

Worker transport is **same-host loopback WebSocket**. Owner-local execution uses
the in-process fixture. The row is deliberately small and the same row is read
repeatedly; this is a warm one-row diagnostic, not a realistic multi-table data
workload.

## Method and boundaries

- Actual PostgreSQL 17.11 with pgvector 0.8.0 and an existing pool capped at 4;
  native PGlite reports PostgreSQL 17.5/wasm32 and uses its low-memory profile
- Deno 2.9.2; reviewed source-mapped Copilotz, Ominipg and Oxian draft code,
  identified in the [sample data](snapshot-selection-latency.json)
- Four cases: each backend × owner-local or worker; one active invocation
- For each 1/5/10-read group, two warmup selections per strategy, followed by
  ten samples per strategy, alternating which strategy runs first
- 240 timed selections and 48 warmups in total; each gets a fresh invocation so
  the existing 100-call lifetime budget is respected
- Timing starts inside the Action before selection and ends after its reads;
  snapshot timing includes open/read/close. Startup, outer Action dispatch,
  result polling, settlement and teardown are excluded from reported samples
- Ordinary and historical snapshot policies both allow the same row. Every read
  asserts its expected value. There are no concurrent writers or provider calls
- Conventional medians average the two central samples. The raw harness logged
  the upper-middle order statistic; committed data preserves that value
  separately and recomputes reported medians from the retained samples

The four final cases passed with normal typechecking. Two disposable PostgreSQL
fixture databases and the coordinator were exported and dropped, no sessions or
fixture leftovers remained, and the service stopped.

## Preserved setup failures and corrections

Earlier harness runs remain failed evidence. An input-type mismatch and an
invalid outer wait capacity were corrected before usable measurements. A longer
run encountered the short fixture credential's intended rotation: 60s validity
minus 30s rotation skew, with reconnection disabled. Disconnect logs explicitly
reported `resume_rotation` while the host stayed healthy. The steady-state
fixture now uses bounded 600s fake credentials; it does not change heartbeat,
call, query, snapshot or test timeouts or enable reconnection.

A 20-sample workload completed the owner-local cases but exceeded the 180s
whole-test budget for worker cases. The final complete run uses ten samples and
two warmups, retaining that budget. It must not be described as a complete
20-sample matrix. Earlier rounded local-only figures were preliminary.

## Still unmeasured

Placement and transport vary together in these fixtures; their separate costs
cannot be inferred. Processor performance was not measured. With ten samples,
the logged nearest-rank p95 is simply the maximum, not strong tail-latency
evidence.

No throughput, CPU/memory, pool-contention, concurrent-read/write or
cloud-network claim follows from these numbers. PostgreSQL reserves two
existing-pool connections for this private snapshot design. PGlite owns its
single engine exclusively while the scope remains open. Those capacity effects
need separate load tests, including callback duration and current-authority
contention.

Public composition, timeout defaults and production-load acceptance remain open.
The results support short opt-in consistency scopes; they do not establish that
all application reads should acquire snapshots.
