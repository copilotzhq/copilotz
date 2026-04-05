---
name: add-processor
description: Create a custom event processor to extend the Copilotz event pipeline.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, events, processor]
---

# Add Processor

Custom event processors let you intercept and handle events in the processing pipeline.

## Directory Structure

```
resources/event-processors/{EVENT_TYPE}/
  processor.ts    # Required: exports shouldProcess + process
```

The directory name is the event type (e.g., `NEW_MESSAGE`, `CUSTOM_EVENT`).

## Create processor.ts

```typescript
import type { EventProcessor, ProcessorDeps } from "copilotz";

const processor: EventProcessor = {
    eventType: "NEW_MESSAGE",

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
            return {
                producedEvents: [{
                    type: "NEW_MESSAGE",
                    payload: {
                        content: "This message was flagged.",
                        sender: { type: "system", name: "Moderator" },
                    },
                }],
            };
        }

        return { producedEvents: [] };
    },
};

export default processor;
```

## ProcessorDeps

| Field | Type | Description |
|-------|------|-------------|
| `db` | CopilotzDb | Database instance with full ops access |
| `thread` | Thread | Current conversation thread |
| `context` | ChatContext | Full pipeline context (agents, tools, config) |

## Event Types

Common built-in event types:
- `NEW_MESSAGE` — New message in a thread
- `LLM_CALL` — LLM API call about to be made
- `TOOL_CALL` — Tool invocation
- `ENTITY_EXTRACT` — Entity extraction from messages

You can also define custom event types.

## Priority

Export a `priority` number (higher runs first):

```typescript
export const priority = 10;  // Runs before priority 0 (default)
```

## Notes

- Processors are loaded from `resources/event-processors/` automatically
- Multiple processors can handle the same event type
- Return `producedEvents` to emit new events into the pipeline
