# Events, Deliveries, and Recovery

Copilotz persists facts and work obligations separately.

## Durable events

Durable events include an ID, monotonic position, namespace, optional thread,
subject, routing/visibility, causation, correlation, deduplication ID, compact
mutation delta/reference, and creation time. They do not have processing status.

Common facts include:

- `message.created`
- `<actionId>.invoked|progress|completed|failed|cancelled`
- `<collection>.created`, `<collection>.updated`, `<collection>.deleted`

Runtime-native stream output is published live and never inserted into the
events table. It carries ordered bytes through logical lanes such as content,
reasoning, tool calls, stdout, stderr, progress, and result. The corresponding
Action lifecycle owns durable execution settlement; final values and semantic
messages remain asset-backed durable content.

## Durable deliveries

A delivery is one guaranteed obligation for `(eventId, consumerId)`. Its states
are `pending`, `leased`, `retry_wait`, `succeeded`, `cancelled`, and
`dead_letter`. Rows track attempts, availability, lease owner/expiry, last
error, and settlement timestamps—but never physical Oxian worker identity. Each
delivery also owns a `settlementScopeId`, independently of the event's causation
and correlation metadata.

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

## Explicit settlement scopes

Application `send(...).done` waits for deliveries in its explicit settlement
scope, not every causally related event or every event sharing a correlation ID.
Durable processor work inherits its triggering scope by default. A processor can
declare `settlement: "detached"` to fork a durable, recoverable scope whose
completion and failure do not block the caller.

Causation remains unchanged across a detached boundary, so provenance and
debugging still lead back to the triggering message. Descendant mutations
automatically inherit the executing delivery's scope. Cancellation marks only
unsettled deliveries in the selected scope; dead letters reject only handles
waiting for that same scope.

For remote Workers, settlement also waits for Worker output frames already in
flight in the same settlement scope. This prevents the database's final delivery
update from racing the Gateway's final semantic event without making detached
work block the foreground handle. The Gateway then confirms the durable scope
again in case that event created more work.

## Operations

```ts
await app.recover({ namespace: "acme", limit: 100 });

// All physical database scopes already opened by this application:
await app.recoverAll({ limit: 100 });

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

Copilotz-owned database connections also trigger `recoverAll()` automatically
after a successful reconnect. This rediscovers durable obligations; it never
replays the in-flight operation that detected the connection loss.
