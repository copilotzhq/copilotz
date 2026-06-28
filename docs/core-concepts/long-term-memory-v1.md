---
title: Long-Term Conversation Memory V1
description: How Copilotz replaces old prompt history with a single stable memory checkpoint to preserve context and keep provider caches warm.
section: Core Concepts
order: 65
status: stable
---

# Long-Term Conversation Memory V1

Copilotz periodically replaces old prompt history with one finalized,
already-rendered `long_term_memory` node.

When accumulated agent-visible characters cross a configured threshold, a
lightweight observer reserves the next node with `status: "pending"`. Its normal
graph outbox event, `long_term_memory.created`, invokes the bundled processor,
which finalizes that same node from:

- a short work-state summary;
- memory-item nodes extracted from the closed history;
- relevant older memory items found through embeddings;
- relations between those items.

The node is single-assignment: it moves from `pending` to `ready` exactly once
and is then immutable. The conversation runtime does not know how it was
produced — it reads only the latest ready node's `content` and
`sourceEndMessageId`.

A project can replace the bundled processor for `long_term_memory.created` with
any other processor that satisfies the same node contract.

## Why this is enough

Within one long-term-memory version, recent messages only append:

```text
system + long-term memory 3 + message 31
system + long-term memory 3 + message 31 + answer 31 + message 32
system + long-term memory 3 + message 31 + answer 31 + message 32 + ...
```

The provider can reuse the stable prefix. When recent history crosses the
configured threshold, Copilotz reserves and finalizes long-term memory 4. That
rollover causes one expected cache rebuild, after which append-only reuse
resumes.

Raw messages are never deleted or rewritten.

## Scope

V1 covers four concepts:

1. One memory space per thread.
2. Append-only memory-item nodes and native relation edges.
3. Single-assignment `long_term_memory` checkpoint nodes.
4. Existing graph lifecycle events and the existing processor chain.

Out of scope for V1: participant or agent memory spaces, multiple simultaneous
memory providers, a separate memory-head table, a custom memory event type, or a
separate consolidation-job node.

## Data model

### Thread memory space

Every thread that crosses the consolidation threshold owns one memory space:

```ts
{
  namespace,
  type: "memory_space",
  name: `thread:${threadId}`,
  data: {
    kind: "thread",
    ownerNodeId: threadId,
    threadId
  },
  sourceType: "thread",
  sourceId: threadId
}
```

```text
Thread ──owns_memory_space──> Memory Space
```

`namespace` is the tenant boundary. `memory_space` is the memory scope. Future
participant, agent, and shared spaces reuse this node type.

### Memory item

Each item is a small, standalone, searchable statement:

```ts
{
  namespace,
  type: "memory_item",
  name: "Short stable label",
  content: "Self-contained statement about the conversation.",
  embedding: [/* vector */],
  data: {
    memorySpaceId,
    checkpointId,
    kind: "decision",
    name: "Short stable label",
    content: "Self-contained statement about the conversation.",
    confidence: 0.94,
    sourceMessageIds: ["message-id"]
  },
  sourceType: "long_term_memory",
  sourceId: checkpointId
}
```

```text
Memory Space ──has_memory_item──> Memory Item
```

Supported item kinds:

```text
entity, fact, claim, decision, preference, task, event, constraint
```

Relations between items use native graph edges:

```text
related_to, supports, contradicts, depends_on, supersedes
```

Items are append-only. Changed knowledge creates a new item and, when known, a
`supersedes` edge to the older item. The LLM may supersede only an older item
that the framework included in its consolidation input.

### Long-term memory checkpoint

This node is both the checkpoint and the generic framework contract:

```ts
interface LongTermMemoryData {
  schemaVersion: "1";
  strategy: string;
  status: "pending" | "ready" | "failed";
  threadId: string;
  memorySpaceId: string;
  sequence: number;
  agentId: string;
  sourceStartMessageId: string;
  sourceEndMessageId: string;
  contentHash?: string;
  tokenEstimate?: number;
  error?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}
```

The threshold observer reserves the boundary:

