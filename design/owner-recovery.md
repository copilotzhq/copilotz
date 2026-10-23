# Recovery after owner fencing

## Current behavior

The SQL owner is an epoch fence, not a timed lease:
`runtime/engine/commands.ts:360` checks holder and epoch once per command group;
`:475` increments the epoch only during explicit acquisition. CPU starvation
alone cannot expire that row. The reported Hypervisor work failure wraps this
SQL refusal; it does not establish which acquisition advanced the row.

A failed fence stops admission, aborts capabilities and cancels alarms
(`commands.ts:301`). Collection subscriptions reset on that signal
(`runtime/subscriptions/owner.ts:244`); operation push followers reset too
(`runtime/events/push.ts:107`). Application sends are interrupted only by
persistence recovery or shutdown (`runtime/application/application.ts:476,867`).
Engine replacement exists in `application.ts:872`, but only database reconnect
notifications invoke it automatically (`application.ts:52`). Ownership loss is
intentionally not a database connection failure
(`runtime/persistence/lifecycle.ts:217`). A healthy connection therefore leaves
the application attached to a permanently stopped graph.

There are separate timed leases: delivery claims default to 120 seconds
(`runtime/execution/workload.ts:19`) and Oxian worker sessions default to a
10-second heartbeat and 30-second timeout (linked Oxian
`src/hypervisor/config.ts`). In-process workers do not expire by heartbeat in
the linked 0.23.1 source (`src/supervisor/sessions.ts:155`); WebSocket workers
do. Neither is the SQL owner epoch. Worker reconnect uses exponential delay
starting at 250 milliseconds, capped at 30 seconds
(`src/worker/session.ts:300`).

## Target and guarantees

An application observes genuine ownership loss at the owner abort boundary,
interrupts waiting sends immediately, and schedules one independent replacement
of its engine and opened scopes. It uses the existing activation, capability
installation and retained-work recovery sequence. Captured old repositories and
capabilities remain revoked; requests are never replayed by this mechanism.
Database reconnect remains responsible for connection failures.

Admission waits for replacement with a finite budget (the configured recovery
wait, default two seconds), then returns a retryable 503. Failed replacement is
observable and a later request can initiate another attempt; there is no polling
loop or lease-renewal timer. Shutdown suppresses replacement and drains all
retired engines. Replacement failures must not recursively restart themselves.

The host is responsible for selecting the application that should serve a
schema. This change does not implement distributed leader election: two
independent live hosts must not repeatedly assert ownership of the same schema.
Automatic recovery must not silently retarget an already issued capability.

## Public surface and deletions

No new public factory or opt-in mode. Existing recovery wait configuration also
bounds owner replacement admission. Ownership loss and owner recovery errors
carry retryable 503 metadata. Remove the assumption that only persistence
failure can replace an owner. Preserve round-one drain and round-two instance
identity.

## Tests

Use both actual SQL backends. Advance the durable fence while an application has
pending work, a collection subscription and an operation observer. Assert the
old work terminates or returns retryable failure, old authority stays revoked,
and new commands, subscriptions and observes work within a watchdog bound.
Exercise failed/blocked replacement, concurrent admission, multiple scopes,
shutdown, and connection recovery without recursive replacement.

Separately exercise shortened transport lease expiry under a deterministic event
loop stall. Assert the transport reconnects and commands resume; do not confuse
transport identity epochs with the SQL owner epoch. No sleeps in production. Run
targeted suites, full PGlite and PostgreSQL suites, check, format, lint delta
and complete type guard. Document production timing guidance and evidence
limits.
