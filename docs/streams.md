# Progressive Streams

Streams are generic runtime Bodies with live observation. They are not thread,
participant, channel, or provider primitives.

## Application output

`ApplicationOutput` is either a resolved Copilotz Event or:

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
}>;
```

The descriptor deliberately has no thread, participant, routing, visibility,
Collection, or plugin fields. A semantic plugin may place opaque JSON hints in
`metadata`; the runtime does not interpret them.

Normal Event outputs retain their immutable Event envelope and add a deeply
frozen `data` field. For durable Events, `data` is the resolved Event Body and
`payload.dataRef` remains available for durable identity or later verification.
For transient Events, `data` is the Event payload. Event data is strict
transport-safe JSON; progressive or binary bytes belong in Streams and Assets
rather than Event payloads.

Every `send().outputs` and `observe()` subscription receives its own lazy Body
follower. Two subscribers never share one `ReadableStream` instance, and bytes
remain consumable after the enclosing operation settles.

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
`appendId` and obey BodyStore backpressure. Abort abandons staging and errors
followers.

Closing returns `PreparedContent`; it does not create an Asset graph node. A
semantic Action or Collection must adopt that prepared content as part of its
own durable state transition.

The lower progressive Body primitive can run without observation wiring for
internal storage and recovery. Descriptor publication is a higher application
boundary, not an automatic property of every Body writer.
