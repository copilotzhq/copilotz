# Embeddings Providers

Embedding provider resources register vector generation backends for retrieval
and similarity workflows.

## Where It Lives

```txt
resources/embeddings/<provider-name>/
```

## What It Is For

Use an embeddings provider when Copilotz should generate vectors for documents,
chunks, or retrieval workflows.

Recommended use case: vector generation for RAG  
Most common mistaken alternative: placing embedding logic inside random tools
instead of the provider registry

## How Copilotz Consumes It

- providers are loaded into the embeddings registry
- retrieval and ingestion workflows call them through runtime abstractions

## Minimal Example

The built-in providers under `resources/embeddings/` are the canonical
reference.

## Public Surface

Embeddings providers are runtime dependencies, not direct endpoints.

## Related Pages

- [Storage Adapters](./storage.md)
- [How the Graph Works](../runtime/how-the-graph-works.md)
- [createCopilotz](../reference/create-copilotz.md)
