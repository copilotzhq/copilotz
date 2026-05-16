---
title: "Ch 12: RAG"
description: "Ground your agent on proprietary documents with semantic retrieval."
section: Getting Started
order: 120
status: stable
---

# Chapter 12: RAG — Grounding Agents on Proprietary Knowledge

> **Part 6 — Memory & Knowledge**

## The pain

Your agent is smart, but it doesn't know anything about your specific domain. Ask it about your product's return policy, your internal onboarding process, or the technical specs of your latest release, and it either hallucinates or says "I don't know."

The obvious fix is fine-tuning, but that's expensive, slow, and doesn't update in real time. You'd need to re-train every time your docs change.

The industry-standard alternative is **RAG** — Retrieval-Augmented Generation. Instead of baking knowledge into the model, you retrieve relevant documents at query time and inject them into the prompt. The model answers using real data, not hallucinations.

The catch is that a complete RAG pipeline requires six moving parts: a document parser, a chunker, an embedding model, a vector store, a query engine, and a prompt injection mechanism. That's usually multiple libraries and a significant integration project.

## The solution

Copilotz includes a complete, production-ready RAG lifecycle. You configure it once. The agent ingests documents, embeds them, and retrieves relevant context automatically.

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "support",
      name: "Support Agent",
      role: "A support agent grounded on our product documentation.",
      instructions: "When answering questions, search the knowledge base first. Always cite the document you found the information in.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o",
      },
      ragOptions: {
        mode: "tool",  // Agent explicitly calls search_knowledge when needed
      },
    },
  ],
  rag: {
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
    },
  },
  resources: {
    imports: [
      "tools.search_knowledge",
      "tools.ingest_document",
    ],
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

## The RAG lifecycle

### Step 1: Ingest documents

`ingest_document` takes a single `source` field that encodes both the type and the value:

```typescript
// URL — fetches and parses the page
{ source: "https://docs.myapp.com/return-policy", title: "Return Policy" }

// File path — reads a local file
{ source: "./docs/manual.pdf", title: "User Manual" }

// Raw text — prefix with "text:"
{ source: "text:The return window is 30 days for all purchases.", title: "Return Policy" }
```

You can trigger ingestion two ways:

**Via natural language** — ask an agent that has the tool in its `allowedTools`:

```typescript
const result = await copilotz.run({
  content: "Please ingest our FAQ at https://myapp.com/faq",
  sender: { type: "user", name: "Admin" },
});
await result.done;
```

**Programmatically via `toolCalls`** — pass the tool invocation directly in the message, bypassing the LLM entirely:

```typescript
const result = await copilotz.run({
  content: "",  // Empty content — the toolCalls drive this message
  sender: { type: "system" },
  toolCalls: [
    {
      id: "ingest-1",
      tool: { id: "ingest_document" },
      args: {
        source: "https://docs.myapp.com/return-policy",
        title: "Return Policy",
      },
    },
  ],
});
await result.done;

// Ingest raw text the same way
const result2 = await copilotz.run({
  content: "",
  sender: { type: "system" },
  toolCalls: [
    {
      id: "ingest-2",
      tool: { id: "ingest_document" },
      args: { source: "text:The return window is 30 days for all purchases.", title: "Return Policy" },
    },
  ],
});
await result2.done;
```

Make sure `ingest_document` is in the agent's `allowedTools` and loaded via `resources.imports`:

```typescript
agents: [{
  id: "support",
  allowedTools: ["ingest_document", "search_knowledge"],
  // ...
}],
resources: {
  imports: ["tools.ingest_document", "tools.search_knowledge"],
},
```

You can also attach `metadata` to scope documents to a specific knowledge space or agent:

```typescript
// The agent will call the tool with these args when you ask it to ingest
{
  source: "https://docs.myapp.com/guide",
  title: "Getting Started Guide",
  metadata: {
    scope: { knowledgeSpaceIds: ["space-product-docs"] },
  },
}
```

### Step 2: Background embedding

After ingestion, Copilotz enqueues a `RAG_INGEST` event. The background processor:
1. **Parses** the document into plain text
2. **Chunks** the text according to your chunking strategy
3. **Embeds** each chunk using your embedding model
4. **Stores** chunks with their vectors in the knowledge graph

This happens asynchronously — ingestion returns immediately, embedding happens in the background.

### Step 3: Retrieval

When the agent calls `search_knowledge` (in `tool` mode) or automatically (in `auto` mode), Copilotz:
1. Embeds the query using the same embedding model
2. Performs a cosine similarity search against stored chunk vectors
3. Returns the top-N most relevant chunks above the similarity threshold
4. Injects them into the LLM prompt as context

## RAG configuration

```typescript
rag: {
  embedding: {
    provider: "openai",             // "openai" | "ollama" | "cohere"
    model: "text-embedding-3-small",
    // apiKey — injected via resolveLLMRuntimeConfig
    dimensions: 1536,               // Optional: model output dimensions
    batchSize: 100,                 // Chunk embedding batch size
  },
  chunking: {
    strategy: "paragraph",          // "fixed" | "paragraph" | "sentence"
    chunkSize: 512,                 // Target chunk size (for "fixed" strategy)
    chunkOverlap: 50,               // Overlap between adjacent chunks
  },
  retrieval: {
    defaultLimit: 5,                // Number of chunks to retrieve
    similarityThreshold: 0.7,       // Minimum similarity score (0–1)
  },
},
```

## Per-agent RAG modes

Each agent can have its own RAG behavior:

```typescript
// Tool mode: agent explicitly calls search_knowledge
ragOptions: { mode: "tool" }

// Auto mode: relevant chunks are injected automatically into every LLM call
ragOptions: {
  mode: "auto",
  autoInjectLimit: 3,   // Inject top 3 chunks
}

// Disabled: this agent doesn't use RAG
ragOptions: { mode: "disabled" }
```

**When to use each:**
- `tool` — Best when RAG is situational. The agent decides when to search. Saves tokens on calls where search isn't needed.
- `auto` — Best when the agent should always have context (e.g., a support agent that always needs the knowledge base).

## Scoping retrieval

By default an agent searches all documents in the current namespace. Use `scope` to narrow it:

```typescript
ragOptions: {
  mode: "tool",
  scope: {
    threadId: "thread-abc",               // Only docs linked to this thread
    agentId: "support",                   // Only docs linked to this agent
    knowledgeSpaceIds: ["space-001"],     // Only docs in specific knowledge spaces
    documentIds: ["doc-001", "doc-002"],  // Only these specific documents
  },
}
```

All four fields are optional and combinable. Note that `namespace` is not a scope option — it's the multi-tenancy partition set at the `run()` call level, not inside `ragOptions`.

## Testing your RAG pipeline

```typescript
// 1. Ask the agent to ingest some content
const ingest = await copilotz.run({
  content: "Ingest this into the knowledge base: 'The return window is 30 days for all purchases.'",
  sender: { type: "user", name: "Admin" },
});
await ingest.done; // Wait for the tool call + RAG_INGEST event to be queued

// 2. Give the background embedding a moment to complete
await new Promise(resolve => setTimeout(resolve, 2000));

// 3. Query
const result = await copilotz.run({
  content: "What is our return policy?",
  sender: { type: "user", name: "Customer" },
});

for await (const event of result.events) {
  if (event.type === "TOKEN") {
    await Deno.stdout.write(new TextEncoder().encode(event.payload.token ?? ""));
  }
}
await result.done;
```

The agent should respond with "30 days" — retrieved from the knowledge base, not hallucinated.

## What this unlocks

- Agents grounded on any proprietary knowledge base — docs, manuals, FAQs, policies
- Real-time updates: ingest a new document, the agent knows it immediately
- No fine-tuning required — retrieval is always fresh
- Complete pipeline in one config block

## What's next

RAG stores content as flat chunks and retrieves them by similarity. This works well for factual lookup. But it has a fundamental limitation: it can't answer relational questions. "Who works with Alice on Project X?" requires knowing *relationships* between entities, not just finding similar text. The underlying storage layer in Copilotz is actually far more powerful than RAG suggests.

→ **[Chapter 13: Knowledge Graph Collections](./13-knowledge-graph.md))**
