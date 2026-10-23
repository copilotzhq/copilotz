---
title: "Owner Recovery"
description: "How a running application replaces a fenced database owner, what callers see while it recovers, and lease timing for loaded hosts."
section: Runtime
order: 45
status: stable
---

# Owner recovery and loaded hosts

A running application replaces a fenced database owner automatically. It revokes
old capabilities, resets subscriptions and operation observations, interrupts
pending send waiters, and activates a new owner for every opened database scope.
The database connection need not fail for this recovery to run. New requests
share one replacement attempt; they wait at most `databaseRecovery.waitMs`
(default 2,000 milliseconds) before receiving a retryable HTTP 503.

`ActionOwnershipLost` identifies the failed authority. `owner_unavailable`
identifies admission that could not wait for replacement. Both carry
`Retry-After`. Retry through the application's current entrypoint; do not reuse
captured repositories or capabilities from the old owner. For writes, retain the
original idempotency key: interruption is not evidence that a prior write did
not commit. Recovery does not automatically replay an HTTP request or host call.

Collection subscribers receive a reset and must subscribe again. Operation
observers receive `observation_reset_required` and should attach again using the
last applied replay cursor. Existing retained data and command receipts survive
replacement. A failed activation leaves admission unavailable; a later request
can initiate a new attempt. There is no background retry or epoch-fencing loop
while activation is failing. Closing the application disables recovery and
drains both the current and retired engines.

Keep one intended serving host per schema. Owner acquisition is a fenced
compare-and-set, not distributed leader election. A deployment controller must
stop routing to a host it has deliberately replaced; independently active hosts
that continually acquire the same schema can fence each other.

## Three different lifetimes

| Lifetime              | Default                               | Meaning                                                                                                          |
| --------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Database schema owner | No wall-clock expiry                  | A newer explicit acquisition advances the SQL epoch and fences the old holder.                                   |
| Remote worker session | Heartbeat 10 s, lease 30 s, sweep 1 s | Oxian disconnects a WebSocket worker that misses its lease. Reconnect backoff starts at 250 ms and caps at 30 s. |
| Remote delivery claim | 120 s                                 | Delivery execution authority is renewed by the live worker session; expired claims are recovered.                |

The linked Oxian 0.23.1 implementation does not expire an in-process worker on a
wall-clock heartbeat deadline. Worker and host share the stalled event loop; the
transport's close signal governs that session instead. WebSocket workers remain
heartbeat-leased. Neither transport rule changes a SQL owner epoch.

The error “The owner epoch or holder is no longer current” proves a fence
mismatch, not a GC-induced lease expiry. Record the database instance, schema,
holder and epoch at acquisition, along with connection generation and worker
session identity, when investigating repeated takeovers. CPU load average alone
does not measure the duration of an event-loop pause.

## Production timing

The default 30-second remote-session lease can be too tight if a host regularly
pauses for tens of seconds. For such a host, start with the following gateway
configuration fragment and measure actual event-loop delay and reconnect time:

```ts
const timing = {
  databaseRecovery: { waitMs: 2_000, retryAfterSeconds: 1 },
  hypervisorConfig: {
    heartbeatIntervalMs: 10_000,
    leaseTimeoutMs: 90_000,
    leaseSweepIntervalMs: 1_000,
  },
  engine: { leaseMs: 180_000 },
};
```

This recommendation allows several missed heartbeats and leaves delivery-lease
headroom for a 90-second session timeout plus the maximum reconnect delay. It
trades slower failure detection for tolerance of long pauses; it is not a
measurement-derived guarantee for every host. Size the session timeout above the
observed worst pause plus heartbeat/network margin, and the delivery lease above
session timeout plus reconnect and database latency. Keep request admission
bounded independently. Leave defaults unchanged on hosts that do not show such
pauses, and reduce CPU oversubscription instead of continually extending leases.

No JavaScript timeout can fire while its event loop is stopped. Recovery and
request deadlines take effect when scheduling resumes. Tests use a controlled
clock jump past a shortened lease to exercise that boundary without a
CPU-burning loop, and separately fence a SQL owner with pending traffic. Both
run against PGlite and PostgreSQL; they assert recovery within five seconds of
resumed scheduling, pending-client settlement, and shutdown cleanup.
