---
title: "Ch 10: The Event System"
description: "The full event lifecycle, from message receipt to final response."
section: Getting Started
order: 100
status: stable
---

# Chapter 10: The Event System

> **Part 5 — Controlling the Runtime**

## The pain

You've used processors to intercept tool calls. But the agent runtime still
feels like a black box. Questions you can't yet answer:

- What exactly happens between a user message arriving and the LLM responding?
- How does conversation history get built?
- What triggers a tool call vs. a direct response?
- How do streaming tokens get from the LLM to the client?
- If I want to add custom logging, observability, or side effects at different
  points in the lifecycle — where do I hook in?

You're writing middleware for a process you don't fully understand. That needs
to change.

## The foundation: threads and events

Copilotz runtime state is stored as domain objects in the graph/database, with
an outbox event written in the same transaction for every durable mutation. Two
things are central to understanding the runtime:

### The `threads` table

A **thread** is a conversation. It has:

- A unique `id`
- `metadata` — a JSON blob where you can store anything (agent turn counts, user
  preferences, approval tokens, etc.)
- Timestamps

Every call to `copilotz.run()` is associated with a thread. The same thread can
be used across multiple turns by passing `threadId`:

```typescript
const result1 = await copilotz.run(
  { content: "My name is Alice.", sender: { type: "user", name: "Alice" } },
  { threadId: "thread-123" },
);

const result2 = await copilotz.run(
  { content: "What's my name?", sender: { type: "user", name: "Alice" } },
  { threadId: "thread-123" }, // Same thread — agent remembers "Alice"
);
```

### The `events` table

Durable workflow facts are recorded in the `events` table as an outbox. Modern
rows use lifecycle names like `message.created`, `llm_attempt.completed`, and
`tool_execution.failed`, plus `subjectType`, `subjectId`, `operation`,
`causationId`, structured `metadata`, and a compact `payload` containing the
mutation input. Snapshot columns such as `input`, `before`, `after`, and `patch`
remain in the table for migration compatibility, but new runtime mutations leave
them empty to avoid duplicating large graph state.

Processors react to those lifecycle facts and perform more domain mutations.
Legacy uppercase queue events and `producedEvents` still exist for compatibility
and live stream projections, but new durable state should be written through
`ops.mutate.*`.

The graph/database is the source of truth. The outbox is the durable workflow
log and debugging/audit trail.

## Live stream event types

These uppercase events are projected to clients and older integrations:

### `NEW_MESSAGE`

Fired when a new message enters the system — from a user, a tool, or another
agent.

**Produced by:** `copilotz.run()`, tool result handlers, agent delegation\
**Consumed by:** `new_message` processor — builds conversation history, resolves
context, enqueues `LLM_CALL`

**Payload:**

```typescript
{
  content: string | ContentPart[];
  sender: { type: "user" | "agent" | "tool"; id?: string; name?: string };
  target?: string;     // Target agent id (for multi-agent routing)
  metadata?: Record<string, unknown>;
}
```

### `LLM_CALL`

Fired to invoke the LLM.

**Produced by:** `new_message` processor\
**Consumed by:** `llm_call` processor — assembles the full prompt, calls the LLM
API, streams tokens, enqueues `LLM_RESULT`

**Payload:**

```typescript
{
  messages: ChatMessage[];     // Full conversation history
  llmConfig: LLMRuntimeConfig; // Provider, model, temperature, etc.
  agentId: string;
}
```

### `LLM_RESULT`

Fired when the LLM finishes responding.

**Produced by:** `llm_call` processor\
**Consumed by:** `llm_result` processor — parses the response, routes to agents
via @mention, triggers entity extraction, enqueues `NEW_MESSAGE` if there's a
tool result to send back

**Payload:**

```typescript
{
  content: string;
  toolCalls?: ToolInvocation[];   // If the LLM requested tool calls
  usage: TokenUsage;
}
```

### `TOOL_CALL`

Fired for each tool the LLM requested.

**Produced by:** `llm_result` processor (one event per requested tool call)\
**Consumed by:** `tool_call` processor — executes the tool function, enqueues
`TOOL_RESULT`

**Payload:**

```typescript
{
  toolCall: {
    id: string;
    tool: {
      id: string;
      key: string;
      name: string;
    }
    args: Record<string, unknown>;
  }
}
```

### `TOOL_RESULT`

Fired when a tool finishes executing.

**Produced by:** `tool_call` processor\
**Consumed by:** `tool_result` processor — aggregates results, projects history,
determines whether to loop back to the LLM

**Payload:**

