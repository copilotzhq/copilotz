# Database and recovery

Each tenant PostgreSQL schema has four Copilotz tables:

| Table              | Role                                       |
| ------------------ | ------------------------------------------ |
| `nodes`            | Native and custom collection records       |
| `edges`            | Graph relationships and thread membership  |
| `events`           | Immutable, positioned semantic facts       |
| `event_deliveries` | Sparse mutable guaranteed-work obligations |

Thread, participant, message, LLM attempt, and tool execution records are graph
nodes. Thread participation, parentage, authorship, addressing, attempts, and
executions are edges. There is no physical thread table.

## Atomic mutation rule

A collection or typed domain operation performs one Ominipg transaction:

1. apply graph writes;
2. insert the immutable event;
3. insert unique `(event_id, consumer_id)` delivery rows selected by the plugin
   registry;
4. update thread activity metadata when the event is thread-scoped;
5. commit.

Only after commit does Copilotz publish and dispatch. A crash after commit and
before dispatch is therefore a recovery case, not data loss.

## Delivery lifecycle

Statuses are `pending`, `leased`, `retry_wait`, `succeeded`, `cancelled`, and
`dead_letter`. The defaults are:

- 120-second lease;
- 30-second heartbeat;
- three attempts;
- exponential jittered retry capped at 30 seconds.

Expired leases and due retries are recoverable. `run.done` and stream-handle
`done` settle when their correlation scope has no open deliveries; they reject
for cancellation or dead-lettered work.

```ts
const delivery = await copilotz.deliveries.get(id);
await copilotz.deliveries.retry(id); // dead_letter -> pending
await copilotz.deliveries.discard(id); // dead_letter -> cancelled
await copilotz.maintenance();
```

## Retention

By default, fully settled events and deliveries are compacted after seven days.
Pending, leased, retrying, or dead-lettered work is never compacted. Configure
`maintenance.retentionMs`, use `null` for indefinite retention, disable periodic
maintenance in short-lived runtimes, and call `maintenance()` explicitly at a
safe lifecycle point.

Namespace isolation is enforced in every graph/event query. PostgreSQL schema
selection is engine-scoped; create or inject an engine for each active schema
and use `copilotz.schema.provision()` for additional v2 baselines.
