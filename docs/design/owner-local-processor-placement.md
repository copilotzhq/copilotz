# Private local Processor generation ledger

This internal controller records same-owner attempt generations. The private
[host composition](owner-host-local-processor.md) now wires it into actual local
execution. The controller itself does not schedule retries or authorize public
local placement.

## Admission and retirement

A first reservation receives ordinal one. A successor requires a known
`retry_wait` receipt, permanent predecessor revocation, actual driver
quiescence, and successful shared-capacity release. Its binding preserves all
coordinates except a fresh attempt ID. Attempt IDs and generation tombstones
remain bounded and cannot be reused across deliveries. Unknown outcomes retain
capacity and cannot justify successor admission.

Start authorization requires an outstanding private submission, the exact
caller, binding and ordinal, and the real start transaction's closed delivery
facts. Successors additionally require a trusted bounded predecessor-assignment
retirement check in that transaction. The future host must implement that check
against the exact row with `FOR UPDATE`; the pure controller supplies no SQL.
After an awaited proof, the controller rechecks lifetime and submission facts.
Retry timestamps remain lossless strings. Actual SQL determines whether work is
due; the ledger does not substitute JavaScript millisecond comparisons.

Current resolution opens only after a known start receipt. NULL-lease alarm
classification requires an authenticated command context and exact persisted
assignment, delivery, source and attempt facts. A reservation alone is not live
authority. Policy grants remain the host's responsibility.

## Capacity and callbacks

The shared capacity reservation is released once, only after the known end and
actual driver quiescence. Its release method is captured once. Owner-current and
release callbacks may reenter: entry lifetime is rechecked after callbacks, and
quarantine or owner shutdown suppresses the release notification.

The `released` promise is a detached wake hint. It does not authorize a retry,
prove due time or count as active work for shutdown. Unknown/quarantined entries
may leave it unresolved. The host must check current owner and latest-generation
identity before using it to request a durable alarm scan.

## Evidence and open gate

Nineteen checked tests cover reservation/ordinal bounds, exact start witnesses,
retirement checks, stale callers, NULL leases, unknown outcomes, shared
capacity, reentrant callbacks and held start replies. Three tests compose the
real neutral driver and bound port with a data-only boundary double; they are
not SQL or production-host integration tests. The controller has also passed
independent review with the adjacent 144-case pure compatibility suite.

Four additional reviewer regressions were reproduced by reconstructing the
observed earlier callback blocks; they are explicitly reconstructed causal
checks, not an archived committed baseline. Actual host composition, SQL
predecessor retirement, retry alarms, mixed capacity and shutdown integration
now have their own scoped host evidence. Caller-facing reply and full-host
precision probes are also independently verified with that composition.
