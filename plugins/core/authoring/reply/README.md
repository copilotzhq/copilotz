# Core reply projection

## What it is

Projects one resolved, durable Core agent Message into `{ messageId, text }`
for a trusted live-channel viewer.

## Why it exists

Live transports need a narrow committed reply without reading Core collections,
resolving content, or exposing event and message metadata.

## How to use it

Call `projectCoreReply(output, scope)` with an `ApplicationOutput` and an
explicit namespace, correlation, thread, Agent ID, and viewer participant list.

```ts
import { projectCoreReply } from "@copilotz/copilotz/core";

const reply = projectCoreReply(output, {
  namespace: "tenant-a",
  correlationId: "turn-a",
  threadId: "thread-a",
  agentId: "support",
  viewerParticipantIds: ["human-a"],
});
```

## How it works

It accepts only authorized `message.created` output whose envelope and stored
row agree on identity, workflow provenance, routing, and visibility. Missing
legacy row visibility defers to the envelope visibility. Only resolved `text`
parts with the `body` role are concatenated in order; reasoning, tool, media,
and unresolved parts are omitted.
