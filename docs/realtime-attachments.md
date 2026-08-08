# Realtime Attachments

`connect()` creates a persistent participant attachment to an existing thread.
`send()` is the only ingress API for messages, discrete controls, and raw media
streams.

```ts
const attachment = await app.connect({
  thread: "thread-1",
  participant: "user-1",
  recipientIds: ["agent-realtime"],
});

const consume = (async () => {
  for await (const output of attachment.outputs) {
    if (output.type === "stream.output") {
      console.log(output.participant, output.mediaType, output.streamId);
      for await (const chunk of output.payload) play(chunk);
    } else {
      console.log(output.type, output.correlationId);
    }
  }
})();

const audio = await attachment.send({
  type: "audio.input",
  mediaType: "audio/pcm;rate=24000",
  payload: microphoneStream,
});

await audio.done;
await attachment.close();
await consume;
```

Calling `send()` with a stream returns after Oxian accepts it. The returned
handle contains `streamId`, `eventId`, `correlationId`, `done`, and `cancel`;
acceptance does not wait for the source stream to finish.

## Output

`attachment.outputs` yields either:

- a semantic durable/ephemeral event; or
- `stream.output` with participant identity, media type, stream ID, causation,
  correlation, metadata, and a readable byte stream.

Multiple agents may output concurrently. Each stream retains its participant
label rather than being mixed into a synthetic speaker channel.

## Persistence boundary

Raw input/output chunks remain ephemeral and respect Web Stream backpressure.
`stream.opened`, `stream.closed`, `stream.cancelled`, interruptions, final
transcripts/messages, tool execution, public agent ask, and errors are semantic
events. Final media may be stored through canonical assets.

Realtime provider resources receive typed `context.send()`, `context.tool()`,
and `context.ask()` capabilities. This lets an audio model call tools or other
agents without routing through an artificial text-only processor path.

Production codecs, VAD/turn detection, and provider-specific audio protocols are
adapters layered on this foundation.
