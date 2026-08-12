# Events, Deliveries, and Recovery

Copilotz persists facts and work obligations separately.

## Durable events

Durable events include an ID, monotonic position, namespace, optional thread,
subject, routing/visibility, causation, correlation, deduplication ID, compact
mutation delta/reference, and creation time. They do not have processing status.

Common facts include:

- `message.created`
- `llm_attempt.created`, `llm_attempt.completed`, `llm_attempt.failed`
- `tool_execution.created`, `tool_execution.completed`, `tool_execution.failed`
- `<collection>.created`, `<collection>.updated`, `<collection>.deleted`

Ephemeral events such as `text.delta`, `reasoning.delta`, `audio.delta`, and
`tool_call.delta` are published live and never inserted into the events table.

## Durable deliveries

A delivery is one guaranteed obligation for `(eventId, consumerId)`. Its states
are `pending`, `leased`, `retry_wait`, `succeeded`, `cancelled`, and
`dead_letter`. Rows track attempts, availability, lease owner/expiry, last
error, and settlement timestamps—but never physical Oxian worker identity.

Defaults:

- lease: 120 seconds
- heartbeat: 30 seconds
- attempts: 3
- exponential jittered retry capped at 30 seconds
- settled retention: 7 days
- dead letters retained until retried or discarded

## Atomicity and idempotency

Required durable consumers are resolved before commit. A domain mutation,
immutable event, and delivery rows commit in one Ominipg transaction. A crash
after commit but before dispatch therefore leaves recoverable work.

Execution is at-least-once. Built-in projections use delivery-derived
deduplication IDs; external tools receive an idempotency key and must use it
when calling non-idempotent systems.

## Causal settlement

`run.done` and attachment send handles settle a causal tree, not every event
sharing a correlation ID. Cancellation marks unsettled work in that scope and
rejects the handle. Dead-lettered descendants also reject settlement.

For detached Workers, settlement also waits for correlated Worker output frames
already in flight. This prevents the database's final delivery update from
racing the Gateway's final semantic event. The Gateway then confirms the durable
scope again in case that event created more work.

## Operations

```ts
await app.recover({ namespace: "acme", limit: 100 });

const result = await app.maintenance({
  namespace: "acme",
  limit: 100,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
});

const dead = await app.deliveries.list({
  namespace: "acme",
  status: "dead_letter",
});
await app.deliveries.retry("acme", dead[0].id);
// Or explicitly discard it:
// await app.deliveries.discard("acme", dead[0].id);
```

Never compact pending, leased, retrying, or dead-lettered work. Long-lived
engines should schedule periodic maintenance; short-lived deployments can call
it opportunistically. Each maintenance call bounds both recovery and each
compaction phase with `limit` (default 100, capped at 1,000), so retention work
is incremental and does not turn a periodic tick into an unbounded database
transaction.

Detailed contract: [events and deliveries](v3/events-and-deliveries.md).
