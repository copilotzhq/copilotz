# Progressive Streams

Streams are generic runtime Bodies with live observation. They are not thread,
participant, channel, model, or provider primitives.

## Application output

`ApplicationOutput` is either a resolved Copilotz Event or a `StreamOutput`:

```ts
type StreamOutput = Readonly<{
  type: "stream.output";
  namespace: string;
  streamId: string;
  mediaType: string;
  kind: "text" | "json" | "image" | "audio" | "video" | "file";
  role: string;
  name?: string;
  alt?: string;
  language?: string;
  disposition?: "inline" | "attachment";
  causationId?: string;
  correlationId?: string;
  metadata: Readonly<Record<string, unknown>>;
  payload: ReadableStream<Uint8Array>;
  terminal: Promise<StreamTerminalStatus>;
}>;

type StreamTerminalStatus = Readonly<{
  outcome: "completed" | "failed" | "cancelled" | "superseded" | "abandoned";
  availability: "retained" | "purge_pending" | "purged" | "missing";
  capture: "complete" | "truncated";
  offset: number;
  terminalAt: string;
}>;
```

The descriptor deliberately has no thread, participant, routing, visibility,
Collection, model, or provider fields. A semantic plugin may place opaque JSON
hints in `metadata`; the runtime does not interpret them. Streams opened inside
an Action also receive runtime-owned `metadata.sourceActionRunId`, allowing a
transport to preserve causal ordering without coupling unrelated stream lanes.

Every `send().outputs`, `attach().outputs`, and `observe()` subscription gets
its own Body reader. Subscribers never share one `ReadableStream` instance.
Reconnect reads the existing Body from the durable operation catalog's committed
offset; it does not copy raw chunks into another journal.

Every application-visible stream supplies `terminal`. The promise separates Body
EOF from semantic success: an incomplete Body is a readable, finite prefix, so
its reader can reach EOF even though the stream failed.

HTTP transports project a non-completed outcome, or unavailable terminal bytes,
as an in-band `stream.error` boundary after any readable prefix. The boundary
carries the stream ID, terminal offset, outcome, capture, availability, and a
bounded runtime error code. A completed, available stream ends with
`stream.end`.

Neither `stream.output`, `stream.error`, nor raw byte frames are durable Events.
Normal Event outputs retain their immutable Event envelope and add deeply frozen
`data`. For durable Events, `data` resolves the Event Body while
`payload.dataRef` preserves its durable identity; transient Events expose their
payload as `data`. Event data is strict transport-safe JSON; progressive and
binary bytes belong in Streams and Assets.

## Producing a stream

Actions and Processors use `context.streams`:

```ts
const writer = await context.streams.open({
  mediaType: "text/plain; charset=utf-8",
  kind: "text",
  role: "assistant.output",
  correlationId: context.identity.correlationId,
});

await writer.append({
  bytes: new TextEncoder().encode("partial output"),
  appendId: "chunk-1",
});

const prepared = await writer.close({ assetId: "final-transcript" });
```

Opening publishes one serializable descriptor. Appends are idempotent by
`appendId` and obey BodyStore backpressure. Closing seals a `ready` Body and
returns `PreparedContent`; it does not itself create an Asset graph node. A
semantic Action or Collection adopts that content in its own durable transition.

After successful settlement, the producer selects canonical Asset ownership or
temporary operation-observation retention with `writer.retain(...)`.

## Publication and failure

Descriptor publication is the cutoff between disposable staging and observable
history:

- Before publication, a failed open may destructively abandon the staging Body
  and discard any unpublished catalog staging.
- Publication is established when the descriptor is durably discoverable in an
  operation catalog or accepted by the live application-output boundary. Once
  established, the runtime must preserve its terminal observation; a cataloged
  stream remains a replay obligation even if later relay or producer work fails.
- After publication, `writer.abort(...)` is semantic termination, not deletion.
  It records `failed` by default, or the supplied `cancelled`, `superseded`, or
  `abandoned` outcome, and freezes the committed prefix as `incomplete`.
- A producer handling cancellation calls `abort({ outcome: "cancelled" })`.
  `Symbol.asyncDispose` and execution teardown classify a leaked, unsettled
  published writer as `abandoned` instead of guessing semantic cancellation.

At the lower Body layer, `terminate()` freezes the committed prefix while
`abandon()` and `BodyStore.abort()` destructively remove staging. Destructive
abandon is reserved for work that never crossed the publication cutoff.

An `incomplete` Body is immutable, checksummed, readable, and never adoptable as
an Asset. Only a successfully sealed `ready` Body may become canonical content.
Thus a failed provider attempt can remain available during the replay window
without becoming a successful semantic result.

## Terminal state and replay

The operation catalog tracks physical settlement as `open`, `terminating`, or
`terminal`. Terminal meaning is represented by three orthogonal fields:

- `outcome` says how production ended: completed, failed, cancelled, superseded,
  or abandoned.
- `capture` says whether the retained bytes are the complete intended capture or
  only a truncated prefix. A completed outcome always has complete capture;
  another outcome may still have complete capture.
- `availability` says whether those bytes are retained, selected for crash-safe
  purge, already purged, or unexpectedly missing. `purge_pending` remains a
  retryable maintenance state rather than reversing to retained.

The terminal offset is the exact immutable length of the frozen Body. That
includes an append which became observable just before its producer discovered
that catalog ownership was lost, so reconnect can reproduce every published
byte. Recovery reconciles catalog-owned lanes before generic Body maintenance so
published prefixes are frozen rather than mistaken for orphan staging.

Active progressive writers renew their storage lease independently of byte
traffic. A failed renewal fences further append/finalize work but still permits
termination or pre-publication abandonment. Maintenance can claim an expired
lease: sealing Bodies finish as `ready`; published open or terminating Bodies
freeze as `incomplete`.

Temporary observation Bodies and their catalog metadata share the operation
replay clock. By default they remain replayable for 24 hours after the operation
settles; `operationRetentionMs` changes that grace and `null` disables its
expiry. Canonical adoption exempts the Body from observation cleanup; its
operation replay metadata may still expire while Asset ownership preserves the
Body. Physical retirement uses exact state/version checks so concurrent
maintenance cannot delete a renewed or newly owned Body.

The runtime owns Bodies, leases, descriptor publication, the operation catalog,
the generic terminal vocabulary, replay cursors and retention, recovery,
maintenance, and transport framing. Plugins own semantic stream roles, opaque
metadata, and when their own work should complete or fail; runtime cancellation,
ownership loss, and disposal can also terminate a writer. Provider-specific
validation, fallback, and user-facing failure meaning stay in their plugins;
they do not change the runtime Body lifecycle. Raw streamed bytes remain in
Bodies and are never persisted as Events.

The lower progressive Body primitive can run without observation wiring for
internal storage and recovery. Descriptor publication and operation replay are
higher application boundaries, not automatic properties of every Body writer.
