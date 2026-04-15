---
name: configure-rag
description: Enable RAG (Retrieval-Augmented Generation) with document ingestion and semantic search.
allowed-tools: [read_file, write_file]
tags: [framework, rag]
---

# Configure RAG

Enable agents to ingest documents and search a knowledge base using semantic similarity.

## Enable RAG in createCopilotz

```typescript
const copilotz = await createCopilotz({
    agents: [{
        id: "assistant",
        name: "Assistant",
        role: "assistant",
        instructions: "Answer questions from the knowledge base.",
        llmOptions: { provider: "openai", model: "gpt-4o-mini" },
        allowedTools: ["search_knowledge", "ingest_document", "list_namespaces"],
        ragOptions: {
            mode: "auto",              // "auto" | "manual"
            namespaces: ["docs"],      // Namespaces to search
            autoInjectLimit: 5,        // Max chunks to inject automatically
        },
    }],
    rag: {
        embedding: {
            provider: "openai",
            model: "text-embedding-3-small",
            // apiKey: "...",          // Optional: override env var
        },
        chunking: {
            strategy: "fixed",         // "fixed" | "paragraph" | "sentence"
            chunkSize: 512,
            chunkOverlap: 50,
        },
        retrieval: {
            defaultLimit: 5,
            similarityThreshold: 0.7,
        },
        defaultNamespace: "docs",
    },
    dbConfig: { url: "..." },
});
```

## RAG Modes

- **auto**: Relevant chunks are automatically injected into the system prompt before each LLM call
- **manual**: Agent must explicitly use `search_knowledge` tool to retrieve context

## RAG Tools

| Tool | Description |
|------|-------------|
| `search_knowledge` | Search the knowledge base by query |
| `ingest_document` | Add a document (text or URL) to the knowledge base |
| `list_namespaces` | List available knowledge namespaces |
| `delete_document` | Remove a document from the knowledge base |

## Per-Agent RAG Options

Each agent can have different RAG settings:

```typescript
ragOptions: {
    mode: "auto",
    namespaces: ["docs", "faq"],
    autoInjectLimit: 3,
    entityExtraction: { enabled: true },
}
```

## Notes

- Requires an embedding provider (OpenAI, Ollama, or Cohere)
- Documents are automatically chunked and embedded on ingestion
- Namespaces provide logical separation of knowledge domains
