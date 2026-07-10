---
name: add-processor
description: Create a custom processor to react to Copilotz lifecycle events.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, events, processor]
---

# Add Processor

Custom processors let you react to Copilotz lifecycle events and mutate domain
state.

Prefer domain mutations such as `deps.db.ops.mutate.messages.create(...)`,
`deps.db.ops.mutate.llmAttempts.update(...)`, and
`deps.db.ops.mutate.toolExecutions.complete(...)`. These write the graph/table
change and append a durable outbox row in one transaction. Returning
`producedEvents` is still supported for legacy custom processors and live stream
compatibility, but it should not be the first choice for durable workflow state.

## Directory Structure

```
resources/processors/{purpose}/{event_subject}.{operation}.ts
```

The directory is the processor purpose. The file name mirrors the durable event,
for example `message.created.ts`, `llm_attempt.completed.ts`, or
`tool_execution.failed.ts`. Legacy `eventType`/`index.ts` processors still load
for compatibility, but new processors should export `eventTypes`.

## Create the event file

```typescript
import type { EventProcessor, ProcessorDeps } from "copilotz";

export const processorId = "message_moderation";
export const eventTypes = ["message.created"] as const;

const processor: EventProcessor = {
  shouldProcess: (event, deps: ProcessorDeps) => {
    // Return true to handle this event
    return event.payload.metadata?.requiresModeration === true;
  },

  process: async (event, deps: ProcessorDeps) => {
    const { db, thread, context } = deps;

    // Your custom logic
    const content = event.payload.content;
    const isOk = await moderateContent(content);

    if (!isOk) {
      await db.ops.mutate.messages.create(
        {
          threadId: event.threadId,
          senderType: "system",
          senderId: "moderator",
          content: "This message was flagged.",
          metadata: { causationId: event.id },
        },
        context.namespace,
        {
          traceId: event.traceId,
          causationId: event.id,
        },
      );
    }

    return {};
  },
};

export default processor;
```

## ProcessorDeps

| Field     | Type        | Description                                   |
| --------- | ----------- | --------------------------------------------- |
| `db`      | CopilotzDb  | Database instance with full ops access        |
| `thread`  | Thread      | Current conversation thread                   |
| `context` | ChatContext | Full pipeline context (agents, tools, config) |

## Event Types

Common lifecycle events:

- `message.created` — Message aggregate created
- `llm_attempt.created` — LLM provider attempt started
- `llm_attempt.completed` — LLM provider attempt finished
- `llm_attempt.failed` — LLM provider attempt failed or recovered
- `tool_execution.created` — Tool invocation started
- `tool_execution.completed` — Tool invocation finished
- `asset.created` — Asset node created

Live uppercase events such as `TOKEN`, `TOOL_CALL`, `TOOL_RESULT`, and
`LLM_RESULT` are stream projections for clients.

## Priority

Export a `priority` number (higher runs first):

```typescript
export const priority = 10; // Runs before priority 0 (default)
```

This sorting applies within processors discovered from the resource filesystem.
The final chain places file-loaded user processors before inline config
processors and bundled processors. Inline processors preserve array order and
are not globally re-sorted by their `priority` fields.

## Claiming and swallowing

For the compatibility `producedEvents` contract:

- Return `undefined` or `void` to continue to the next processor.
- Return `{ producedEvents: [...] }` to enqueue new events and skip the rest of
  the chain.
- Return `{ producedEvents: [] }` to skip the rest of the chain without
  enqueueing anything.

This overrides downstream handling, not the original durable fact. The input
queue row remains and is normally completed; produced events are separate queue
rows. Swallowing does not undo an already-committed domain mutation. Public
stream events are also emitted before processor execution, so swallowing cannot
retract an event already delivered to a client.

## Notes

- Processors are loaded from `resources/processors/` automatically
- Multiple processors can handle the same event type
- Use `ops.mutate.*` for durable state changes and outbox facts
- Return `producedEvents` only for legacy compatibility or deliberate stream
  projections
