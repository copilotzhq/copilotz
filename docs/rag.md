# RAG (Retrieval-Augmented Generation)

RAG lets your AI access external knowledge. Ingest documents, and your agents can search and reference them in conversations. Copilotz handles fetching, chunking, embedding, storing, and retrieving.

**Storage model:** RAG content lives in the **`nodes`** and **`edges`** tables. A **`document` node** holds source metadata (URI, hash, status, title, …). Each **`chunk` node** holds embedded text; **`NEXT_CHUNK`** edges preserve order. There are no legacy `documents` or `document_chunks` relational tables.

## How RAG Works

```
Document Ingestion                    Query Time
─────────────────                    ──────────

Document (URL, file, or text)        User question
         │                                  │
         ▼                                  ▼
    Fetch content                    Generate embedding
         │                                  │
         ▼                                  ▼
    Chunk into pieces                Search chunk nodes
         │                                  │
         ▼                                  ▼
    Generate embeddings              Get relevant chunks
         │                                  │
         ▼                                  ▼
    Persist document + chunk         Inject into LLM context
    nodes (+ edges)                  │
         │                           ▼
         ▼                    Agent answers with context
```

## Configuration

Enable RAG by providing a `rag` configuration:

```typescript
const copilotz = await createCopilotz({
  agents: [...],
  rag: {
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
    },
    chunking: {
      strategy: "fixed",     // "fixed", "paragraph", or "sentence"
      chunkSize: 512,        // Target size in tokens
      chunkOverlap: 50,      // Overlap between chunks
    },
    retrieval: {
      defaultLimit: 5,           // Number of chunks to retrieve
      similarityThreshold: 0.7,  // Minimum similarity score (0-1)
    },
    defaultNamespace: "docs",
  },
});
```

### Embedding Providers

```typescript
// OpenAI (recommended)
embedding: { provider: "openai", model: "text-embedding-3-small" }

// Ollama (local)
embedding: { provider: "ollama", model: "nomic-embed-text", baseUrl: "http://localhost:11434" }

// Cohere
embedding: { provider: "cohere", model: "embed-english-v3.0" }
```

### Chunking Strategies

| Strategy | Best For | Description |
|----------|----------|-------------|
| `fixed` | General use | Splits into fixed-size chunks with overlap |
| `paragraph` | Structured documents | Splits on paragraph boundaries |
| `sentence` | Precise retrieval | Splits on sentence boundaries |

## Ingesting Documents

### Using Tools

Agents can ingest documents using the `ingest_document` tool:

```typescript
const agent = {
  id: "researcher",
  allowedTools: ["ingest_document", "search_knowledge"],
  // ...
};

// Agent can now say: "Let me add that article to my knowledge base"
// and call ingest_document with the URL
```

### Programmatic Ingestion

Ingest documents directly via the event queue:

```typescript
// From URL
await copilotz.run({
  type: "RAG_INGEST",
  payload: {
    source: "https://example.com/article.html",
    namespace: "docs",
  },
});

// From file path
await copilotz.run({
  type: "RAG_INGEST",
  payload: {
    source: "file:///path/to/document.pdf",
    namespace: "docs",
  },
});

// From raw text
await copilotz.run({
  type: "RAG_INGEST",
  payload: {
    source: "text://",
    content: "Your document content here...",
    namespace: "docs",
    metadata: { title: "My Document" },
  },
});
```

## Searching the Knowledge Base

### Agent RAG Modes

Control how agents interact with the knowledge base:

```typescript
const agent = {
  id: "assistant",
  ragOptions: {
    mode: "auto",              // "auto", "tool", or "disabled"
    namespaces: ["docs"],      // Which namespaces to search
    autoInjectLimit: 4,        // Max chunks to inject (auto mode)
  },
};
```

| Mode | Behavior |
|------|----------|
| `auto` | Relevant chunks are automatically injected into the prompt |
| `tool` | Agent explicitly calls `search_knowledge` when needed |
| `disabled` | No RAG for this agent |

### Programmatic Search

