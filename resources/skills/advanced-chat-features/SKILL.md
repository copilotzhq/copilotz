---
name: advanced-chat-features
description: Build advanced chat behavior on Copilotz semantic events and attachments.
allowed-tools: [read_file, write_file, search_files]
tags: [framework, ui, adapter, events]
---

# Advanced Chat Features

Treat the UI as a passive event observer, not a durable workflow consumer.
Copilotz v3 exposes semantic events and participant-labelled streams through
`run().events` and persistent `connect().outputs` attachments.

## Intercept semantic events

```ts
function projectEvent(event: CopilotzEvent) {
  switch (event.type) {
    case "text.delta":
      return { kind: "append-text", event };
    case "message.created":
      return { kind: "commit-message", event };
    case "tool_execution.created":
      return { kind: "show-tool", event };
    case "tool_execution.failed":
      return { kind: "show-error", event };
    default:
      return { kind: "observe", event };
  }
}
```

Do not claim or suppress events in the core. A UI may choose not to render an
event, but that does not alter durable history or another observer's view.

## Persistent text and media

```ts
const attachment = await app.connect({
  thread: threadId,
  participant: userId,
  recipientIds: [agentParticipantId],
});

for await (const output of attachment.outputs) {
  if (output.type === "stream.output") {
    renderParticipantStream(output.participant, output.payload);
  } else {
    renderSemanticEvent(output);
  }
}
```

Keep concurrent streams separate by participant and `streamId`. Raw audio or
future media frames are ephemeral; final transcripts, messages, tools, errors,
and stream lifecycle facts are semantic events.

## Web adapter boundary

For new clients, build on `createEventNativeFetchHandler()` and the event-native
server resources. Existing `@copilotz/chat-adapter` clients may temporarily use
`createV1FetchHandler()`; keep that projection at the HTTP boundary and do not
reintroduce legacy transport events into core plugins.

Use dynamic authorization headers at the client boundary, namespace every
request server-side, and resolve asset bodies through the authenticated asset
endpoint rather than embedding large payloads in event frames.
