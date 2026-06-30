---
title: "Ch 14: Long-Term Conversation Memory"
description: "Keep long conversations coherent with cache-stable checkpoints, a retained hot tail, and graph-backed memory."
section: Getting Started
order: 140
status: stable
---

# Chapter 14: Long-Term Conversation Memory

> **Part 6 — Memory & Knowledge**

## The pain

Thread history is useful because it preserves exactly what happened. It is also
the wrong shape for an indefinitely long conversation.

As history grows:

- every model request becomes larger;
- the provider repeatedly processes old messages;
- the thread eventually approaches the model's context limit;
- truncation removes information without understanding it;
- a continuously rewritten summary can lose provenance and invalidate the
  provider's reusable prompt prefix.

A simple rolling window bounds the request, but forgets everything outside the
window. A summary keeps more meaning, but one prose paragraph is a fragile place
to store decisions, constraints, relationships, and changing facts.

The goal is not to make raw history infinite. It is to keep a bounded working
conversation while preserving durable knowledge from the history that closes.

## The solution

Copilotz divides a long thread into two model-visible parts:

```text
stable agent prompt
+ stable long-term-memory checkpoint
+ recent raw messages (the hot tail)
```

The recent messages grow normally. When their estimated token count crosses a
configured threshold, Copilotz consolidates the older portion into a new
checkpoint and retains the newest complete messages as raw conversation.

The checkpoint contains:

- a short description of the current work state;
- new durable memory items extracted from the closed conversation range;
- relevant items retrieved from earlier checkpoints;
- relationships between those items.

The original messages remain stored. Consolidation changes what is sent to the
model, not the persisted thread history.

## Enable long-term memory

Long-term memory needs:

1. a Copilotz database, persistent in production;
2. an embedding configuration;
3. an enabled `long_term` memory resource.

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "assistant",
      name: "Assistant",
      role: "A persistent assistant for long-running work.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o",
        limitEstimatedInputTokens: 100_000,
      },
    },
  ],

  rag: {
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    },
  },

  memory: [
    {
      name: "long_term",
      kind: "long_term",
      enabled: true,
      config: {
        triggerEstimatedTokens: 20_000,
        retainRecentEstimatedTokens: 2_000,
        maxContentEstimatedTokens: 12_000,
        retrievalLimit: 20,
      },
    },
  ],

  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },

  dbConfig: {
    url: Deno.env.get("DATABASE_URL")!,
  },
});
```

The memory processor reuses the agent's `llmOptions`; it does not have a
separate LLM configuration. The embedding provider is configured through
`rag.embedding`.

The built-in long-term-memory resource is disabled by default. Adding the
enabled resource above opts the application in.

## The checkpoint lifecycle

Long-term memory is created asynchronously from normal graph lifecycle events:

```text
agent response
    |
    v
message.created
    |
    +-- below triggerEstimatedTokens ----------------> no memory work
    |
    +-- threshold crossed
            |
            v
       reserve long_term_memory(status: "pending")
            |
            v
       outbox emits long_term_memory.created
            |
            v
       consolidation processor
            |
            +-- success --> status: "ready"
            |
            +-- failure --> status: "failed"
