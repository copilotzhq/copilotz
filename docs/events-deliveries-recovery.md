# Events, Deliveries, and Recovery

Copilotz persists facts and work obligations separately.

## Immutable facts

A durable Event has a database-assigned monotonic position, namespace, type,
optional subject/thread/routing/visibility, causation, correlation,
deduplication identity, and optional Event Body reference. Event Bodies contain
the complete data required to replay Collection mutations and Action lifecycle
facts.

Common facts are:

- `<collection>.created|updated|deleted|command`;
- `relation.upserted|deleted`;
- `asset.created|deleted`;
- `<actionId>.invoked|progress|completed|failed|cancelled`.

Events and Event Bodies are immutable. They are also retry receipts and replay
sources, so ordinary maintenance never compacts them.

## Sparse durable work

A delivery is one obligation for `(eventId, consumerId)`. Rows exist only for
matched durable Processors. Observation visibility, participants, and transient
stream subscribers do not create work rows.

Delivery states are `pending`, `leased`, `retry_wait`, `succeeded`, `cancelled`,
and `dead_letter`. Execution is at least once: an expired lease or retryable
failure may run the same logical delivery again. The Gateway requeues a failed
delivery at its persisted `availableAt` until it succeeds or exhausts its
bounded attempts. Unknown errors are retryable by default. A Processor can
classify a deterministic failure with `markNonRetryable(error)`; that delivery
dead-letters on its current attempt, so an inherited `send().done` rejects
without a pointless retry. Collection schema-validation errors carry this
classification automatically.

Stable Collection operation keys and Action invocation identities are therefore
part of plugin correctness. On retry, built-in mutations and Actions first load
their authenticated durable result instead of repeating a settled effect.

## Settlement scopes

`application.send(input)` creates an explicit settlement scope and returns:

```ts
type ApplicationSendHandle = Readonly<{
  eventId: string;
  correlationId: string;
  outputs: ReadableStream<ApplicationOutput>;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;
```

Matched Processors inherit the triggering scope by default. A Processor with
`settlement: "detached"` creates durable background work whose completion and
failure do not block the foreground handle. Causation still points to the
originating Event.

For remote Workers, `done` also waits for output frames already in flight and
then verifies the durable scope again. This prevents a final output from racing
operation settlement.

## Recovery ownership

Recovery, leasing, dead-letter retry/discard, and delivery compaction are
runtime/host authorities, not methods on the public application. The public
surface remains `{ send, observe, close }`.

Copilotz-owned persistence reconnects, revalidates every opened v4 schema, and
recovers durable obligations. It never replays the indeterminate SQL operation
that detected the outage. Active `send` handles reject so callers receive an
honest boundary; durable work remains recoverable and is not falsely marked
cancelled.

Embeddings that need operational inspection use the trusted Gateway `/v3` server
boundary or their own internal persistence tooling rather than exposing delivery
mutation to ordinary application code.
