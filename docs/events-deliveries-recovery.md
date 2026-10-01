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

A `detached` Processor's failure does not reach the operation that triggered it,
so nothing reports it unless you ask. See
[Seeing why a Processor failed](#seeing-why-a-processor-failed) to log it.

## Seeing why a Processor failed

`onDeliveryDiagnostic` is an opt-in, process-local observer of delivery timing
(`createCopilotz`, `createCopilotzGateway`, and `createCopilotzWorker` all take
it). When a Processor throws, its `worker_handler_settled` diagnostic carries
the delivery's new `status` (`retry_wait` while attempts remain, then
`dead_letter`) and an `error`:

```ts
const app = await createCopilotz({
  plugins,
  onDeliveryDiagnostic(diagnostic) {
    if (diagnostic.phase === "worker_handler_settled" && diagnostic.error) {
      console.error(
        `processor ${diagnostic.consumerId} ${diagnostic.status}:`,
        `${diagnostic.error.name}: ${diagnostic.error.message}`,
      );
    }
  },
});
```

`error` is `{ name, message }` and nothing else: the message is cut to 500
characters, common credential shapes (bearer tokens, `key=value` and JSON
credential fields, URL passwords, JWTs, well-known API key prefixes) are masked,
and the stack, the `cause`, and the Event being handled are never included. A
Processor is not schema-marked the way an Action is, so the runtime cannot know
which of its values are secret; masking is a best-effort courtesy, not a
guarantee. Do not put secrets in error messages, and throw your own safe message
where an underlying error might echo request data. The diagnostic is never
persisted and a sink that throws cannot affect delivery.

The full, unmasked error (including its stack) is stored on the delivery row's
`last_error`, in your own database.

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

Copilotz-owned persistence reconnects, revalidates every opened v5 schema, and
recovers durable obligations. It never replays the indeterminate SQL operation
that detected the outage. Active `send` handles reject so callers receive an
honest boundary; durable work remains recoverable and is not falsely marked
cancelled.

Embeddings that need operational inspection use the trusted Gateway `/v3` server
boundary or their own internal persistence tooling rather than exposing delivery
mutation to ordinary application code.

## Additive reconnect catalog provisioning

Reconnect metadata is stored in operational tables alongside the Core Event
schema. The current runtime requires a validated v5 schema. Normal engine
startup provisions a fresh schema and its operation catalog, and rejects an
incompatible existing schema. This release provides no data migration.

Hosts that set `provisionDefaultDatabaseSchema: false` must provision both the
v5 schema and the catalog before startup. After provisioning the schema, add the
catalog once per physical tenant schema:

```ts
import { provisionOperationCatalog } from "@copilotz/copilotz/streams";

await provisionOperationCatalog(sqlSession, databaseSchema);
```

Tenant selection on the request path only validates these tables and never runs
DDL. Multi-schema hosts must provision each schema before routing traffic to it.
Missing catalog tables fail startup/scope opening with
`copilotz_operation_catalog_not_provisioned`. Adding the catalog does not
migrate a schema from an earlier release.

Operation metadata queries use the runtime's existing generic indexes, including
`events_metadata_idx` (`GIN (metadata jsonb_path_ops)`) and namespace/position
indexes. Core supplies JSON metadata criteria through the operation catalog; SQL
and table names stay inside the runtime. No schema version or fingerprint change
is required for these query APIs.

The temporary `events_core_thread_namespace_position_idx` used by older Core
HTTP queries is not required by 0.76.0. Operators must upgrade all affected
consumers and validate membership, discovery, watermarks and actual request
latency before removing that index concurrently. Runtime startup does not create
or remove indexes on an already-current schema.

### Generic catalog reads

`catalog.list` retains its required namespace, operation IDs, state filter,
operation metadata filter, descending update-time/ID order and bounded limit.
The optional association matches either operation metadata or metadata on an
indexed event. The ordinary `metadata` filter remains an additional AND
condition.

```ts
const operations = await catalog.list({
  namespace: "tenant-a",
  association: {
    operationMetadata: { work: { group: "batch-1" } },
    eventMetadata: { work: { group: "batch-1" } },
  },
  afterPosition: "120",
  limit: 32,
});
const position = await catalog.maxEventPosition({
  namespace: "tenant-a",
  eventMetadata: { work: { group: "batch-1" } },
});
```

Metadata matching uses JSON containment: strings and numbers remain distinct;
objects can match a subset of keys. Empty association objects or supplied empty
branches are rejected. An explicitly empty operation ID selection returns no
records. `afterPosition` accepts an unsigned decimal event position and includes
active operations or operations with progress beyond that position; an explicit
state filter still applies. `maxEventPosition` returns the greatest matching
position as a string, or `undefined`; an empty metadata object selects the
entire namespace.

`OperationCatalog.session` and `OperationCatalog.tables` are removed. Consumers
use catalog methods instead of constructing SQL against runtime tables. Plugin
policy and authorization remain with the caller; metadata association alone is
not an authorization decision.

Replay cursors use a per-operation stream high-watermark plus sparse byte
offsets for lanes that are still incomplete. Sequential completed lanes remain
constant-size even for deep multi-agent runs. The current cursor envelope is
bounded to 256 simultaneous sparse lanes/operations and 16 KiB before base64url
encoding. A checkpoint/history request that exceeds that active window returns
`409 operation_replay_capacity_exceeded`; an already-open feed emits the same
condition as a `replay.capacity` frame, detaches the observer without cancelling
the durable operation, and closes normally. Clients should refresh canonical
history and retry until enough lanes have sealed for the checkpoint to compact.