```

Reservation is deliberately cheap. The `message.created` observer counts visible
tokens and creates the pending node; it does not call an LLM or an embedding
provider.

The background processor then:

1. loads the exact reserved message range;
2. projects only content eligible for shared conversation memory;
3. shows the reserved agent's LLM the previous checkpoint and asks for
   structured memory items and relations;
4. validates relations and supersession against item IDs visible in that
   checkpoint;
5. embeds the new items;
6. uses each new item to retrieve relevant earlier memory;
7. renders the checkpoint;
8. atomically stores the new nodes, edges, and ready checkpoint.

Only the latest `ready` checkpoint is inserted into model context. A `pending`
or `failed` checkpoint never replaces the preceding ready version.

## A rollover, with numbers

Consider this configuration:

```typescript
{
  triggerEstimatedTokens: 20_000,
  retainRecentEstimatedTokens: 2_000,
  maxContentEstimatedTokens: 12_000,
  retrievalLimit: 20,
}
```

Before the first rollover:

```text
agent prompt
+ approximately 20,000 estimated tokens of raw conversation
```

When the threshold is crossed, Copilotz walks backward over complete messages
until it has retained at least 2,000 estimated tokens. Everything before that boundary
becomes the source range for the checkpoint.

After the checkpoint is ready:

```text
agent prompt
+ checkpoint 1 (at most 12,000 estimated tokens)
+ approximately 2,000+ estimated tokens of retained raw messages
```

The values are approximate because Copilotz never cuts a message merely to hit
`retainRecentEstimatedTokens` exactly. A single large message can make the retained tail
larger than the configured value.

The retained messages are not copied into checkpoint 1. They remain raw and are
part of the source range considered for checkpoint 2 once they are no longer in
the newest retained tail.

This is tail retention, not duplicated overlap.

## Configuration reference

| Option              | Meaning                                                                                             | Bundled default |
| ------------------- | --------------------------------------------------------------------------------------------------- | --------------: |
| `triggerEstimatedTokens`      | Start a rollover when model-visible messages since the active checkpoint reach this estimate |        `20_000` |
| `retainRecentEstimatedTokens` | Keep at least this many newest estimated tokens as complete raw messages outside the checkpoint |             `0` |
| `maxContentEstimatedTokens`   | Maximum estimated tokens in the rendered checkpoint, preserving complete blocks |        `12_000` |
| `retrievalLimit`    | Maximum number of older memory items selected for the new checkpoint after per-item retrieval       |            `20` |

### `triggerEstimatedTokens`

This uses Copilotz's lightweight universal token estimator.

Copilotz counts the same shared content that is eligible for conversation
memory:

- visible user and agent messages;
- permitted tool-result projections;
- no private reasoning;
- no requester-only tool output;
- no hidden framework metadata.

Characters make the rollover deterministic and cheap. Token limits remain a
separate final safety mechanism.

Only an agent-authored `message.created` event attempts checkpoint reservation.
Crossing the threshold on a user message alone does not start consolidation
until an agent response is created.

Consolidation runs immediately on a dedicated child-thread queue, so it does not
block tool settlements or agent continuations in the conversation queue.

### `retainRecentEstimatedTokens`

This controls how much immediate conversational texture survives a rollover.

A larger value gives the model more verbatim continuity, but leaves less room
for new turns before the next threshold. A smaller value maximizes the runway
after consolidation, but makes the checkpoint responsible for more immediate
context.

Use `0` when no retained tail is needed. For active project work, a modest tail
such as `2_000` estimated tokens is a useful starting point.

### `maxContentEstimatedTokens`

This bounds the stable checkpoint placed in the system context. It is not the
size of the raw source range and does not limit how many items are persisted in
the graph.

The rendered checkpoint is capped after its work state, relevant items, and
relationships are assembled. Choose a value that leaves room for:

- the agent prompt and tool definitions;
- participant or application context;
- the retained hot tail;
- the next user message and model response.

### `retrievalLimit`

After consolidation generates and embeds the new memory items, Copilotz uses
each item embedding to search older `memory_item` nodes in the same thread
memory space. The per-item results are fused and `retrievalLimit` is applied to
the combined older set, not separately to every query.

The new checkpoint contains:

```text
all new items proposed for the current consolidation
+ at most retrievalLimit relevant older items
+ relations whose endpoints are included
```

`retrievalLimit` does not limit newly generated items. `maxContentEstimatedTokens` is the
final bound on the rendered checkpoint.

The LLM may supersede only an item whose canonical ID was visible in the
previous checkpoint. The old item remains immutable in the graph, a `supersedes`
edge records the change, and the superseded item is left out of the new rendered
memory.

An older item discovered for the first time by the post-consolidation retrieval
can enter the new checkpoint, but cannot be superseded until the next epoch,
after its ID has become visible to the LLM.

## What becomes a memory item

The consolidation LLM returns structured data rather than writing prose directly
into the database.

Supported item kinds are:

```text
entity
fact
claim
decision
preference
task
event
constraint
```

Each item is a standalone graph node with:

- a canonical ID rendered alongside it in the checkpoint;
- its own content and embedding;
- the checkpoint that created it;
- source message IDs;
- optional confidence;
- a thread memory-space identifier.

Relations are native graph edges:

```text
related_to
supports
contradicts
depends_on
supersedes
```

Items are append-only. When knowledge changes, the processor creates a new item
and can connect it to an older visible item with `supersedes`. This preserves
history and provenance instead of silently mutating yesterday's memory.

## How older memory is retrieved

The consolidation LLM first decomposes the source range into small, durable
items. Copilotz already embeds each of those items for persistence, so the same
vectors become retrieval queries:

```text
closing conversation
        |
        v
new decision -----> search older items
new constraint ---> search older items
new task ----------> search older items
        |
        v
