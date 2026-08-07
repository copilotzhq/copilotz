---
name: create-embedding-provider
description: Register a worker-local embedding provider resource.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, embeddings, provider, plugin]
---

# Create Embedding Provider

An embedding backend is a `providers` resource consumed by the knowledge plugin.
Keep the client/fetch implementation in the worker host and expose only the
logical provider contract.

```ts
import { definePlugin } from "jsr:@copilotz/copilotz@3/plugins";
import { defineKnowledgeEmbeddingProvider } from "jsr:@copilotz/copilotz@3/knowledge";

export function createEmbeddingPlugin(client: EmbeddingClient) {
  const provider = defineKnowledgeEmbeddingProvider({
    id: "acme.embeddings",
    type: "embedding",
    async embed({ texts, model, dimensions, signal, idempotencyKey }) {
      const result = await client.embed({
        texts,
        model,
        dimensions,
        signal,
        idempotencyKey,
      });
      return {
        embeddings: result.vectors,
        model: result.model,
        dimensions: result.dimensions,
        usage: result.usage,
      };
    },
  });

  return definePlugin({
    manifest: {
      id: "@acme/embedding-provider",
      version: "1.0.0",
      provides: { providers: [provider.id] },
    },
    resources: { providers: [provider] },
  });
}
```

Reference it with `core.knowledge.embedding.provider`. Return exactly one
finite, non-empty vector per input text; dimensions must be consistent. Honor
the abort signal and propagate the idempotency key. Do not read runtime-specific
environment globals in the provider resource—inject an initialized client.
