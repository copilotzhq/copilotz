---
title: Threads and Messages
description: Threads identify conversations; messages move users, agents, tools, and systems through the runtime.
section: Core Concepts
order: 30
status: stable
---

# Threads and Messages

A thread is a conversation identity and the operational topic for runtime work.

A message is a participant turn aggregate inside that conversation. For an
agent, one message can contain sequential visible content, reasoning, tool
executions, continuation output, and routing metadata for one contiguous agent
run.

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

## Agent Message Aggregates

Agent output is stored as a durable message and enriched by child graph nodes:

- `llm_attempt` records every provider attempt, prompt snapshot, partial
  content/reasoning, usage, cost, status, and recovery linkage.
- `tool_execution` records tool call arguments, output, errors, visibility, and
  large-result lookup state.
- `asset` records files and media produced during the turn.

Live `TOKEN`, `TOOL_CALL`, `TOOL_RESULT`, and `LLM_RESULT` events are projected
from that state for UI compatibility. On refresh, clients should hydrate from
the aggregate message and its metadata rather than requiring the original live
stream.

`<no_response/>` completes the internal attempt without creating a default
visible chat bubble. The live stream still receives a terminal empty
`LLM_RESULT` so clients can stop spinners.

Visible text after a tool call in the same assistant response is preserved as
ordered message content. It is not treated as a recovery condition by itself.

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

## Thread Graph Nodes

The `threads` table remains the operational read model and queue topic. Copilotz
also creates a semantic `thread` graph node with the same id so messages, LLM
attempts, tool executions, assets, entities, and future forks can be connected
through graph edges.

## Related Pages

- [First Principles](../start-here/first-principles.md)
- [Thread Routing](../runtime/thread-routing.md)
- [Run API](../reference/run-api.md)