fuse candidates and keep retrievalLimit older items
```

Candidate fusion primarily preserves the highest similarity to any new item,
which protects a small but important topic from being diluted by an unrelated
epoch. Reciprocal-rank evidence provides a secondary bonus when an older item is
relevant to several new items.

An older item explicitly superseded by the proposal is excluded before applying
`retrievalLimit`; it still receives the graph edge but does not consume space in
the new rendered checkpoint.

Copilotz then includes relations between the selected older items and can use
nearby related items while staying within the global `retrievalLimit`.

The final rendered checkpoint may itself exceed one embedding-model input. Its
stored checkpoint embedding is therefore generated from bounded chunks using a
character-weighted normalized combination. That embedding is checkpoint
metadata; older-item retrieval uses the individual new-item vectors.

## Why the checkpoint improves cache reuse

Provider prompt caches generally reuse an exact prompt prefix. If old history is
summarized again on every turn, the prefix changes on every turn.

Within a Copilotz epoch, the checkpoint is unchanged:

```text
turn 31: prompt + checkpoint 3 + message 31
turn 32: prompt + checkpoint 3 + message 31 + answer 31 + message 32
turn 33: prompt + checkpoint 3 + message 31 + answer 31 + message 32 + ...
```

New turns append after the stable prefix. At rollover, checkpoint 4 replaces
checkpoint 3 and causes one expected cache rebuild. Subsequent turns append to
checkpoint 4 and reuse the new prefix.

This design trades one cache miss per rollover for stable reuse between
rollovers.

Consolidation follows the same cache-aware layout. It builds the system prompt
with the reserved agent's normal context and active checkpoint, then places the
closing conversation, retrieved items, and output schema in the dynamic user
message. The consolidation call can therefore reuse the same stable agent prefix
instead of introducing a separate memory-agent prompt.

## Interaction with `limitEstimatedInputTokens`

These settings solve different problems:

- memory configuration decides when and how old conversation is consolidated;
- `limitEstimatedInputTokens` is the final estimated input budget for an
  individual LLM request.

The long-term-memory checkpoint is inserted into the system context.
`limitEstimatedInputTokens` preserves that system context and trims older raw
history from the remaining budget.

It does not divide the budget between checkpoint and hot history for you. Plan
the combined request:

```text
agent instructions and tools
+ long-term-memory checkpoint
+ participant and application context
+ retained and newly appended messages
<= model input budget
```

Do not set `triggerEstimatedTokens` so high that ordinary requests exceed the input limit
before consolidation can run. Likewise, do not make `maxContentEstimatedTokens` consume
most of the model's context by itself.

Estimates are provider/model-aware and calibrated from actual input usage when
available. Exact tokenization still varies by provider and content.

## Credentials

Consolidation makes two kinds of provider calls:

- an LLM call using the reserved agent's `llmOptions` and normal security
  resolution;
- embedding calls using `rag.embedding`.

An LLM integration credential does not automatically become an embedding API
key. If chat and embeddings use different authentication paths, configure the
embedding key explicitly:

```typescript
rag: {
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    apiKey: Deno.env.get("OPENAI_API_KEY"),
  },
},
```

For OpenAI embeddings, the connector otherwise falls back to its normal
`OPENAI_API_KEY` environment lookup. A 401 from `/v1/embeddings` is an embedding
credential problem, even if normal agent chat is working.

## Existing threads

Enabling long-term memory does not backfill an entire old thread.

For the first checkpoint, Copilotz walks backward from the triggering message
and selects the most recent eligible range needed to cross `triggerEstimatedTokens`.
Earlier messages remain stored, but are not automatically consolidated.

Later checkpoints use the complete delta after the previous ready
`sourceEndMessageId`, minus the newest retained tail.

Checkpoints created before canonical item IDs were rendered have no legal
cross-epoch supersession targets. The first checkpoint produced by the new
strategy adds IDs and `visibleItemIds`; normal reconciliation begins with the
following epoch. No data migration is required.

## Inspecting checkpoints

Long-term memory uses ordinary graph nodes. In PostgreSQL, checkpoints can be
inspected directly:

```sql
SELECT
  "id",
  "data"->>'sequence' AS "sequence",
  "data"->>'status' AS "status",
  "data"->>'agentId' AS "agentId",
  "data"->'error' AS "error",
  "created_at",
  "updated_at"
FROM "nodes"
WHERE "type" = 'long_term_memory'
  AND "data"->>'threadId' = $1
ORDER BY ("data"->>'sequence')::integer DESC;
```

Inspect the items produced by one checkpoint:

```sql
SELECT
  "id",
  "data"->>'kind' AS "kind",
  "name",
  "content",
  "data"->'sourceMessageIds' AS "sourceMessageIds",
  "embedding" IS NOT NULL AS "hasEmbedding"
FROM "nodes"
WHERE "type" = 'memory_item'
  AND "data"->>'checkpointId' = $1
