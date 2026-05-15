---
title: Threads and Messages
description: Threads identify conversations; messages move users, agents, tools, and systems through the runtime.
section: Core Concepts
order: 30
status: stable
---

# Threads and Messages

A thread is a conversation identity.

A message is one piece of work inside that conversation.

## Why Threads Matter

Copilotz uses the thread to find conversation history.

No thread means a new conversation. A stable `thread.id` or `thread.externalId`
means the runtime can reuse the same conversation history.

```ts
await copilotz.run({
  content: "Continue our conversation.",
  target: "support",
  sender: { id: "user-1", type: "user" },
  thread: { externalId: "customer-123:support" },
});
```

Use `externalId` when the thread identity comes from your product, CRM, WhatsApp
session, browser session, or test harness.

## Senders

Messages can be sent by users, agents, tools, systems, or other runtime actors.

For user-facing chat output, usually print only:

```ts
event.type === "NEW_MESSAGE" && event.payload.sender?.type === "agent";
```

Tool results may appear in history as messages so the model can use them, but
they are not always meant to be displayed as chat.

## Targets

`target` tells Copilotz which agent should handle the message.

```ts
await copilotz.run({
  content: "I need help.",
  target: "support",
  sender: { id: "user-1", type: "user" },
});
```

When a thread has multiple participants, target metadata and target queues help
the runtime route follow-up turns.

## Participants

Participants describe who belongs to the thread. They are especially important
for channels, multi-agent flows, and goals.

```ts
thread: {
  externalId: "qa-run-1",
  participants: ["mobizap"],
}
```

## Related Pages

- [First Principles](../start-here/first-principles.md)
- [Thread Routing](../runtime/thread-routing.md)
- [Run API](../reference/run-api.md)
