---
name: create-llm-provider
description: Register a custom text-model provider as a plugin resource.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, llm, provider, plugin]
---

# Create LLM Provider

Use a provider resource for a new model backend. Prefer an existing provider
with `baseUrl` configuration when the API is protocol-compatible.

```ts
import { definePlugin } from "jsr:@copilotz/copilotz@3/plugins";
import {
  defineLlmProviderResource,
  type LlmProviderResource,
} from "jsr:@copilotz/copilotz@3/workflows";

const provider: LlmProviderResource = defineLlmProviderResource({
  id: "acme-llm",
  type: "llm",
  factory: () => ({
    endpoint: "https://api.example.com/v1/chat/completions",
    headers: (config) => ({
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    }),
    body: (messages, config) => ({
      model: config.model,
      messages,
      stream: true,
    }),
    extractContent: (event) => {
      const text = event?.choices?.[0]?.delta?.content;
      return typeof text === "string" ? [{ text }] : null;
    },
  }),
});

export default definePlugin({
  manifest: {
    id: "@acme/llm-provider",
    version: "1.0.0",
    provides: { providers: [provider.id] },
  },
  resources: { providers: [provider] },
});
```

Agents reference the stable ID in
`runtimes.text: { type: "llm", provider: "acme-llm" }`. Dynamic secrets and
model policy belong in application configuration hooks; never persist secrets in
agent or provider metadata.

Implement message transformation, tool calls, usage, finish reasons, reasoning,
and stream framing to match the backend. Add contract tests for partial chunks,
malformed responses, aborts, retries, usage finalization, and tool-call output.