ORDER BY "created_at";
```

Useful status meanings:

| Status    | Meaning                                                                        |
| --------- | ------------------------------------------------------------------------------ |
| `pending` | The source boundary is reserved and background consolidation has not committed |
| `ready`   | Content, items, relations, and embeddings committed successfully               |
| `failed`  | Consolidation failed; inspect `data.error` and the worker logs                 |

A failure does not remove the last ready checkpoint. Later agent activity can
reserve another checkpoint from the previous ready boundary.

## Common problems

### No checkpoint appears

Check that:

- the `long_term` memory resource is enabled;
- `rag.embedding` exists;
- an agent response has been created after the threshold was crossed;
- no checkpoint for the thread is already pending;
- the runtime event workers are running.

### The checkpoint fails with 401

Look at the failing endpoint. If it is `/v1/embeddings`, verify
`rag.embedding.apiKey` or the embedding provider's expected environment
variable. The agent's connected chat integration may be unrelated.

### The hot history is too large after rollover

`retainRecentEstimatedTokens` is a lower target over complete messages, not a hard
maximum. A very large recent message is retained whole. Reduce large tool
results before they enter history and configure `toolResultHistoryMaxEstimatedTokens`
where appropriate.

### The checkpoint is too large

Reduce `maxContentEstimatedTokens` or `retrievalLimit`. Remember that all newly generated
items are considered before the final rendered-content cap.

## Replacing the bundled strategy

The conversation read path depends on a small contract, not on the bundled graph
consolidator.

A custom processor may claim `long_term_memory.created` and finalize the
reserved node using another strategy, as long as it writes:

```text
long_term_memory.content
long_term_memory.data.status = "ready"
```

The runtime then inserts that content and loads raw messages after the node's
reserved `sourceEndMessageId`.

This allows applications to substitute a domain-specific graph, an external
memory service, or a simpler summarizer without changing normal message
processing.

## Design tradeoffs

Long-term memory is a lossy model-facing representation over lossless stored
history. It should improve continuity, not become the authoritative database for
application state.

The bundled strategy intentionally favors predictable behavior:

- rollover uses a deterministic token estimate rather than letting the LLM
  decide when to page memory;
- items are immutable rather than repeatedly rewriting old knowledge;
- only previously visible IDs may be superseded or targeted by the consolidation
  LLM;
- retrieval uses vector similarity plus bounded nearby relations rather than an
  unbounded graph walk;
- one rendered checkpoint makes prompt assembly and cache behavior simple.

Those choices also create limitations:

- consolidation can omit details that remain only in raw history;
- if item extraction omits a topic, item-based retrieval cannot recover that
  topic during the same consolidation;
- a newly rediscovered older item waits until the next epoch before the LLM can
  supersede or relate to it;
- bounded relation expansion can miss distant multi-hop evidence;
- the rendered `maxContentEstimatedTokens` cap can omit lower sections even though their
  underlying items remain persisted.

Use collections and tools for authoritative business state. Use RAG when the
model must retrieve exact source material. Treat long-term memory as continuity
for the conversation around those systems.

## Choosing the right memory primitive

| Need                                                          | Use                                 |
| ------------------------------------------------------------- | ----------------------------------- |
| Continue the current thread exactly                           | Raw thread history                  |
| Keep a long thread bounded while preserving its durable state | Long-term conversation memory       |
| Remember facts about a participant across threads             | Participant memory                  |
| Retrieve product documentation or an external knowledge base  | RAG                                 |
| Store application entities and deterministic relationships    | Collections and the knowledge graph |

These mechanisms can coexist. Long-term conversation memory is specifically
about compressing one growing thread into stable, retrievable checkpoints.

## When not to enable it

Skip long-term conversation memory when:

- threads are short enough to remain safely inside the model budget;
- the application does not have an embedding provider;
- exact old wording must always remain directly visible to the model;
- the thread contains information that should not be sent through a
  consolidation model;
- authoritative state already lives in collections or external systems and the
  agent should query it on demand.

It can also be enabled later, but the first checkpoint uses only the recent
threshold-sized suffix; it does not backfill the entire historical thread.

## What this unlocks

- Long-running threads without sending their full raw history forever
- Stable prompt prefixes between rollovers
- Durable decisions, constraints, tasks, and relations with source provenance
- Immutable knowledge evolution through `supersedes`
- Background consolidation that does not block the interactive response
- A replaceable processor contract instead of memory logic coupled to chat

## What's next

The agent can now preserve a long-running conversation without letting raw
history grow forever. But tool outputs can contain images, files, and enormous
base64 payloads that should not live directly in that history.

→ **[Chapter 15: Assets](../part-7-production/15-assets.md)**