```ts
{
  namespace,
  type: "long_term_memory",
  name: `thread:${threadId}:memory:${sequence}`,
  content: null,
  embedding: null,
  data: {
    schemaVersion: "1",
    strategy: "checkpointed_graph",
    status: "pending",
    threadId,
    memorySpaceId,
    sequence,
    agentId,
    sourceStartMessageId,
    sourceEndMessageId
  },
  sourceType: "thread",
  sourceId: threadId
}
```

Creating this node automatically writes a normal-priority
`long_term_memory.created` event through the mutation outbox. No processor
constructs or emits a separate memory event.

The memory processor finalizes that same node:

```ts
{
  content: `## LONG-TERM CONVERSATION MEMORY

### Work state
...

### Relevant memory
...

### Relationships
...`,

  embedding: [/* vector */],
  data: {
    ...existingData,
    status: "ready",
    contentHash,
    tokenEstimate,
    metadata: {
      processorVersion: "v1"
    }
  }
}
```

```text
Memory Space ──has_long_term_memory──> Long-Term Memory
Long-Term Memory ──includes_memory_item──> Memory Item
```

The active version is the linked, ready node with the highest sequence. Pending
nodes are never inserted into LLM context. No separate head record is needed.

## Runtime flow

```text
agent response creates message node
        |
        v
message.created
        |
        +--> threshold observer returns void
        |       |
        |       +-- below threshold: do nothing
        |       |
        |       +-- threshold crossed:
        |             create pending long_term_memory
        |                       |
        |                       v
        |             outbox emits normal-priority
        |             long_term_memory.created
        |                       |
        |                       v
        |             bundled memory processor
        |                       |
        |                       v
        |             finalize same node as ready
        |
        +--> normal message.created processing continues


next LLM request
        |
        v
load latest ready long_term_memory
        |
        v
insert its content + messages after sourceEndMessageId
```

### Read path

When assembling an LLM request, `new_message`:

1. Loads the thread's highest-sequence ready `long_term_memory`.
2. Inserts the stored `content` into the system prompt before recent conversation
   history.
3. Loads raw messages after `sourceEndMessageId`.
4. Runs the agent-specific history generator on those messages.

If no memory exists, full-history behavior remains unchanged.

The read path does not inspect the strategy, memory items, or relations.

### Threshold observer

A small built-in observer runs on every `message.created` event. It only
considers agent messages and:

1. Stops immediately if another long-term-memory node is already pending.
2. Loads the latest ready long-term memory.
3. Reads subsequent messages and counts model-visible characters.
4. Returns `void` when the threshold has not been reached.
5. If the threshold is crossed, creates one pending `long_term_memory` node
   containing the closed source boundary.
6. Creates it with `EVENT_PRIORITIES.NORMAL` (`0`) and queue status `pending`.
   Settlement (`3000`), user input (`2000`), and agent continuation (`~1000`)
   are selected first; consolidation runs in the background under the same
   thread worker.
7. Returns `void`, so the normal `message.created` processor still runs.

The observer performs no LLM or embedding work. Reservation failures are logged
and swallowed so memory cannot block normal message handling.

The reserved `agentId` is the agent that authored the `message.created` event
which crossed the threshold. The node preserves that choice so processing is
stable if the lifecycle event is delivered more than once.

### Bundled processor

The bundled processor handles `long_term_memory.created`. It:

1. Loads the reserved node from `event.subjectId`.
2. Returns immediately if that node is already ready or failed (idempotent
   retry).
3. Loads messages in the reserved source range and projects them through the
   shared-memory filter (excludes private reasoning and requester-only tool
   results).
4. Generates a query embedding from the projected conversation text.
5. Retrieves relevant older memory items from the thread's memory space using
   vector similarity.
6. Calls the reserved agent's LLM to produce a structured consolidation
   proposal. The system prompt is built with `contextGenerator` — the same
   construction used for normal chat turns — so the provider can reuse its KV
   cache on the stable agent-context prefix. The consolidation-specific
   content (conversation range, older items, JSON schema) is placed in the user
   message. JSON output mode is requested; the LLM returns raw structured data,
   not conversational text.
