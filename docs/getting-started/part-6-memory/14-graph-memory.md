---
title: "Ch 14: Graph Memory"
description: "Scalable agent memory that extracts entities and improves over time."
section: Getting Started
order: 140
status: stable
---

# Chapter 14: Graph Memory

> **Part 6 — Memory & Knowledge**

## The pain

Your agents are being used. People love them. Conversations are growing.

And that's becoming a problem.

A conversation from three months ago where a user mentioned their company acquisition — that context is gone. Buried in a thread nobody queries anymore. The agent greets returning users as if it's the first time every time.

Worse: as conversations grow longer, you're including more history in every LLM prompt. At some point you hit the context window. You start summarizing, but summaries lose nuance. You start truncating, but you lose continuity. Costs rise. Response quality degrades. Users notice.

The fundamental issue is that raw conversation history doesn't scale. You need memory that gets *smarter* as it grows, not just longer.

## The solution

**Graph memory** is a background process that automatically extracts entities and relationships from conversations, stores them in the knowledge graph, and uses RAG to inject only the relevant context when needed — instead of dumping raw history into every prompt.

The longer someone uses the agent, the richer the graph becomes. The agent doesn't remember every word — it remembers the *meaning*: who people are, what they care about, what happened, how things are connected.

## How it works

1. **After each conversation turn**, an `ENTITY_EXTRACT` event is enqueued
2. The **entity extraction processor** sends the message to a secondary LLM call that identifies named entities (people, organizations, products, topics, dates, decisions)
3. Each entity becomes a `knowledge_node`; co-occurrences and explicit relationships become `knowledge_edges`
4. **Deduplication**: before creating a node, the processor checks for existing similar ones using embedding similarity — "Alice Chen" and "Alice from Engineering" resolve to the same node
5. At the next LLM call, the **retrieval memory** performs a semantic search against the graph and injects the most relevant entity summaries as context

This happens in the background, asynchronously. Users don't wait for it.

## Enabling graph memory

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "assistant",
      name: "Assistant",
      role: "A persistent personal assistant that remembers context across conversations.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o",
      },
      ragOptions: {
        mode: "auto",
        autoInjectLimit: 5,
        entityExtraction: {
          enabled: true,
        },
      },
    },
  ],
  rag: {
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
    },
    // LLM used for background RAG tasks: entity extraction, merge confirmation
    llmConfig: {
      provider: "openai",
      model: "gpt-4o-mini",  // Use a faster/cheaper model than the main agent
    },
  },
  resources: {
    preset: ["core", "rag"],
  },
  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },
  dbConfig: { url: "postgresql://user:pass@localhost/myapp" },
});

copilotz.start();
```

That's the full configuration. Two things added: `entityExtraction.enabled: true` on the agent, and `rag.llmConfig` at the top level to configure which model performs the extraction (it can be a cheaper model than your main agent).

## What gets extracted

The entity extractor identifies:

| Entity type | Examples |
|-------------|---------|
| Person | "Alice Chen", "my manager Bob" |
| Organization | "Acme Corp", "our company" |
| Product | "Auth Service", "the mobile app" |
| Topic | "the refactoring project", "budget discussions" |
| Event | "the Q3 review", "last week's incident" |
| Decision | "we decided to migrate to PostgreSQL" |
| Preference | "prefers async communication", "dislikes meetings" |

Relationships extracted:

- `Alice` → `works_at` → `Acme Corp`
- `Alice` → `owns` → `Auth Service`
- `Bob` → `manages` → `Alice`
- `Auth Service` → `depends_on` → `Postgres`

## Seeing it in action

```
Turn 1:
User: "I'm working on a big project — migrating our monolith to microservices. My tech lead is Jordan."

[Background: extracts "monolith migration" project, "Jordan" as tech lead]

Turn 2 (next day, new session):
User: "What should I prioritize today?"

[Retrieval: finds "monolith migration" and "Jordan" nodes, injects as context]

Agent: "Based on what you've shared, you're working on a microservices migration
       led by Jordan. For today, you might focus on..."
```

The agent remembers, even across sessions, even without storing the raw conversation.

## Memory vs. raw history

| | Raw history | Graph memory |
|---|---|---|
| Grows with usage | Linearly | Sub-linearly (entities deduplicate) |
| Context injected | Everything (or truncated) | Only relevant entities |
| Tokens per call | Increases over time | Stays bounded |
| Relational queries | Not possible | Supported |
| Cost over time | Increases | Stable |

## Controlling entity extraction

You can tune extraction per-agent:

```typescript
// Per-agent extraction tuning (in ragOptions.entityExtraction)
entityExtraction: {
  enabled: true,
  // Minimum similarity to consider two entities the same candidate (default: 0.95)
  similarityThreshold: 0.85,
  // Similarity above which entities are merged automatically without LLM confirmation (default: 0.99)
  autoMergeThreshold: 0.99,
  // Restrict to specific entity types (open vocabulary — default: all types)
  entityTypes: ["person", "organization", "product", "decision"],
}

// The extraction LLM is configured in the top-level rag block (in rag.llmConfig)
rag: {
  embedding: { provider: "openai", model: "text-embedding-3-small" },
  llmConfig: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0,  // Deterministic extraction
  },
}
```

## Accessing the memory graph programmatically

The knowledge graph is exposed via the low-level `db.ops` interface, available inside custom tools and processors through the `context` argument:

```typescript
const lookupMemoryTool = {
  key: "lookup_memory",
  name: "Lookup Memory",
  description: "Search the entity graph for information about a topic.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  execute: async ({ query }, context) => {
    const ops = context.db?.ops;
    if (!ops) return { error: "No graph access" };

    // Semantic search across all entity nodes
    const results = await ops.searchNodes({
      query,
      namespaces: [context.namespace ?? "main"],
      limit: 10,
      minSimilarity: 0.7,
    });

    return {
      entities: results.map((r) => ({
        name: r.node.name,
        type: r.node.type,
        description: r.node.content,
        similarity: r.similarity,
      })),
    };
  },
};
```

## What this unlocks

- Scalable memory that improves as usage grows — not a liability
- Context injection that stays bounded regardless of conversation history length
- Relationship-aware memory — the agent knows how things connect, not just what was said
- Automatic — zero configuration per conversation
- Cost-efficient — you pay for relevant context, not raw history

## What's next

The agent's memory is now sophisticated and scalable. But there's a new problem lurking in your tool outputs: a tool returns an image as base64. That string is thousands of tokens long. It goes straight into your next LLM prompt. Costs spike. The API might reject the request entirely.

→ **[Chapter 15: Assets](../part-7-production/15-assets.md))**
