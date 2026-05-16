# Chapter 21: Custom LLM Providers

> **Part 9 — Deep Customization**

## The pain

A new LLM provider launches. The benchmarks look good. The price is 40% lower than what you're currently paying. You want to test it.

But Copilotz doesn't have a built-in integration yet. You could wait for a PR to get merged. Or you could swap out the framework entirely. Neither is acceptable.

The same problem applies to private deployments — an on-premises model behind a corporate firewall, or a custom fine-tuned model hosted on your own infrastructure. These will never have first-party framework support.

## The solution

Copilotz's LLM integration is a resource, just like agents and tools. Define a provider adapter with a small set of primitives and it's available to any agent. No framework modification required.

## The provider interface

A provider factory is a function that returns four things:
1. `endpoint` — where to send requests
2. `headers()` — how to authenticate
3. `body()` — how to format the request
4. `extractContent()` — how to parse streaming response chunks
5. `extractUsage()` — how to read token usage from the final chunk

```typescript
// resources/llm/my-provider/adapter.ts

export default (config) => {
  return {
    endpoint: "https://api.my-provider.com/v1/chat/completions",

    headers: (config) => ({
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    }),

    body: (messages, config) => ({
      model: config.model ?? "my-model-v1",
      messages: messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      stream: true,
      stream_options: { include_usage: true },
      temperature: config.temperature ?? 1,
      max_tokens: config.maxTokens,
    }),

    extractContent: (chunk) => {
      // Called for each streaming chunk
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) return null;

      const parts = [];
      if (typeof delta.content === "string") {
        parts.push({ text: delta.content });
      }
      return parts.length > 0 ? parts : null;
    },

    extractUsage: (chunk) => {
      // Called when usage data appears (usually the final chunk)
      const usage = chunk?.usage;
      if (!usage) return null;

      return {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        rawUsage: usage,
      };
    },
  };
};
```

Place this file in `resources/llm/my-provider/adapter.ts`. With `resources.path` configured, Copilotz auto-loads it.

## Using your custom provider

```typescript
const copilotz = await createCopilotz({
  agents: [
    {
      id: "assistant",
      name: "Assistant",
      role: "A helpful assistant.",
      llmOptions: {
        provider: "my-provider",  // Must match the directory name
        model: "my-model-v2",
        temperature: 0.7,
      },
    },
  ],
  resources: {
    path: "./resources",
  },
  security: {
    resolveLLMRuntimeConfig: async ({ provider }) => ({
      apiKey: Deno.env.get("MY_PROVIDER_API_KEY"),
    }),
  },
  dbConfig: { url: ":memory:" },
});
```

## A complete example: OpenAI-compatible provider

Many providers (Groq, Together AI, Fireworks, LM Studio, etc.) implement the OpenAI API. Here's a generic adapter for any OpenAI-compatible endpoint:

```typescript
// resources/llm/openai-compatible/adapter.ts

export default (config) => {
  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";

  return {
    endpoint: `${baseUrl}/chat/completions`,

    headers: (config) => ({
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    }),

    body: (messages, config) => ({
      model: config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: config.maxTokens ?? config.maxCompletionTokens,
      stop: config.stop,
    }),

    extractContent: (chunk) => {
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta?.content) return null;
      return [{ text: delta.content }];
    },

    extractUsage: (chunk) => {
      const usage = chunk?.usage;
      if (!usage) return null;
      return {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens,
        totalTokens: usage.total_tokens,
        rawUsage: usage,
      };
    },
  };
};
```

Use it for any compatible provider by passing `baseUrl`:

```typescript
// Groq
llmOptions: { provider: "openai-compatible", model: "llama-3.1-70b-versatile", baseUrl: "https://api.groq.com/openai/v1" }

// LM Studio (local)
llmOptions: { provider: "openai-compatible", model: "local-model", baseUrl: "http://localhost:1234/v1" }

// Together AI
llmOptions: { provider: "openai-compatible", model: "mistralai/Mixtral-8x7B", baseUrl: "https://api.together.xyz/v1" }
```

## Handling non-streaming providers

Some providers don't support streaming. Return the full response from `extractContent`:

```typescript
// For non-streaming: body sends stream: false
body: (messages, config) => ({
  model: config.model,
  messages,
  stream: false,   // No streaming
  // ...
}),

// extractContent receives the full response object, not chunks
extractContent: (response) => {
  const content = response?.choices?.[0]?.message?.content;
  if (!content) return null;
  return [{ text: content }];
},
```

## Handling reasoning tokens

For models with chain-of-thought output (like o1, DeepSeek-R1):

```typescript
extractContent: (chunk) => {
  const delta = chunk?.choices?.[0]?.delta;
  if (!delta) return null;

  const parts = [];
  if (typeof delta.reasoning_content === "string") {
    parts.push({ text: delta.reasoning_content, isReasoning: true });
  }
  if (typeof delta.content === "string") {
    parts.push({ text: delta.content });
  }
  return parts.length > 0 ? parts : null;
},
```

The `isReasoning: true` flag causes Copilotz to emit `TOKEN` events with `isReasoning: true`, which clients can use to render reasoning in a collapsible section.

## What this unlocks

- Use any LLM provider — if it has an HTTP API, you can integrate it
- Private/on-premises model deployments work out of the box
- Never wait for a framework update to test a new model
- Per-agent provider selection — mix providers freely

## What's next

You've reached the end of the core guide. There are three more extension points worth knowing about — Collections (for typed application data), Features (for custom API endpoints), and Web Libraries (for client-side integration). The next chapter gives you an orientation to all three and points you toward the full documentation.

→ **[Chapter 22: What's Next](./22-whats-next.md))**