```typescript
{
  toolCallId: string;
  status: "completed" | "failed";
  output?: unknown;
  error?: unknown;
}
```

## Synthetic event types

These events are emitted to the real-time stream but not persisted in the
database. They exist for client-side consumption only.

### `TOKEN`

One streaming token from the LLM.

```typescript
{
  token: string;
  isReasoning?: boolean;  // true for chain-of-thought tokens
}
```

Use this to render the LLM response word-by-word in your UI.

### `ASSET_CREATED`

Fired when a tool produces an asset (image, file) that has been saved.

```typescript
{
  assetId: string;
  mimeType: string;
  url?: string;
}
```

## The lifecycle, visualized

```
User sends message
        │
        ▼
  NEW_MESSAGE event
        │
        ▼
  new_message processor
  (builds history, resolves agent, resolves context)
        │
        ▼
  LLM_CALL event
        │
        ▼
  llm_call processor
  (sends to LLM API, streams TOKEN events)
        │
        ├─── [direct response] ──────────────────────────────────┐
        │                                                        │
        ▼                                                        │
  LLM_RESULT event                                              │
        │                                                        │
        ├─── [tool calls requested] ──┐                         │
        │                             ▼                         │
        │                       TOOL_CALL events (one per tool) │
        │                             │                         │
        │                             ▼                         │
        │                   tool_call processor                  │
        │                   (executes tool.execute())            │
        │                             │                         │
        │                             ▼                         │
        │                       TOOL_RESULT events              │
        │                             │                         │
        │                             ▼                         │
        │                   tool_result processor               │
        │                   (aggregates, loops back to LLM)     │
        │                             │                         │
        │                             └──────────┐             │
        │                                        ▼             │
        │                               LLM_CALL event          │
        │                               (next iteration)        │
        │                                        │             │
        └────────────────────────────────────────┘             │
                                                               │
                                             Response to user ◄┘
```

## Hooking into any event type

Your processors can intercept any event type. Here's a processor that forwards
LLM result metadata without creating duplicate accounting rows:

```typescript
// resources/processors/usage-logger/index.ts
export default {
  eventType: "LLM_RESULT",
  id: "usage-logger",
  priority: 50, // Run before built-in but don't claim

  shouldProcess: (event) => event.type === "LLM_RESULT",

  process: async (event, deps) => {
    const usage = event.payload?.usage;
    const attemptId = event.metadata?.llmAttemptId;

    await sendToObservabilitySink({
      threadId: event.threadId,
      attemptId,
      provider: event.payload?.provider,
      model: event.payload?.model,
      usage,
      namespace: deps.context.namespace,
    });

    return undefined; // Pass — let built-in handle the rest
  },
};
```

A processor that intercepts incoming messages to add context:

```typescript
// resources/processors/context-injector/index.ts
export default {
  eventType: "NEW_MESSAGE",
  id: "context-injector",
  priority: 200, // Run first

  shouldProcess: (event) => event.payload?.sender?.type === "user",

  process: async (event, deps) => {
    // Fetch user context from your database
    const userId = event.payload?.sender?.externalId;
    const userContext = userId ? await fetchUserContext(userId) : null;

    if (userContext) {
      // Inject context into thread metadata for downstream processors
      await deps.db.threads.update(event.threadId, {
        metadata: {
          ...deps.thread.metadata,
          userContext,
        },
      });
    }

    return undefined; // Pass
  },
};
```

## Custom event types

You can emit custom event types to the stream. These are received by the client
as-is:

```typescript
// In a processor
deps.emitToStream({
  type: "APPROVAL_REQUIRED",
  payload: {
    toolKey: "delete_record",
    message: "Agent wants to delete a record. Confirm?",
  },
});
```

On the client:

```typescript
for await (const event of result.events) {
  if (event.type === "APPROVAL_REQUIRED") {
    const confirmed = await showConfirmDialog(event.payload.message);
    // Handle approval...
  }
}
```

## What this unlocks

- Complete visibility into the agent lifecycle
- Hook into any stage: message intake, LLM calls, tool execution, or results
- Custom observability, logging, and tracing at the framework level
- Approval workflows, rate limiting, content moderation — all expressible as
  processors
- The ability to build entirely custom runtime behaviors by replacing built-in
  processors

## What's next

You now control the runtime completely. But your agent is still only as smart as
its training data plus what users tell it in the conversation. What about the
proprietary knowledge your company has accumulated — your documentation, your
customer records, your product knowledge base? That's where RAG comes in.

→
**[Chapter 11: Debugging & Observability](./11-debugging-and-observability.md))**
