# Realtime attachments

An attachment is a persistent participant connection to one thread.

```ts
const attachment = await copilotz.connect({
  thread: "support-call-42",
  participant: {
    externalId: "customer-42",
    participantType: "human",
  },
  namespace: "tenant-a",
});

const message = await attachment.send({
  content: "Hello",
  sender: { externalId: "customer-42", type: "user" },
});

const audio = await attachment.send({
  type: "audio.input",
  mediaType: "audio/pcm;rate=24000",
  payload: microphoneStream,
  target: "voice-agent",
});

for await (const output of attachment.outputs) {
  if (isAttachmentStreamOutput(output)) {
    for await (const bytes of output.payload) play(bytes);
  } else {
    renderSemanticEvent(output);
  }
}

await audio.done;
await attachment.close();
```

`send()` has three overloads:

- durable message/domain input;
- discrete event/control input;
- stream input with `ReadableStream<Uint8Array>`.

A stream send resolves after Oxian accepts the work and returns
`{ streamId, correlationId, done, cancel }`; it does not buffer or wait for the
input stream to finish. Input and output bytes remain Web Streams end to end,
preserving backpressure.

`attachment.outputs` yields semantic events or stream objects containing
participant, media type, stream ID, namespace, thread, causation/correlation
metadata, and a readable byte stream. Multiple participant streams may be open
concurrently.

Raw chunks never become events. `stream.opened`, `stream.closed`,
`stream.interrupted`, `stream.failed`, final transcripts, final participant
messages, tools, and errors are semantic events. Provider-specific codecs, turn
detection, and media negotiation belong in realtime provider resources.

## Realtime tools and public asks

A realtime provider receives `input.events`, a backpressured stream of durable
semantic events committed in the attachment's correlation scope after
`stream.opened`. It can emit an ordinary participant message containing tool
calls, continue reading input/output media, and await the resulting
`tool_execution.*`, tool-result `message.created`, or public agent-answer events
before continuing the same realtime turn.

Copilotz marks messages emitted by the provider as realtime-owned. Once their
tool batch or `ask` completes, the result returns through `input.events`; the
text runtime does not start a competing continuation for the realtime agent.
Nested asks made by a text agent still resume that text agent normally. This
keeps text and realtime on one public event model while leaving raw frames
ephemeral.
