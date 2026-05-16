---
title: "Ch 11: Debugging & Observability"
description: "Event stream inspection, cost tracking, processor-based export, and the events table."
section: Getting Started
order: 110
status: stable
---

# Chapter 11: Debugging & Observability

> **Part 5 — Controlling the Runtime**

## The pain

Something is wrong. The agent called the wrong tool. It ignored a document it should have found. Costs spiked overnight. A user says it "forgot" something from earlier in the conversation.

You add a `console.log`. It tells you what the user sent. It doesn't tell you what the LLM actually received — the full system prompt, the tool list, the history — or what it decided to do and why. You're debugging a black box with no windows.

## The solution

Every `copilotz.run()` emits a typed event stream that exposes every decision the agent makes. You can watch it in real time, store it, or forward it to any observability platform. Beyond the event stream, Copilotz automatically records token and cost data for every LLM call — queryable, per-tenant, indexed by thread and model.

Three layers:

1. **The event stream** — live, per-run observability
2. **`llm_usage` collection** — automatic cost and token tracking
3. **Custom processors** — forward any event to Datadog, Langfuse, OpenTelemetry, or your own sink

## Layer 1: The event stream

Every call to `copilotz.run()` returns a `RunHandle` with an `events` async iterable. Consume it to see exactly what happened:

```typescript
const result = await copilotz.run({
  content: "What's our return policy?",
  sender: { type: "user", name: "Alice" },
});

for await (const event of result.events) {
  switch (event.type) {
    case "LLM_CALL":
      // The full prompt that was sent to the model
      console.log("[LLM_CALL] agent:", event.payload.agent.name);
      console.log("[LLM_CALL] messages:", event.payload.messages.length);
      console.log("[LLM_CALL] tools available:", event.payload.tools.map(t => t.name));
      break;

    case "LLM_RESULT":
      // What the model decided
      console.log("[LLM_RESULT] answer:", event.payload.answer);
      console.log("[LLM_RESULT] tool calls:", event.payload.toolCalls);
      console.log("[LLM_RESULT] finish reason:", event.payload.finishReason);
      break;

    case "TOOL_CALL":
      console.log("[TOOL_CALL]", event.payload.toolCall?.tool?.name, event.payload.toolCall?.args);
      break;

    case "TOOL_RESULT":
      console.log("[TOOL_RESULT]", JSON.stringify(event.payload.result).slice(0, 200));
      break;

    case "TOKEN":
      process.stdout.write(event.payload.token ?? "");
      break;
  }
}

await result.done;
```

### The full event reference

| Event | When it fires | Key payload fields |
|---|---|---|
| `NEW_MESSAGE` | Message received, before any processing | `content`, `sender`, `threadId` |
| `LLM_CALL` | Just before the LLM is called | `agent`, `messages` (full history), `tools` (full list), `config` |
| `TOKEN` | Each streamed token | `token`, `isReasoning` |
| `LLM_RESULT` | After the LLM responds | `answer`, `toolCalls`, `provider`, `model`, `finishReason`, `status` |
| `TOOL_CALL` | Agent decided to call a tool | `toolCall.tool.name`, `toolCall.args` |
| `TOOL_RESULT` | Tool finished executing | `result`, `toolCall` |
| `RAG_INGEST` | Document ingestion queued | `source`, `title` |
| `ENTITY_EXTRACT` | Entity extraction queued | `content`, `namespace` |

`LLM_CALL` is the most diagnostic. It shows the exact prompt construction — the system prompt, the conversation history, every tool description — which is what the model actually sees when it makes a decision.

## Trace IDs

Every run is assigned a `traceId`. All events in that run share it. You can pass your own trace ID to correlate Copilotz runs with your application's distributed trace:

```typescript
const myTraceId = crypto.randomUUID(); // or pull from your tracing context

const result = await copilotz.run(
  { content: "Hello", sender: { type: "user", name: "Alice" } },
  { traceId: myTraceId }
);
```

The same `traceId` appears on `LLM_CALL` and `LLM_RESULT` events, so you can join Copilotz events with your own spans in any observability backend.

