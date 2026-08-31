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
  operationId: string;
  eventId: string;
  correlationId: string;
  replayCursor: string;
  outputs: ReadableStream<ApplicationOutput>;
  done: Promise<void>;
  detach(reason?: string): Promise<void>;
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

Recovery ownership, leasing, and dead-letter retry/discard remain runtime/host
authorities. Public `maintenance()` exposes only bounded safe maintenance, and
the operation APIs expose status, reconnect, and explicit durable cancellation;
they do not expose delivery mutation.

Copilotz-owned persistence reconnects, revalidates every opened v4 schema, and
recovers durable obligations. It never replays the indeterminate SQL operation
that detected the outage. Active `send` handles reject so callers receive an
honest boundary; durable work remains recoverable and is not falsely marked
cancelled.

Embeddings that need operational inspection use the trusted Gateway `/v3` server
boundary or their own internal persistence tooling rather than exposing delivery
mutation to ordinary application code.

## Additive reconnect catalog provisioning

Reconnect metadata is stored in additive operational tables; it does not change
the immutable Core Event schema v4 marker. Normal engine startup provisions both
v4 and the operation catalog. Hosts that set
`provisionDefaultDatabaseSchema: false` must provision the catalog explicitly,
once per physical tenant schema, before starting the new runtime:

```ts
import { provisionOperationCatalog } from "@copilotz/copilotz/streams";

await provisionOperationCatalog(sqlSession, databaseSchema);
```

Tenant selection on the request path only validates these tables and never runs
DDL. Therefore multi-schema hosts should apply the additive provisioning step as
a deployment migration before routing traffic to a 0.64 runtime. Missing tables
fail startup/scope opening with `copilotz_operation_catalog_not_provisioned`;
existing v4 Events and deliveries remain unchanged.

Replay cursors use a per-operation stream high-watermark plus sparse byte
offsets for lanes that are still incomplete. Sequential completed lanes remain
constant-size even for deep multi-agent runs. The current cursor envelope is
bounded to 256 simultaneous sparse lanes/operations and 16 KiB before base64url
encoding. A checkpoint/history request that exceeds that active window returns
`409 operation_replay_capacity_exceeded`; an already-open feed emits the same
condition as a `replay.capacity` frame, detaches the observer without cancelling
the durable operation, and closes normally. Clients should refresh canonical
history and retry until enough lanes have sealed for the checkpoint to compact.
