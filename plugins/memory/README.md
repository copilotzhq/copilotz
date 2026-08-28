# Semantic memory

## What it is

A durable semantic-memory plugin for Copilotz conversations.

## Why it exists

It consolidates conversation evidence into queryable, provenance-aware records.

## How to use it

Install `createLongTermMemoryPlugin` alongside Core and explicitly grant
`consolidate_memory` to each Agent that may write memory.

```ts
const north = defineAgent({
  id: "north",
  name: "North",
  role: "assistant",
  models: { generate: ["primary", "fallback"] },
  capabilities: {
    tools: ["consolidate_memory", "search_memory"],
  },
});

const memory = createLongTermMemoryPlugin({
  config: {
    triggerEstimatedTokens: 8_000,
    retainRecentEstimatedTokens: 2_000,
  },
});
```

Memory does not accept a separate Model list. The owning Agent's normal Model
ordering, credentials, instructions, shared prompt instructions, Context,
Skills, and complete granted Tool catalog remain authoritative.

## How it works

Collections preserve checkpoints and records. Detached processors reserve a
bounded source range, then ask the owning Agent to consolidate it through the
ordinary Core Message, LLM, Tool-plan, and Action lifecycle. Memory never
selects a separate model or reconstructs an Agent prompt.

The maintenance instruction is the final Message in a private transcript scope.
The ordinary Agent prompt and Tool catalog therefore remain the stable
provider-cacheable prefix. Private task, Agent, Ask, and Tool-result Messages
are excluded from ordinary prompt history and public Message history.

`consolidate_memory` is also valid in an ordinary user-facing turn. Such a call
creates a deterministic on-demand checkpoint from trusted Core Tool provenance,
commits it idempotently, and then continues the ordinary Agent turn. Only a
Memory-owned private turn stops after its successful consolidation call.
