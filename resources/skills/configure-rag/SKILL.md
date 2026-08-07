---
name: configure-rag
description: Enable graph-native document ingestion and semantic retrieval.
allowed-tools: [read_file, write_file]
tags: [framework, rag, knowledge, plugin]
---

# Configure RAG

The v3 knowledge plugin contributes graph collections, a durable indexing
processor, and optional agent tools. It requires an embedding provider resource.

```ts
import { createCopilotz } from "jsr:@copilotz/copilotz@3";
import { definePlugin } from "jsr:@copilotz/copilotz@3/plugins";
import { defineKnowledgeEmbeddingProvider } from "jsr:@copilotz/copilotz@3/knowledge";

const embeddings = defineKnowledgeEmbeddingProvider({
  id: "acme.embeddings",
  type: "embedding",
  async embed({ texts, model, signal, idempotencyKey }) {
    const result = await embeddingClient.embed({
      texts,
      model: model ?? "text-embedding-3-small",
      signal,
      idempotencyKey,
    });
    return {
      embeddings: result.vectors,
      model: result.model,
      dimensions: result.dimensions,
    };
  },
});

const providerPlugin = definePlugin({
  manifest: {
    id: "@acme/embeddings",
    version: "1.0.0",
    provides: { providers: [embeddings.id] },
  },
  resources: { providers: [embeddings] },
});

const app = await createCopilotz({
  namespace: "acme",
  plugins: [providerPlugin],
  core: {
    knowledge: {
      embedding: { provider: embeddings.id },
      chunking: { strategy: "fixed", chunkSize: 512, chunkOverlap: 50 },
    },
  },
  resources: {
    agents: [{
      id: "researcher",
      name: "Researcher",
      role: "Use the knowledge base when relevant.",
      allowedTools: ["search_knowledge", "ingest_document", "delete_document"],
      runtimes: { text: { type: "llm", provider: "openai" } },
    }],
  },
});
```

Ingestion returns after the document is accepted. The durable indexing processor
loads content, chunks it, embeds it, and settles independently. Source bodies
use canonical content/assets rather than duplicated text fields.

Keep embedding clients runtime-neutral, honor `AbortSignal`, propagate the
idempotency key, and enforce namespace/graph scope on every search.