7. Validates and parses the proposal.
8. Embeds each proposed memory item.
9. Renders one final memory string.
10. Atomically creates the memory items and relation edges, updates the
    checkpoint node with `status: "ready"`, content, embedding, `contentHash`,
    and derived metadata.

Finalization is the commit marker. A pending or failed node is harmless: the
read path continues using the preceding ready version.

The LLM returns only structured data:

```ts
interface ConsolidationProposal {
  workState: string;
  items: Array<{
    localId: string;
    kind: string;
    name: string;
    content: string;
    confidence?: number;
    sourceMessageIds?: string[];
    supersedesItemId?: string;
  }>;
  relations: Array<{
    source: string;
    type: string;
    target: string;
  }>;
}
```

Framework code validates the proposal, creates embeddings, retrieves older
items, and renders the final content. The LLM never writes to the database.

## Replacement contract

A project may register a higher-priority processor that claims
`long_term_memory.created` and finalizes the reserved node differently — for
example, prose-only summarization, an external memory service, or a
domain-specific knowledge model.

Only one processor owns long-term memory in a runtime. V1 does not define
composition between competing processors.

The replacement contract is minimal:

```text
Threshold observer reserves:
  long_term_memory.data.status = "pending"
  long_term_memory.data.sourceEndMessageId

Outbox emits:
  long_term_memory.created

Memory processor finalizes:
  long_term_memory.content
  long_term_memory.data.status = "ready"

Conversation runtime reads:
  latest ready content
  latest ready sourceEndMessageId
```

Everything else is an implementation detail behind the
`long_term_memory.created` lifecycle event.

## Configuration

The bundled strategy uses `MemoryResource.config`:

```ts
const longTermMemory: MemoryResource = {
  name: "long_term",
  kind: "long_term",
  enabled: true,
  config: {
    triggerChars: 80_000,
    maxContentChars: 48_000,
    retrievalLimit: 20,
  },
};
```

The bundled resource is disabled by default; applications opt in.

There is no separate memory LLM configuration. The processor resolves and reuses
the reserved agent's existing `llmOptions`, including provider, model,
credentials, usage, and cost attribution.

Embeddings reuse Copilotz's existing `embeddingConfig`.

## Character threshold

The observer counts the same text eligible for normal model history:

- visible user and agent content;
- projected tool results allowed by history policy;
- no private reasoning or hidden framework metadata.

Characters are deterministic and cheap. The existing `limitEstimatedInputTokens`
remains the final safety limit for the complete request.

For the first checkpoint, the observer pages backward from the triggering
message and stops once the threshold is reached. For later checkpoints,
`sourceStartMessageId` is the first eligible message after the previous ready
`sourceEndMessageId`; the complete delta is retained.

## Correctness

### Retry

The pending node records the intended boundary before any processing. On
re-delivery:

- if the node is already ready, the retry is a no-op;
- if it is failed, the retry is also a no-op;
- otherwise it repeats consolidation and finalizes that same node.

Item, relation, and ready-node mutations commit atomically. If any step fails,
the processor marks the reservation `failed`. A later agent response may reserve
a new checkpoint from the previous ready boundary.

### Multi-agent safety

Thread long-term memory contains only history visible to every participant. It
excludes requester-only tool results, private reasoning, and private
participant/agent memory.

Agent-specific recent history continues to use the existing history generator.

### Existing threads

The first consolidation uses the most recent eligible history up to the
configured threshold. Older raw history remains stored but is not automatically
backfilled.

## File structure

```text
resources/
  processors/
    long_term_memory_trigger/
      index.ts        — message.created observer; reserves pending node
    long_term_memory/
      index.ts        — long_term_memory.created handler; finalizes node

runtime/
  memory/
    long-term.ts      — strategy-neutral read helpers used by new_message
    resources.ts      — MemoryResource config helpers
    identity.ts       — participant identity helpers
```

`resources/core.ts` registers the trigger before the normal `message.created`
processor and registers the bundled handler for `long_term_memory.created`.