## Layer 2: `llm_usage` — cost and token tracking

Every LLM call automatically writes a record to the `llm_usage` collection:

```typescript
const db = copilotz.collections.withNamespace("acme");

// All LLM calls in the last 24h for a specific thread
const usage = await db.llm_usage.find({ threadId: "thread-abc" });

// Aggregate across all threads for a namespace
const allUsage = await db.llm_usage.find({});
const totalTokens = allUsage.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
const totalCostUsd = allUsage.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0);

console.log(`Total: ${totalTokens} tokens, $${totalCostUsd.toFixed(4)}`);
```

Each record contains:

| Field | What it is |
|---|---|
| `threadId` | The conversation this call belongs to |
| `agentId` | Which agent made the call |
| `provider` / `model` | e.g. `"openai"` / `"gpt-4o"` |
| `promptTokens` | Input tokens |
| `completionTokens` | Output tokens |
| `totalTokens` | Sum |
| `inputCostUsd` | Cost of input tokens |
| `outputCostUsd` | Cost of output tokens |
| `totalCostUsd` | Total cost |
| `reasoningTokens` | Reasoning tokens (o1/DeepSeek-R1) |
| `cacheReadInputTokens` | Prompt cache hits |

The collection is indexed by `threadId`, `provider`, and `model`, so filtering by any of these is fast.

### The admin feature gives you aggregates

Once the `admin` preset is loaded, `features/admin/overview` and `features/admin/activity` expose pre-built aggregations without writing any query code:

```
GET /api/features/admin/overview?namespace=acme
→ { threadTotals, messageTotals, queueTotals, llmTotals: { totalCalls, totalTokens, totalCostUsd, ... } }

GET /api/features/admin/activity?namespace=acme&interval=day&from=2025-01-01
→ [{ bucket, messageCount, llmCallCount, totalTokens, totalCostUsd, ... }]
```

## Layer 3: Processor-based export

For production observability — Langfuse, Datadog, OpenTelemetry, a custom data warehouse — write a processor that intercepts `LLM_RESULT` events and forwards what you need:

```typescript
// resources/processors/observability/index.ts
import type { EventProcessor, ProcessorDeps } from "@copilotz/copilotz";

export const observabilityProcessor: EventProcessor = {
  shouldProcess: (event) => event.type === "LLM_RESULT",

  process: async (event, deps) => {
    const payload = event.payload as {
      agent: { name: string };
      provider?: string;
      model?: string;
      answer?: string;
      toolCalls?: unknown[];
      traceId?: string;
      llmCallId?: string;
    };

    // Forward to your observability platform
    await fetch("https://api.yourplatform.com/traces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("OBSERVABILITY_API_KEY")}`,
      },
      body: JSON.stringify({
        traceId: payload.traceId,
        spanId: payload.llmCallId,
        agent: payload.agent.name,
        provider: payload.provider,
        model: payload.model,
        hasToolCalls: (payload.toolCalls?.length ?? 0) > 0,
        threadId: deps.context?.threadId,
        namespace: deps.context?.namespace,
        timestamp: new Date().toISOString(),
      }),
    });

    return { producedEvents: [] };
  },
};

export default observabilityProcessor;
```

The same pattern works for `LLM_CALL` (to log prompts), `TOOL_CALL`/`TOOL_RESULT` (to trace tool latency), or any other event type.

## Layer 4: The events table — post-mortem debugging

The event stream shows what's happening right now. The `llm_usage` collection tracks cost over time. But when something went wrong an hour ago — or when you need to understand a background process that never surfaced in a live stream — the `events` table is the authoritative record.

Every queue event Copilotz processes is persisted to this table: its `type`, full `payload` (JSONB), `status`, `traceId`, `parentEventId`, `namespace`, and `createdAt`. This includes events that run asynchronously after the main response — `RAG_INGEST`, `ENTITY_EXTRACT`, background tool calls — which never appear in the live stream at all.

Query it via `copilotz.ops.query()`:

```typescript
// Pull the full trace for a run — everything that happened, in order
const trace = await copilotz.ops.query(
  `SELECT type, status, created_at, payload
   FROM events
   WHERE trace_id = $1
   ORDER BY created_at ASC`,
  [myTraceId],
);

