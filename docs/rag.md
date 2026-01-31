# RAG (Retrieval-Augmented Generation)

RAG lets your AI access external knowledge. Ingest documents, and your agents can search and reference them in conversations. Copilotz handles the entire pipeline: fetching, chunking, embedding, storing, and retrieving.

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
    Chunk into pieces                Search vector database
         │                                  │
         ▼                                  ▼
    Generate embeddings              Get relevant chunks
         │                                  │
         ▼                                  ▼
    Store in knowledge graph         Inject into LLM context
         │                                  │
         ▼                                  ▼
    Build chunk relationships        Agent answers with context
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

Ingest documents directly via the API:

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

Search the knowledge base directly:

```typescript
// Search chunks
const results = await copilotz.ops.searchChunks({
  query: "How do I configure authentication?",
  namespace: "docs",
  limit: 5,
  threshold: 0.7,
});

// Search from knowledge graph
const graphResults = await copilotz.ops.searchChunksFromGraph({
  query: "authentication setup",
  namespace: "docs",
  limit: 5,
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

// List all namespaces
const stats = await copilotz.ops.getNamespaceStats();
// { "product-docs": { documentCount: 50, chunkCount: 1200 }, ... }
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

Extracted entities become nodes in the knowledge graph:

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

## Document Lifecycle

### Check Document Status

```typescript
const doc = await copilotz.ops.getDocumentById(documentId);
// doc.status: "pending", "processing", "completed", "failed"
```

### Delete Documents

```typescript
// By ID
await copilotz.ops.deleteDocument(documentId);

// Using tool
// Agent can call delete_document with namespace and source
```

### Force Re-ingestion

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

## Knowledge Graph Integration

RAG data lives in the knowledge graph, enabling rich queries:

```typescript
// Get chunks for a document
const chunks = await copilotz.ops.getEdgesForNode(documentId, "out", ["NEXT_CHUNK"]);

// Find documents mentioning an entity
const edges = await copilotz.ops.getEdgesForNode(entityId, "in", ["MENTIONS"]);

// Traverse from user to mentioned entities to related documents
const related = await copilotz.ops.traverseGraph(userId, ["MENTIONS", "RELATED_TO"], 3);
```

## Next Steps

- [Database](./database.md) — Understanding the knowledge graph
- [Collections](./collections.md) — Structured data on top of the graph
- [Agents](./agents.md) — Configuring per-agent RAG options
