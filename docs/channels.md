# Channels

A channel maps outside input into application events, then selects and maps
application outputs for its audience. The host creates the application once.
The basic boundary is ordinary `send`:

```ts
const operation = await application.send(await ingress(input));
for await (const output of operation.outputs) {
  await egress(output);
}
await operation.done;
```

Ingress and egress may be asynchronous. An ingress can ignore an occurrence or
split a batch into several events. An egress can discard an output, buffer it,
or emit several provider messages. Neither mapper needs an HTTP request, a
socket in an event payload, or a second application instance.

## Choose the lifetime at the host boundary

| Use case | Submission and output | Disconnect behavior |
| --- | --- | --- |
| Browser chat | Submit once; observe or reattach using the operation receipt | Detach observation; retain durable work |
| Provider webhook | Authenticate, accept occurrences, acknowledge promptly | Detached processors retain external delivery obligations |
| Live voice | Map each admitted transcript; consume replies while the session is active | Interrupt or close explicitly cancels the turn |

The generic runtime keeps these policies separate. A local output observer is
not a durable delivery queue. Replacing a webhook delivery processor with a
loop over `send().outputs` would lose delivery after the host disconnects.

## Core conversation channels

The built-in Web, WhatsApp, Zendesk, Telegram and Discord adapters share Core's
conversation integration. Their static `ChannelAdapter` methods are:

- Optional `accept(request, context)`: authenticate and decode an HTTP request
  into zero or more durable occurrences, plus the provider acknowledgement.
- `receive(input, context)`: map a durable occurrence into a conversation
  message. The shared ingress action creates the thread, participants and
  binding with stable identities.
- Optional `deliver(attempt, context)`: map resolved reply content and routing
  into provider calls. The shared detached processor owns retries and stable
  delivery identity.

Provider options remain in the final `adapters.channelProviders` composition.
Extend a mapper directly when adding application behavior; do not reconstruct
the plugin tree or introduce a factory around every method.

Trusted non-HTTP hosts can submit Core occurrences directly:

```ts
import { submitChannel } from "@copilotz/copilotz/channels";

const operations = await submitChannel(application, "whatsapp", occurrences, {
  namespace: authorizedNamespace,
  databaseSchema,
  operationMetadata: authorizedOperationClaims,
});
for (const operation of operations) {
  await operation.detach("provider_acknowledged");
}
```

Every occurrence is validated before the first send. Sends preserve order; a
submission failure cancels the operations already admitted from that batch.
Occurrence IDs must identify provider occurrences and remain stable on retry.
Provider credentials and live handles never belong in occurrence payloads.
Resolve identity and tenant authority before calling this helper.

`submitChannel` is a Core convenience. A generic domain event channel can call
`application.send` directly and does not need Core threads or bindings.

## Interruptible sessions

`createChannelSession` owns the small local lifecycle shared by live transports:

```ts
import { createChannelSession } from "@copilotz/copilotz/channels";

const session = createChannelSession(application, {
  ingress: (input: { id: string; text: string }) => ({
    type: "support.requested",
    payload: { text: input.text },
    namespace: authorizedNamespace,
    deduplicationId: input.id,
  }),
  egress: async (output, signal) => {
    const reply = mapAuthorizedReply(output);
    if (reply === null) return;
    signal.throwIfAborted();
    await writeReply(reply, signal);
  },
});

await session.send(admittedInput);
// Transport interrupt: await session.interrupt();
// Connection close: await session.close();
```

A newer send supersedes the previous turn. The host can serialize input if its
protocol needs a queue. Invalidation happens immediately; an operation whose
admission finishes late is still cancelled. An asynchronous egress must honor
the signal before performing its external write. The helper cannot retract a
message already sent by the provider.

Twilio ConversationRelay fits this pattern: the host authenticates the webhook
and WebSocket upgrade, binds the admitted call/session, maps final transcripts,
and encodes eligible replies into text frames. Partial transcripts and interrupt
frames are transport controls. They do not require artificial Core messages.

## Replies and streaming

Resolved event data is available in `output.data`. Keep stored ContentRefs
canonical; consume their resolved text projection instead of adding a private
content-reading processor or another content cache.

Select replies within the authorized operation, thread, agent and audience.
Reasoning, tool results and private agent conversations are separate from a
customer reply. A spoken narration can accompany tool calls; the presence of
tool-call metadata alone does not make its body text ineligible.

Core's pure [`projectCoreReply`](../plugins/core/authoring/reply/README.md)
helper takes that explicit scope and returns only `{ messageId, text }` or
`null`. It reads resolved output data; it performs no database or content read.

Choose committed replies or a deliberate progressive-stream policy. Emitting
both token streams and their final committed messages duplicates replies.
Consumers of `stream.output` must check its `terminal` status after reading the
bytes; byte EOF does not establish successful completion. Operation completion
is separately established by `operation.done`.

## Migrating to 0.80.0

Existing HTTP provider adapters keep their method names and static composition.
Live adapters can remove rejecting `accept` stubs. HTTP routing returns no
channel endpoint for an adapter without `accept`.

Web receipt/reconnect remains the browser boundary. Portable CLI and Node CLI
share the same Core message ingress; the Node adapter only supplies terminal
I/O. Browser VAD and Moonshine are input producers feeding ordinary Web chat
text/audio attachments, not additional server channel runtimes.

Application migration should remove duplicated orchestration where the shared
boundary now supplies it. Preserve provider authentication, current account
authorization, booking/control mappings and actual delivery semantics. A thin
re-export that already follows this pattern needs compatibility verification,
not a second wrapper.

In 0.80.0, the built-in WhatsApp, Zendesk, Telegram, and Discord receive mappers
explicitly mark messages as public to represent their external conversation
audience. Generic and Web/custom mappers keep omitted visibility
participant-scoped; set `visibility: "public"` only when the transport has
established that its conversation is the intended audience. Detached egress
still suppresses participant, tool-policy, internal, and private-history
messages. Live observation should use an explicit `projectCoreReply` scope.