// Find failed events in a namespace over the last hour
const failures = await copilotz.ops.query(
  `SELECT id, type, status, payload->>'error' AS error, created_at
   FROM events
   WHERE namespace = $1
     AND status = 'failed'
     AND created_at > NOW() - INTERVAL '1 hour'
   ORDER BY created_at DESC`,
  ["acme"],
);

// Find events that are stuck in 'processing' (may indicate a crashed worker)
const stuck = await copilotz.ops.query(
  `SELECT id, type, created_at
   FROM events
   WHERE status = 'processing'
     AND created_at < NOW() - INTERVAL '5 minutes'`,
  [],
);
```

### Reading the event tree

`parentEventId` captures the causal chain. An `LLM_RESULT` that triggers a tool call will be the parent of the resulting `TOOL_CALL` event. Reconstructing this gives you the full decision tree for any run:

```typescript
// Reconstruct the causal tree for a trace
const tree = await copilotz.ops.query(
  `WITH RECURSIVE event_tree AS (
     -- Start from the root (no parent)
     SELECT id, type, parent_event_id, status, created_at, 0 AS depth
     FROM events
     WHERE trace_id = $1 AND parent_event_id IS NULL

     UNION ALL

     SELECT e.id, e.type, e.parent_event_id, e.status, e.created_at, et.depth + 1
     FROM events e
     JOIN event_tree et ON e.parent_event_id = et.id
   )
   SELECT depth, type, status, created_at
   FROM event_tree
   ORDER BY created_at ASC`,
  [myTraceId],
);
```

### What each status means

| Status | Meaning |
|---|---|
| `pending` | Queued, not yet picked up |
| `processing` | Currently executing |
| `completed` | Finished successfully |
| `failed` | Threw an error — check `payload` for the error details |
| `expired` | Timed out before being processed |
| `overwritten` | Superseded by a newer event before it ran |

`failed` + inspecting `payload` is the fastest path to a root cause on any background event. `processing` with an old timestamp is a reliable signal for a hung or crashed worker.

### Background events

The events table is the only place async background events appear after the response is returned. If a user's message triggered document ingestion and it failed silently, query for `type = 'RAG_INGEST'` and `status = 'failed'` in that namespace and time window — the `payload` will contain the error.

## Common debugging scenarios

**"Why did the agent pick the wrong tool?"**
Log the `LLM_CALL` event and inspect `event.payload.tools` — you'll see every tool description the model received. Too many tools? See Chapter 6 on skills. A confusing description? Update your tool's `description` field.

**"Why is the agent looping / not terminating?"**
A processor that counts `LLM_CALL` events per thread and logs a warning after N calls will surface this immediately. The `max_iterations` config on the agent is the hard stop; use the processor to catch soft loops early.

**"Why didn't RAG find the right document?"**
Log `LLM_CALL` and look at the injected context in the system message — it shows what chunks were retrieved. Also check the similarity threshold in `rag.retrieval.similarityThreshold`; raising it filters out weak matches.

**"Costs spiked last night — what happened?"**
Query `llm_usage` filtered by `createdAt` range. Compare `promptTokens` across threads; unusually high counts indicate either very long conversation history or runaway loops.

## What this unlocks

- See the exact prompt, tool list, and history sent to the model on every call
- Trace IDs for correlating agent runs with your application's distributed traces
- Automatic cost and token tracking per thread, agent, model, and provider — no setup required
- A processor hook to ship any event to any observability backend
- Pre-built admin aggregations for live deployment monitoring
- The `events` table as a permanent, queryable audit log — every LLM call, tool call, and background event, with causal links via `parentEventId`

## What's next

Your agent is now inspectable, measurable, and debuggable. The next question is: what does it know? Out of the box, it only knows what its training data contains. To answer questions about your product, your policies, or your internal documentation, you need to bring that knowledge in at runtime.

→ **[Chapter 12: RAG](../part-6-memory/12-rag.md)**
