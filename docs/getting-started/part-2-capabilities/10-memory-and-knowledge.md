---
title: "Ch 10: Memory and Knowledge"
description: "Choose between conversation history, long-term semantic memory, and indexed source documents."
section: Getting Started
order: 100
status: stable
---

# Chapter 10: Memory and Knowledge

## The pain

Conversation history answers “what did we say in this thread?” It is not a
curated cross-turn fact store, and it is not a searchable document collection.
Treating those as the same thing makes retention, correction, and access rules
hard to explain.

## The solution

Start with the narrowest need. Core already keeps conversation history. Add the
Memory plugin when an Agent should retain and retrieve selected facts across
turns. Add Knowledge when users need answers grounded in source documents that
can be re-indexed and deleted independently.

### Add semantic memory to the Notes assistant

This is a set of exact edits to the existing root-level `assistant.ts` from
Chapter 1. Add Memory beside the existing Core and Notes plugins. It depends on
the same exported `corePlugin` object, which the registry deduplicates. Keep
`notesPlugin` and the existing LLM connection and Agent declaration.

Add this import beside the other plugin imports:

```ts
// Import the plugin that supplies long-term memory and its Core dependency.
import { memoryPlugin } from "@copilotz/copilotz/memory";
```

In the existing `createCopilotz()` options, replace the `plugins` property:

```ts
// Compose Memory, which includes Core, with the existing Notes capability.
plugins: [corePlugin, notesPlugin, memoryPlugin],
```

Keep the existing `corePlugin` entry: `memoryPlugin` depends on that same
exported Core plugin object, and the registry deduplicates that exact object.
Add `memoryPlugin` to the array; do not make a second plugin instance with the
same identity.

In the existing `resources.agents.assistant` declaration, replace the current
capability grant with:

```ts
// Keep the Agent's existing note-writing tool and grant lexical memory search.
capabilities: { tools: ["saveNote", "search_memory"] },
```

In the existing top-level `resources` object beside `agents`, add:

```ts
// Configure bounded consolidation and retrieval for the composed Memory plugin.
memory: {
  // Place Memory's runtime configuration beneath its named resource family.
  config: {
    // Start a consolidation checkpoint after this estimated conversation size.
    triggerEstimatedTokens: 20_000,
    // Keep recent source context out of the older consolidation range.
    retainRecentEstimatedTokens: 2_000,
    // Limit the source text sent into one consolidation task.
    maxContentEstimatedTokens: 12_000,
    // Cap the number of records returned by a normal memory search.
    retrievalLimit: 20,
  },
},
```

The `memory` property above belongs beside `agents` in `resources`, not inside
the Agent Resource. The `capabilities` replacement belongs inside
`resources.agents.assistant`. Memory's plain-text retrieval path works without
an embedding adapter. Its consolidation Processor starts a scoped Agent task, so
the configured LLM connection is used when that task runs. It does not make a
provider request while this file is edited or type-checked.

## Breaking it down

Conversation history is the canonical message record for one Thread. Memory
consolidates eligible conversation evidence into typed, provenance-aware records
and exposes search and inspection Actions. It is a semantic summary layer: a
record can be corrected, invalidated, or related to another record. It does not
replace the original messages.

Knowledge has a different contract. It stores source documents and indexed
chunks so retrieval can point back to source material. Indexing requires a real
embedding provider configured under `adapters.embedding` and
`resources.knowledge.config.embedding`; the plugin does not ship a model or
invent vectors. Choose and validate that provider, its dimensions, data policy,
and operational limits before indexing real documents. Start from the
[Knowledge plugin reference](../../../plugins/knowledge/README.md) and
[content and Asset guide](../../content-assets.md).

Memory records also carry scope and access rules. Do not use an Agent prompt or
an embedding index as an authorization mechanism. The host still determines
which authenticated person and Thread may read or update each space.

## What this unlocks

- History remains available for exact conversation context.
- Semantic Memory can retrieve selected facts without treating every old message
  as equally relevant.
- Knowledge can index documents with a real, explicitly configured embedding
  provider and preserve a path back to their source.

## What's next

Memory and Knowledge help an Agent use prior context. For an application caller
that should invoke the same Notes Action without going through an Agent, see
[Chapter 11: HTTP and Client](../part-3-production/11-http-and-client.md).
