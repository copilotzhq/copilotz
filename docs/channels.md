---
title: "Channels"
description: "Map provider input into durable Events, send eligible replies back out, and run interruptible live sessions without a second conversation store."
section: Deliver
order: 20
status: stable
---

# Channels

## The pain

Your users are not all at a terminal or in your browser app. Some write from
WhatsApp or Telegram, some talk through a voice relay, some reach you through a
support desk. Each provider sends webhooks in its own shape, retries them when
you answer slowly, and expects replies through its own API.

Writing that by hand usually goes wrong in the same places: a retried webhook
creates a second message, a reply is sent from an HTTP request handler that dies
when the provider disconnects, a voice caller interrupts but the old answer
keeps speaking, and private reasoning or tool output leaks into a customer
reply.

## The problem

A channel needs a contract for both directions and for its lifetime:

- **Ingress** admits one provider occurrence as durable application input once
  per stable provider ID, even when it is redelivered, under a namespace and
  identity the host has already verified.
- **Egress** selects which outputs this audience may receive, and decides
  whether delivery is a durable obligation or only a live observation.
- **Lifetime** separates three different things: stopping your local observer,
  asking for durable cancellation, and a delivery that must survive a host
  restart.

None of this should require a second conversation store or a socket inside an
Event payload.

## The solution

Copilotz offers two layers from `@copilotz/copilotz/channels`. Use the one that
matches your audience.

### Live sessions over any application

`createChannelSession(application, { ingress, egress })` owns the lifecycle of
one live conversation over ordinary `app.send`. It needs no Core and no
provider:

- `ingress(input, signal)` maps one provider input to **exactly one** `app.send`
  envelope. Filter or split occurrences before calling `send`.
- `egress(output, signal)` receives each output in stream order. Check the
  signal immediately before any external write.
- `send(input)` resolves only after the outputs end **and** the operation
  settles; it rejects when the operation fails.
- A newer `send` **supersedes** the active turn: its reader stops and durable
  cancellation is requested. The superseded `send` rejects with an `AbortError`.
- `interrupt()` and `close()` request durable cancellation and stop the active
  turn's reader. If its operation handle already exists, they await that
  handle's cancellation and reader cleanup. During pending admission they can
  return first; a late handle is cancelled when admission finishes. They do not
  join previously superseded turns. The interrupted `send` rejects when it
  observes the abort; asynchronous ingress and egress must honor their signal to
  stop promptly. After `close()`, new sends reject. Session closure alone is not
  a barrier for closing persistence while earlier sends are still pending.

- If `egress` throws, the session cancels that turn and `send` rejects.

The session is not a queue and not restart-durable delivery. If your protocol
needs ordered turns, serialize input yourself. A message the provider already
delivered cannot be retracted.

#### Example: a scripted session over Notes

This uses the Notes application from
[Chapter 5](getting-started/part-1-design-and-build/05-package-a-plugin.md): its
`composition.ts` and `notes-plugin.ts` must exist, with
`@copilotz/copilotz@^0.85.3` installed. No provider or credential is involved;
the script plays the provider. Create `channel-session.ts`:

```ts
// Runtime factory and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Types of the stored record carried by a Collection Event.
import type { CollectionCreated } from "@copilotz/copilotz";
// The runtime-neutral live session helper.
import { createChannelSession } from "@copilotz/copilotz/channels";
// The same host choices as `app.ts`.
import { database, namespace, runtimePlugins } from "./composition.ts";
// The stored note's type, for reading the committed record.
import type { NoteRecord } from "./notes-plugin.ts";
// Exit status on Deno and Node.
import process from "node:process";

// What this fake provider sends: a stable occurrence ID and the user's text.
type ProviderInput = Readonly<{ id: string; text: string }>;

const app = await createCopilotz({
  namespace,
  database,
  plugins: runtimePlugins,
});

// One session per live provider conversation, such as one call or socket.
const session = createChannelSession<ProviderInput>(app, {
  // One provider input becomes one durable input Event. The provider's
  // occurrence ID makes a redelivered input admit the same operation.
  ingress: (input) => ({
    type: "notes.capture.requested",
    payload: { text: input.text },
    correlationId: `provider:${input.id}`,
    deduplicationId: `provider:${input.id}`,
  }),
  // Select only what this audience may see; here, the committed note.
  egress: async (output, signal) => {
    // This audience gets no byte streams: release each one instead of leaking it.
    if (isStreamOutput(output)) {
      await output.payload.cancel();
      return;
    }
    if (!output.durable) return;
    if (output.type !== "note.created") return;
    // Do not write to the provider for a turn that was interrupted.
    signal.throwIfAborted();
    const { record } = output.data as CollectionCreated<NoteRecord>;
    console.log(`reply: saved "${record.text}" as ${record.id}`);
  },
});

try {
  // Each turn waits for its outputs and its durable settlement.
  await session.send({ id: "occ-1", text: "Ship the channel reference." });
  await session.send({ id: "occ-2", text: "Review the session lifecycle." });
} catch (error) {
  // A failed or superseded turn rejects here; report it and fail the run.
  console.error("turn failed:", error);
  process.exitCode = 1;
} finally {
  // Cancels any active turn, then releases the database.
  await session.close();
  await app.close();
}
```

This is a host entrypoint, not a test module. It composes only the Runtime Notes
plugin, with no Core. With Chapter 5's `:memory:` database each run has its own
private data. Run it:

