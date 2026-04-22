# LLM Providers

Copilotz ships with adapters for OpenAI, Anthropic, Gemini, Groq, DeepSeek,
Ollama, and MiniMax. You can add your own by implementing the `ProviderFactory`
interface.

## Using a Built-in Provider

Set `provider` and `model` in your agent's `llmOptions`:

```typescript
const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    instructions: "You are a helpful assistant.",
    llmOptions: {
      provider: "openai",
      model: "gpt-4o-mini",
      temperature: 0.7,
    },
  }],
  // ...
});
```

The provider is resolved by name from the built-in registry. API keys are read
from provider-specific environment variables (for example `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`) and fall back to `LLM_API_KEY`.

## Built-in Providers

| Provider    | Env Variable        | Models                                           |
| ----------- | ------------------- | ------------------------------------------------ |
| `openai`    | `OPENAI_API_KEY`    | gpt-4o, gpt-4o-mini, o1, o3-mini, etc.           |
| `anthropic` | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514, claude-3.5-haiku, etc. |
| `gemini`    | `GEMINI_API_KEY`    | gemini-2.0-flash, gemini-2.5-pro, etc.           |
| `groq`      | `GROQ_API_KEY`      | llama-3.3-70b, mixtral-8x7b, etc.                |
| `deepseek`  | `DEEPSEEK_API_KEY`  | deepseek-chat, deepseek-reasoner                 |
| `ollama`    | —                   | Any locally running model                        |
| `minimax`   | `MINIMAX_API_KEY`   | MiniMax models                                   |

If you need tenant-specific or agent-specific credentials, use
`createCopilotz({ security: { resolveLLMRuntimeConfig } })` instead of putting
secrets into persisted `llmOptions`.

## Writing a Custom Provider

A provider is a factory function that takes a `ProviderConfig` and returns a
`ProviderAPI` object:

```typescript
import type {
  ChatMessage,
  ExtractedPart,
  ProviderConfig,
  ProviderFactory,
  ProviderUsageUpdate,
} from "@copilotz/copilotz";

export const myProvider: ProviderFactory = (config: ProviderConfig) => {
  return {
    endpoint: "https://api.my-llm.com/v1/chat/completions",

    headers: (config: ProviderConfig) => ({
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    }),

    body: (messages: ChatMessage[], config: ProviderConfig) => ({
      model: config.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: config.stream,
    }),

    extractContent: (data: unknown): ExtractedPart[] | null => {
      const chunk = data as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const text = chunk?.choices?.[0]?.delta?.content;
      if (!text) return null;
      return [{ type: "text", text }];
    },

    extractUsage: (data: unknown): ProviderUsageUpdate | null => {
      const response = data as { usage?: Record<string, number> };
      const usage = response?.usage;
      if (!usage) return null;
      return {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        rawUsage: usage as Record<string, unknown>,
      };
    },
  };
};
```

### ProviderAPI Interface

| Property                      | Required | Description                                                   |
| ----------------------------- | -------- | ------------------------------------------------------------- |
| `endpoint`                    | Yes      | The chat completions URL                                      |
| `headers(config)`             | Yes      | Returns request headers                                       |
| `body(messages, config)`      | Yes      | Builds the request body from messages and config              |
| `extractContent(data)`        | Yes      | Extracts text/reasoning parts from a single SSE chunk         |
| `extractUsage(data)`          | No       | Extracts token usage from a chunk (for cost tracking)         |
| `transformMessages(messages)` | No       | Pre-transform messages before `body()` is called              |
| `streamOptions`               | No       | Options for the shared stream processor (format, postProcess) |

### ProviderConfig

The `config` object passed to your factory and methods contains:

| Field                       | Description                                                             |
| --------------------------- | ----------------------------------------------------------------------- |
| `apiKey`                    | API key (from env or explicit config)                                   |
| `model`                     | Model name                                                              |
| `baseUrl`                   | Optional base URL override                                              |
| `temperature`               | Sampling temperature                                                    |
| `maxTokens`                 | Max tokens to generate                                                  |
| `limitEstimatedInputTokens` | Approximate input/history budget using Copilotz's rough token estimator |
| `stream`                    | Whether to stream the response                                          |
| `tools`                     | Tool definitions (for function calling)                                 |
| `toolChoice`                | Tool choice strategy                                                    |

Copilotz now distinguishes between:

- `LLMConfig`: safe config that can be persisted in `LLM_CALL` events
- `LLMRuntimeConfig` / `ProviderConfig`: runtime config actually passed to the
  provider

That means `LLM_CALL` events keep provider/model/options for observability, but
runtime secrets such as `apiKey` should come from env defaults or
`security.resolveLLMRuntimeConfig`.

## Registering a Custom Provider

### Via config

Pass your provider factory in the `llm` option:

```typescript
import { myProvider } from "./my-provider.ts";

const copilotz = await createCopilotz({
  llm: { "my-llm": myProvider },
  agents: [{
    id: "assistant",
    instructions: "...",
    llmOptions: { provider: "my-llm", model: "my-model" },
  }],
  // ...
});
```

### Via resources directory

Create `resources/llm/my-llm/adapter.ts`:

```typescript
import type { ProviderFactory } from "@copilotz/copilotz";

export const myLlmProvider: ProviderFactory = (config) => ({
  endpoint: "https://api.my-llm.com/v1/chat",
  headers: (config) => ({ "Authorization": `Bearer ${config.apiKey}` }),
  body: (messages, config) => ({ model: config.model, messages }),
  extractContent: (data) => {
    const text = (data as any)?.choices?.[0]?.delta?.content;
    return text ? [{ type: "text", text }] : null;
  },
});
```

And declare it in `resources/manifest.ts`:

```typescript
export default {
  provides: {
    llm: ["my-llm"],
  },
};
```

## OpenAI-Compatible APIs

Many providers (Together, Fireworks, Perplexity, etc.) expose an
OpenAI-compatible API. Use the built-in `openai` provider with a custom
`baseUrl`:

```typescript
llmOptions: {
  provider: "openai",
  model: "meta-llama/Llama-3-70b",
  baseUrl: "https://api.together.xyz/v1",
}
```

```typescript
const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    name: "Assistant",
    role: "assistant",
    llmOptions: {
      provider: "openai",
      model: "meta-llama/Llama-3-70b",
      baseUrl: "https://api.together.xyz/v1",
    },
  }],
  security: {
    resolveLLMRuntimeConfig: async ({ provider }) => {
      if (provider === "openai") {
        return { apiKey: Deno.env.get("TOGETHER_API_KEY") };
      }
      return undefined;
    },
  },
});
```

## Next Steps

- [Resources](./resources.md) — Resource system overview
- [Embeddings](./embeddings.md) — Custom embedding providers
- [Events](./events.md) — Custom event processors
