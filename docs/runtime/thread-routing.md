---
title: Thread Routing
description: How Copilotz routes messages by target, participants, metadata, and target queues.
section: Runtime
order: 40
status: draft
---

# Thread Routing

Routing decides which agent should respond next.

For most apps, pass an explicit `target`.

```ts
await copilotz.run({
  content: "Help me book a trip.",
  target: "booking-agent",
  sender: { id: "user-1", type: "user" },
});
```

## Participants

Thread participants describe who belongs to the conversation.

```ts
thread: {
  externalId: "customer-123",
  participants: ["booking-agent"],
}
```

## Target Queue

`targetQueue` can describe follow-up routing for multi-agent flows. The runtime
uses initial routing metadata to preserve intended targets across turns.

## Multi-Agent Flows

Copilotz can run multi-agent conversations, but start explicit. Use stable agent
IDs, clear participant lists, and predictable target behavior before adding
autonomous routing.

## Related Pages

- [Threads and Messages](../core-concepts/threads-and-messages.md)
- [Runs](./runs.md)
