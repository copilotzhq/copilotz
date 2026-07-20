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

When multi-agent routing is enabled, Copilotz injects two reserved controls for
the current agent's allowed agent participants:

```ts
ask_in_thread({
  target: "researcher",
  message: "Check the evidence for this claim and report your confidence.",
});

handoff_in_thread({
  target: "writer",
  message: "Turn the validated findings into the final brief.",
});
```

Both controls require an atomic `{ target, message }`. `ask_in_thread` queues the
asking agent so control returns after one reply. `handoff_in_thread` transfers
the next turn without adding that automatic return. Agent targets must be
participants in the current thread and must pass the sender's `allowedAgents`
policy. `handoff_in_thread` may also target `user` when the thread has exactly
one human participant. Visible text outside the control streams and persists as
public conversation content, while the control block and its `message` argument
remain hidden and are delivered through routing metadata. The controls are
runtime-provided and are not executable tools to add to `resources.imports` or
`allowedTools`.

For isolated work outside the current conversation, use the regular
`delegate_task` tool. It creates a separate child thread, waits for the delegated
agent's final answer, and returns that answer as a tool result.

Start explicit: use stable agent IDs, clear participant lists, and predictable
target behavior before adding autonomous routing.

## Related Pages

- [Threads and Messages](../core-concepts/threads-and-messages.md)
- [Runs](./runs.md)
