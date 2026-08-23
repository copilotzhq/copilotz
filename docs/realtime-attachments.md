# Realtime Attachments

`createCopilotz()` creates the application session. The session itself is the
connection: `send()` is the only ingress API for plugin input envelopes, and
`observe()` is the live observation surface for semantic events and runtime
stream outputs.

```ts
import { createCopilotz } from "@copilotz/copilotz";
import { core } from "@copilotz/copilotz/core";

const app = await createCopilotz({ namespace: "tenant-a" });

const consume = (async () => {
  for await (const output of app.observe()) {
    if (output.type === "stream.output") {
      console.log(output.participant, output.mediaType, output.streamId);
      for await (const chunk of output.payload) play(chunk);
    } else {
      console.log(output.type, output.correlationId);
    }
  }
})();

const sent = await app.send(core.message({
  thread: "thread-1",
  participant: "user-1",
  recipientIds: ["agent-realtime"],
  content: "Hello",
}));

await sent.done;
await app.close();
await consume;
```

Calling `send()` returns after the runtime accepts the ingress command. The
returned handle contains `eventId`, `correlationId`, a bounded `outputs` stream
for request-bound adapters, `done`, and `cancel`; acceptance does not wait for
causally produced work to finish.

## Output

`app.observe()` yields either:

- a semantic durable/ephemeral event; or
- `stream.output` with participant identity, media type, stream ID, causation,
  correlation, metadata, and a readable byte stream.

Multiple agents may output concurrently. Each stream retains its participant
label rather than being mixed into a synthetic speaker channel.

## Persistence boundary

Raw input/output chunks respect Web Stream backpressure. Progressive stream
bytes are durable through the runtime BodyStore while the stream is active or
until they are adopted as canonical content; semantic collections create the
Asset node when declared content adopts a closed stream. Interruptions, final
transcripts/messages, public ask messages, and errors are semantic Events; Tool
calls use their native Action lifecycle Events.

A semantic realtime plugin receives the ordinary composed runtime context. Its
Actions and Processors call native capabilities through `context.actions` just
like the text loop; the runtime does not inject special `send`, `tool`, or `ask`
context methods.

Production codecs, VAD/turn detection, and provider-specific audio protocols are
adapters layered on this foundation.