Search runs over **`chunk` nodes** using a **query embedding** (the `search_knowledge` tool does this with your configured embedder). `searchChunks` delegates to `searchChunksFromGraph`.

```typescript
// Obtain `embedding: number[]` from your embedding provider (the built-in
// `search_knowledge` tool does this using `rag.embedding` from config).
const embeddingVector: number[] = await yourEmbedder(
  "How do I configure authentication?",
);

const results = await copilotz.ops.searchChunksFromGraph({
  embedding: embeddingVector,
  namespaces: ["docs"],
  limit: 5,
  threshold: 0.7,
  documentFilters: { status: "indexed" },
});

// Same underlying implementation
const same = await copilotz.ops.searchChunks({
  embedding: embeddingVector,
  namespaces: ["docs"],
  limit: 5,
  threshold: 0.7,
});
```

## Namespaces

Namespaces partition your knowledge base. Use them to separate:
- Different documentation sets
- Per-customer knowledge
- Different domains or topics

```typescript
// Ingest to a namespace
await copilotz.run({
  type: "RAG_INGEST",
  payload: { source: url, namespace: "product-docs" },
});

// Search a specific namespace
const agent = {
  ragOptions: {
    namespaces: ["product-docs", "support-articles"],
  },
};

// Aggregate counts from document + chunk nodes per namespace
const stats = await copilotz.ops.getNamespaceStats();
// e.g. [{ namespace: "product-docs", documentCount: 50, chunkCount: 1200, lastUpdated }, ...]
```

### Dynamic Namespace Resolution

Resolve namespaces dynamically based on context:

```typescript
const copilotz = await createCopilotz({
  rag: {
    namespaceResolver: async ({ threadId, agentId, message }) => {
      // Return namespace based on context
      if (message.metadata?.customerId) {
        return `customer:${message.metadata.customerId}`;
      }
      return "global";
    },
  },
});
```

## Entity Extraction

Copilotz can automatically extract entities from conversations and documents:

```typescript
const agent = {
  ragOptions: {
    entityExtraction: {
      enabled: true,
      namespace: "thread",  // "thread", "agent", or "global"
    },
  },
};
```

Extracted entities become **`entity` nodes** in the graph:

```
Message: "I talked to Sarah from Acme Corp about the Q4 deal"
         │
         ▼
    Entity Extraction
         │
         ├─▶ Person: Sarah
         ├─▶ Organization: Acme Corp
         └─▶ Event: Q4 deal
```

Entities are deduplicated across conversations using semantic similarity and LLM confirmation.

## Document lifecycle (graph-backed)

Helpers return a **`Document` view** backed by a **`document` node** (`id` is the node id).

### Check document status

```typescript
const doc = await copilotz.ops.getDocumentById(documentNodeId);
// doc.status: "pending", "processing", "indexed", "failed"
```

### Delete documents

```typescript
// Removes the document node and chunk nodes linked via source (see deleteNodesBySource)
await copilotz.ops.deleteDocument(documentNodeId);

// Or via tool: delete_document with namespace / source identifiers
```

### Force re-ingestion

```typescript
await copilotz.run({
  type: "RAG_INGEST",
  payload: {
    source: url,
    namespace: "docs",
    forceReindex: true,  // Re-process even if already ingested
  },
});
```

## Knowledge graph integration

Use edges and traversal to go beyond flat similarity search:

```typescript
// Ordered chunks for one document (document id = document node id)
const chunkEdges = await copilotz.ops.getEdgesForNode(
  documentNodeId,
  "out",
  ["NEXT_CHUNK"],
);

// What mentions this entity?
const mentions = await copilotz.ops.getEdgesForNode(entityId, "in", ["MENTIONS"]);

// Broader exploration
const related = await copilotz.ops.traverseGraph(
  startNodeId,
  ["MENTIONS", "RELATED_TO"],
  3,
);
```

## Next Steps

- [Database](./database.md) — Threads, events, and graph overview
- [Tables structure](./tables-structure.md) — Column reference for `nodes` / `edges`
- [Collections](./collections.md) — Structured data on top of the graph
- [Agents](./agents.md) — Configuring per-agent RAG options
