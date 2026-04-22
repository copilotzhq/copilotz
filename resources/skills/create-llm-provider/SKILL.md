---
name: create-llm-provider
description: Register a custom LLM provider adapter for runtime model calls.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, llm, provider]
---

# Create LLM Provider

Use an LLM provider resource when Copilotz should execute model calls through a
named backend that is not already covered by a built-in provider.

## When To Use It

- Use a custom provider when you need a new runtime model backend.
- Prefer the built-in `openai` provider with a custom `baseUrl` for
  OpenAI-compatible APIs.
- Do not hard-code provider logic into app routes or tools.

## Directory Structure

```txt
resources/llm/{provider-name}/
  adapter.ts
```

Also declare the provider in `resources/manifest.ts`:

```typescript
export default {
  provides: {
    llm: ["my-llm"],
  },
};
```

## Step 1: Create `adapter.ts`

```typescript
import type { ProviderFactory } from "@copilotz/copilotz";

export const myLlmProvider: ProviderFactory = (config) => ({
  endpoint: "https://api.my-llm.com/v1/chat",
  headers: (runtimeConfig) => ({
    Authorization: `Bearer ${runtimeConfig.apiKey}`,
  }),
  body: (messages, runtimeConfig) => ({
    model: runtimeConfig.model,
    messages,
  }),
  extractContent: (data) => {
    const text = (data as any)?.choices?.[0]?.delta?.content;
    return text ? [{ type: "text", text }] : null;
  },
});

export default myLlmProvider;
```

## Step 2: Reference The Provider

```typescript
llmOptions: {
  provider: "my-llm",
  model: "my-model",
}
```

## How Copilotz Consumes It

- providers are loaded into the runtime registry
- agents reference them by `llmOptions.provider`
- runtime config hooks can still inject secrets or override config dynamically

## Common Mistakes

- Creating a custom provider when a built-in provider plus `baseUrl` is enough
- Baking secrets into persisted resource files
- Coupling provider output parsing to one narrow response shape without
  fallbacks

## Notes

- Check the built-in providers under `resources/llm/` before inventing a new
  shape.
- Keep the adapter small and focused on transport and response translation.