```sh
# Run the local session example on Deno.
deno run -A channel-session.ts
# Node 24+ alternative:
node channel-session.ts
```

Expected facts, with different IDs:

```text
reply: saved "Ship the channel reference." as <note-id>
reply: saved "Review the session lifecycle." as <note-id>
```

### Core conversation channels

For conversational providers, `channelsPlugin` from
`@copilotz/copilotz/channels` plugs provider traffic into Core threads. It
already composes Core, which remains the one conversation store, so threading
alone needs no agent. Agent resources and a model connection, as in
[Chapter 8](getting-started/part-3-add-agent-behavior/08-hello-agent.md), are
needed only when agents should respond.

A channel has two declarations under the **same alias**, for example `support`.
Append `channelsPlugin` to your existing `plugins` list. Set
`resources.channels.support` to
`defineChannelResource({ egress: "external", defaultAgentAliases: ["assistant"] })`,
which is the channel's data-only composition policy. Set
`adapters.channels.support` to your `ChannelAdapter`, which holds the executable
mapper. Merge both into your existing maps rather than replacing them. For a
complete, authorized chat example built on Core, see
[Chapter 17](getting-started/part-4-release-to-users/17-connect-chat-and-channels.md).

A `ChannelAdapter` has three methods:

- optional `accept(request, context)` authenticates and decodes one HTTP request
  into `{ occurrences, status?, response? }`. HTTP ingress needs it: without
  `accept` the route still appears in compiled routes and OpenAPI, but the
  handler answers `404`.
- `receive(input, context)` maps one durable occurrence into a message:
  `externalThreadId`, `sender`, `content`, optional `recipients`, `thread`,
  non-secret `route` and `visibility`. The shared ingress Action creates the
  thread, participants and the durable **binding** from the provider thread to
  the Core thread.
- optional `deliver(attempt, context)` sends resolved reply content to the
  provider and may return `{ deliveryKey, delivered, providerIds? }`.

The two egress modes are different contracts:

| `egress`                | Ingress                                                           | Reply                                                                            |
| ----------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `"external"`            | Webhook; provider occurrence IDs; may batch; returns provider ack | Detached Processor calls `deliver`, at least once, retried; survives the request |
| `"request-observation"` | Requires an `Idempotency-Key`; at most one occurrence per request | The caller observes the operation, like a browser; no detached delivery          |

External delivery is at least once. Each attempt has a stable `deliveryKey`,
which only prevents duplicates if you forward it to a provider that honors
idempotency. A webhook acknowledgement or ingress `done` proves admission, not
delivery.

Built-in Web, WhatsApp, Zendesk, Telegram and Discord plugins already compose
`channelsPlugin` and Core; provider options go under
`adapters.channelProviders`. Configure each provider's credentials and signature
verification in the host **before** enabling its route; secrets and live handles
never belong in occurrences or `route`.

### Visibility and reply projection

Custom and Web `receive` mappers that omit `visibility` produce
participant-scoped messages. Set `"public"` only when the transport proves the
whole conversation is the audience. External egress delivers public agent
messages only and drops private, reasoning and tool-only content.

Raw thread and operation observation applies **no** history privacy filter. For
a live reply, `projectCoreReply(output, scope)` from `@copilotz/copilotz/core`
is a pure function: given a trusted `namespace`, `correlationId`, `threadId`,
`agentId` and `viewerParticipantIds`, it returns `{ messageId, text }` for an
eligible committed `message.created` output, or `null`. It reads no database,
authorizes nothing and does not stream tokens. Choose either committed replies
or a progressive token stream, not both, or users see each reply twice.

### Trusted non-HTTP submission

A worker that already verified a batch can call
`submitChannel(app, alias, occurrences, { namespace, databaseSchema,
operationMetadata })`.
It validates the whole batch first, then sends in order. If a later send fails,
it cancels the operations already admitted; that is cancellation, not
transactional rollback. Keep occurrence IDs stable across retries.

## Reference

| Need                             | Use                                                          |
| -------------------------------- | ------------------------------------------------------------ |
| Live, interruptible conversation | `createChannelSession`                                       |
| Stop observing only              | `handle.detach(reason)`; durable work continues              |
| Stop the work                    | `session.interrupt()` / `close()` or `handle.cancel(reason)` |
| Provider webhook into Core       | `channelsPlugin`, `defineChannelResource`, `ChannelAdapter`  |
| Reply text for a viewer          | `projectCoreReply` with a trusted scope                      |
| Domain Events, no threads        | plain `app.send`, no Channel plugin                          |

Release notes for 0.80.0 channel changes are in
[Upgrading](upgrading.md#release-history).

## What this unlocks

- A redelivered provider occurrence with the same valid envelope is not admitted
  twice. Processor execution and external egress can still retry, as described
  above.
- Voice and socket transports get interruption and supersession that cancel
  durable work instead of only hiding it.
- Webhook replies survive host disconnects through detached delivery.
- Every channel shares Core threads, so history, memory and HTTP reads see one
  conversation.

## Next steps

- [Chapter 17: Connect Chat and Channels](getting-started/part-4-release-to-users/17-connect-chat-and-channels.md)
  puts the assistant behind authenticated HTTP.
- [HTTP Server and Client](server.md) covers exposing Channel routes and
  authorization.
- [Events, Deliveries and Recovery](events-deliveries-recovery.md) explains
  detach, cancel and retried Processors.
- [Streams](streams.md) covers progressive output and terminal status.
