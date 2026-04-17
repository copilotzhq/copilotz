# Events

Copilotz is event-driven. Every action — receiving a message, calling an LLM, executing a tool — is an event that flows through a processing pipeline. This architecture makes Copilotz observable, extensible, and reliable.

## Why Events?

Traditional AI frameworks use direct function calls:

```
User message → Call LLM → Return response
```

Copilotz uses events:

```
User message → NEW_MESSAGE event → Queue → Processor → LLM_CALL event → ...
```

**Why does this matter?**

- **Persistence**: Events are stored in the database. If something fails, you can see exactly what happened.
- **Reliability**: Failed events can be retried. Nothing is lost.
- **Observability**: Hook into any part of the pipeline for logging, analytics, or debugging.
- **Extensibility**: Add custom processors to handle new event types or modify existing behavior.
- **Background processing**: Heavy work (RAG ingestion, entity extraction) happens asynchronously.

## Event Types

### Core Events

| Event | Description | Persisted |
|-------|-------------|-----------|
| `NEW_MESSAGE` | A persisted message/history artifact entered the system | Yes |
| `LLM_CALL` | Time to call an LLM (safe persisted config only) | Yes |
| `LLM_RESULT` | Terminal state for one LLM execution | Yes |
| `TOOL_CALL` | Execute a tool | Yes |
| `TOOL_RESULT` | Terminal state for one tool execution | Yes |
| `TOKEN` | A streaming token | No |

### Background Events

| Event | Description |
|-------|-------------|
| `RAG_INGEST` | Ingest a document into the knowledge base |
| `ENTITY_EXTRACT` | Extract entities from content |

## Event Flow

Here's what happens when you call `copilotz.run()`:

```
┌─────────────────────────────────────────────────────────────┐
│                    copilotz.run(message)                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    NEW_MESSAGE Event                        │
│  - Message persisted to database                            │
│  - Message added to knowledge graph                         │
│  - Target agents discovered                                 │
│  - RAG context retrieved (if enabled)                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     LLM_CALL Event                          │
│  - Context built (history, tools, RAG chunks)               │
│  - Safe `LLMConfig` persisted and streamed                   │
│  - LLM called                                               │
│  - TOKEN events streamed (if streaming)                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    LLM_RESULT Event                         │
│  - Final answer / reasoning summarized                      │
│  - Tool calls normalized                                    │
│  - Usage / timing attached                                  │
│  - Follow-up NEW_MESSAGE artifact emitted                   │
└─────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┴─────────────────┐
            │                                   │
            ▼                                   ▼
┌───────────────────────┐           ┌───────────────────────┐
│     TOOL_CALL (1)     │           │     TOOL_CALL (2)     │
│  - Tool execution     │           │  - Tool execution     │
│    requested          │           │    requested          │
└───────────────────────┘           └───────────────────────┘
            │                                   │
            └─────────────────┬─────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   TOOL_RESULT Event(s)                      │
│  - Output/error captured                                    │
│  - Batch metadata tracked                                   │
│  - Follow-up NEW_MESSAGE artifact emitted                   │
│  - Cycle continues until final response                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Background Events                        │
│  - ENTITY_EXTRACT: Extract entities from messages           │
│  - Knowledge graph updated                                  │
└─────────────────────────────────────────────────────────────┘
```

## Assistant-Initiated Tool Calls

Custom processors and external adapters can trigger tool execution by emitting a `NEW_MESSAGE` event from an agent with top-level `toolCalls`.

Canonical shape:

```typescript
{
  type: "NEW_MESSAGE",
  payload: {
    sender: { type: "agent", id: "assistant", name: "Assistant" },
    content: "",
    toolCalls: [
      {
        id: crypto.randomUUID(),
        name: "getWeather",
        args: { city: "Sao Paulo" },
      },
    ],
  },
}
```

Notes:

- Use top-level `payload.toolCalls`, not provider-native response formats
- Use the normalized assistant shape `{ id, name, args }`
- Copilotz emits `TOOL_CALL` events from these assistant messages before target resolution
- This allows agent follow-up messages from custom processors to directly continue the tool chain

## Event Taxonomy

- Lifecycle events: `LLM_CALL`, `LLM_RESULT`, `TOOL_CALL`, `TOOL_RESULT`
- Progress events: `TOKEN`
- History/artifact events: `NEW_MESSAGE`
- Background/domain events like `RAG_INGEST` and `ENTITY_EXTRACT` remain outside the paired lifecycle model in this refactor

## Listening to Events

### Callback Function

Pass a callback to `run()` to receive events in real-time:

```typescript
const result = await copilotz.run(
  message,
  (event) => {
    switch (event.type) {
      case "TOKEN":
        console.log(event.payload.token);
        break;
      case "TOOL_CALL":
        console.log(`Calling tool: ${event.payload.toolCall.tool.id}`);
        break;
      case "TOOL_RESULT":
        console.log(`Tool finished: ${event.payload.toolCallId}`);
        break;
      case "LLM_RESULT":
        console.log(`LLM finished: ${event.payload.llmCallId}`);
        break;
      case "NEW_MESSAGE":
        console.log(`Message from: ${event.payload.sender?.name}`);
        break;
    }
  },
  { stream: true }
);

await result.done;
```

### Async Iterator

Use the event stream for more control:

```typescript
const result = await copilotz.run(message, undefined, { stream: true });

for await (const event of result.events) {
  if (event.type === "TOKEN") {
    process.stdout.write(event.payload.token);
  }
}
```

### Consuming Events

Consume events from the `result.events` async iterator returned by `copilotz.run()`:

