---
name: create-embedding-provider
description: Register a custom embeddings provider adapter for vector generation.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, embeddings, provider]
---

# Create Embedding Provider

Use an embeddings provider resource when Copilotz should generate vectors
through a named backend for retrieval and similarity workflows.

## When To Use It

- Use a custom embeddings provider for non-built-in vector backends.
- Prefer the built-in `openai` embeddings provider with a custom `baseUrl` when
  the API is compatible.
- Do not hide embedding behavior inside unrelated tools.

## Directory Structure

```txt
resources/embeddings/{provider-name}/
  adapter.ts
```

Also declare the provider in `resources/manifest.ts`:

```typescript
export default {
  provides: {
    embeddings: ["my-provider"],
  },
};
```

## Step 1: Create `adapter.ts`

```typescript
import type { EmbeddingProviderFactory } from "@copilotz/copilotz";

export const myProviderEmbeddingProvider: EmbeddingProviderFactory = (
  config,
) => ({
  endpoint: "https://api.my-embeddings.com/v1/embeddings",
  headers: (runtimeConfig) => ({
    Authorization: `Bearer ${runtimeConfig.apiKey}`,
  }),
  body: (texts, runtimeConfig) => ({
    model: runtimeConfig.model,
    input: texts,
  }),
  extractEmbeddings: (data) =>
    ((data as any).data ?? []).map((item: any) => item.embedding ?? []),
});

export default myProviderEmbeddingProvider;
```

## Step 2: Reference The Provider

```typescript
embeddingOptions: {
  provider: "my-provider",
  model: "my-model",
}
```

## How Copilotz Consumes It

- providers are loaded into the embeddings registry
- retrieval and ingestion flows call them through runtime abstractions
- RAG and collection similarity flows use the configured provider

## Common Mistakes

- Using a tool to generate vectors ad hoc instead of registering a provider
- Forgetting to declare the provider in `resources/manifest.ts`
- Returning embeddings in a shape the runtime cannot normalize

## Notes

- Keep the adapter concerned with request/response translation only.
- Use the built-in embedding provider as the first reference when in doubt.
