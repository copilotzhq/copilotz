# Embeddings

Copilotz uses embeddings for RAG (semantic search over ingested documents). The built-in provider is OpenAI's `text-embedding-3-small`, but you can add your own.

## Using the Default

Embeddings work out of the box when an `OPENAI_API_KEY` is set. The RAG pipeline uses them automatically for document ingestion and search queries.

```typescript
const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    instructions: "...",
    llmOptions: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
    ragOptions: { mode: "auto" },
  }],
  dbConfig: { url: ":memory:" },
});
```

Even though the agent uses Anthropic for chat, embeddings still use OpenAI by default.

## Configuring Embeddings

Override the model or provider in the top-level config:

```typescript
const copilotz = await createCopilotz({
  embeddingOptions: {
    provider: "openai",
    model: "text-embedding-3-large",
    dimensions: 3072,
  },
  // ...
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | `"openai"` | Embedding provider name |
| `model` | `"text-embedding-3-small"` | Model name |
| `dimensions` | Provider default | Output dimensions (for models that support it) |
| `apiKey` | From env | API key override |
| `baseUrl` | Provider default | Base URL override |

## Writing a Custom Embedding Provider

An embedding provider is a factory function that takes an `EmbeddingConfig` and returns an `EmbeddingProviderAPI`:

```typescript
import type { EmbeddingProviderFactory, EmbeddingConfig } from "@copilotz/copilotz";

export const myEmbeddingProvider: EmbeddingProviderFactory = (config: EmbeddingConfig) => {
  return {
    endpoint: `${config.baseUrl || "https://api.my-embeddings.com"}/v1/embeddings`,

    headers: (config: EmbeddingConfig) => ({
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    }),

    body: (texts: string[], config: EmbeddingConfig) => ({
      model: config.model || "my-embedding-model",
      input: texts,
    }),

    extractEmbeddings: (data: unknown): number[][] => {
      const response = data as { data?: Array<{ embedding?: number[] }> };
      return (response.data ?? [])
        .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
        .map((item: any) => item.embedding ?? []);
    },

    extractUsage: (data: unknown) => {
      const usage = (data as any)?.usage;
      if (!usage) return undefined;
      return {
        promptTokens: usage.prompt_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      };
    },
  };
};
```

### EmbeddingProviderAPI Interface

| Property | Required | Description |
|----------|----------|-------------|
| `endpoint` | Yes | The embeddings API URL |
| `headers(config)` | Yes | Returns request headers |
| `body(texts, config)` | Yes | Builds the request body from input texts |
| `extractEmbeddings(data)` | Yes | Extracts embedding vectors from the API response |
| `extractUsage(data)` | No | Extracts token usage from the response |

## Registering a Custom Provider

### Via config

```typescript
import { myEmbeddingProvider } from "./my-embedding-provider.ts";

const copilotz = await createCopilotz({
  embeddings: { "my-provider": myEmbeddingProvider },
  embeddingOptions: { provider: "my-provider", model: "my-model" },
  // ...
});
```

### Via resources directory

Create `resources/embeddings/my-provider/adapter.ts`:

```typescript
import type { EmbeddingProviderFactory } from "@copilotz/copilotz";

export const myProviderEmbeddingProvider: EmbeddingProviderFactory = (config) => ({
  endpoint: "https://api.my-embeddings.com/v1/embeddings",
  headers: (config) => ({ "Authorization": `Bearer ${config.apiKey}` }),
  body: (texts, config) => ({ model: config.model, input: texts }),
  extractEmbeddings: (data) =>
    ((data as any).data ?? []).map((item: any) => item.embedding ?? []),
});
```

And declare it in `resources/manifest.ts`:

```typescript
export default {
  provides: {
    embeddings: ["my-provider"],
  },
};
```

## OpenAI-Compatible Endpoints

Like LLM providers, many embedding APIs follow the OpenAI format. Use the built-in `openai` embedding provider with a custom `baseUrl`:

```typescript
embeddingOptions: {
  provider: "openai",
  model: "BAAI/bge-large-en-v1.5",
  baseUrl: "https://api.together.xyz",
  apiKey: Deno.env.get("TOGETHER_API_KEY"),
}
```

## Next Steps

- [Resources](./resources.md) — Resource system overview
- [LLM Providers](./llm-providers.md) — Custom LLM adapters
- [RAG](./rag.md) — Document ingestion and semantic search