```typescript
const result = await copilotz.run({ content: "Hello" }, { stream: true });
for await (const event of result.events) {
  if (event.type === "TOKEN") {
    process.stdout.write(event.payload.token);
  } else {
    console.log(`Event: ${event.type}`, event.payload);
  }
}
```

## Custom Processors

Replace or extend built-in processing:

```typescript
const copilotz = await createCopilotz({
  agents: [...],
  processors: [{
    eventType: "NEW_MESSAGE",
    shouldProcess: (event, deps) => {
      return event.payload.metadata?.needsApproval === true;
    },
    process: async (event, deps) => {
      const approved = await checkApproval(event.payload);
      
      if (!approved) {
        // Override: produce a system message instead of the default flow
        return { 
          producedEvents: [{
            type: "NEW_MESSAGE",
            payload: {
              content: "This message requires approval.",
              sender: { type: "system", name: "System" },
            },
          }],
        };
      }
      
      // Pass: return void to let the built-in processor handle it
    },
  }],
});
```

### Processor Interface

```typescript
interface EventProcessor {
  eventType: string;
  shouldProcess: (event: Event, deps: ProcessorDeps) => boolean | Promise<boolean>;
  process: (event: Event, deps: ProcessorDeps) => Promise<ProcessorResult | void>;
}

interface ProcessorResult {
  producedEvents: Event[];
}
```

### Return Semantics

The return value of `process` controls how the processor pipeline behaves:

| Return value                       | Behavior                                                     |
|------------------------------------|--------------------------------------------------------------|
| `{ producedEvents: [event, ...] }` | **Claim** — enqueue events, skip remaining processors        |
| `{ producedEvents: [] }`           | **Swallow** — claim without producing, skip remaining processors |
| `void` / `undefined`               | **Pass** — fall through to the next processor in priority order |

This means you can:
- **Override** a built-in processor by returning `{ producedEvents: [...] }`.
- **Suppress** an event entirely by returning `{ producedEvents: [] }` (no events produced, built-in won't run).
- **Observe** an event without interfering by returning `void` (built-in still runs after).

### Processing Order

Processors are executed in priority order for the matching event type:

1. User-provided processors (from `createCopilotz({ processors: [...] })`)
2. Built-in processors (NEW_MESSAGE, LLM_CALL, TOOL_CALL, etc.)

The first processor to return `{ producedEvents }` (even an empty array) claims the event. If no processor claims it, the event is marked completed with no side effects.

## Event Queue

Events are stored in a persistent queue:

```typescript
// Queue fields
{
  id: "ulid",
  threadId: "thread-ulid",
  type: "NEW_MESSAGE",
  payload: { ... },
  status: "pending",        // pending, processing, completed, failed
  priority: 100,            // Higher = processed first
  ttl: 3600000,            // Time-to-live in ms
  traceId: "trace-uuid",   // For debugging
  parentEventId: "ulid",   // Parent event (for chains)
  namespace: "default",    // For multi-tenancy
  createdAt: "...",
  updatedAt: "...",
}
```

### Queue Operations

```typescript
// Add to queue manually
await copilotz.ops.addToQueue(threadId, {
  type: "CUSTOM_EVENT",
  payload: { ... },
});

// Check queue status
const item = await copilotz.ops.getProcessingQueueItem(threadId);

// Get next pending item
const next = await copilotz.ops.getNextPendingQueueItem(threadId, namespace);

// Update status
await copilotz.ops.updateQueueItemStatus(queueId, "completed");
```

### Crash Recovery

Copilotz automatically recovers from server crashes that occur mid-processing:

```typescript
const copilotz = await createCopilotz({
  agents: [...],
  staleProcessingThresholdMs: 300000,  // 5 minutes (default)
});
```

**How it works:**
- Events stuck in `"processing"` status for longer than the threshold are automatically reset to `"pending"`
- This prevents permanent thread deadlocks when the server crashes while processing an event
- The next time the queue is checked, stale events are recovered and reprocessed

**Configuration:**
- Default: 5 minutes (300000ms)
- Lower values (1-2 min): Faster recovery, but may reset legitimately slow operations
- Higher values (10-15 min): For operations that genuinely take a long time

See [Configuration](./configuration.md#crash-recovery) for more details.

## Token Streaming

When streaming is enabled, `TOKEN` events are emitted for each token:

```typescript
{
  type: "TOKEN",
  payload: {
    token: "Hello",        // The token text
    isComplete: false,     // True on last token
    threadId: "...",
    agentName: "Assistant",
  },
}
```

`TOKEN` events are **not persisted** — they're for real-time UI updates only.

## Background Processing

Some events are processed asynchronously:

### RAG_INGEST

```typescript
// Triggered by ingest_document tool or manually
{
  type: "RAG_INGEST",
  payload: {
    source: "https://example.com/doc.pdf",
    namespace: "docs",
    metadata: { title: "My Document" },
  },
}
```

Processing:
1. Fetch document content
2. Chunk into pieces
3. Generate embeddings
4. Store in knowledge graph

### ENTITY_EXTRACT

```typescript
// Triggered automatically after messages (low priority)
{
  type: "ENTITY_EXTRACT",
  payload: {
    content: "I talked to Sarah from Acme about the deal",
    sourceType: "message",
    sourceId: "message-uuid",
    namespace: "thread:123",
  },
}
```

Processing:
1. LLM extracts entities
2. Check for duplicates (semantic similarity)
3. Create or merge entity nodes
4. Create MENTIONS edges

## Next Steps

- [Configuration](./configuration.md) — Configure callbacks and processors
- [Database](./database.md) — Understand event storage
- [API Reference](./api-reference.md) — Full queue and event APIs
