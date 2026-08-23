import { assertEquals } from "@std/assert";

import type { ProviderConfig } from "../internal/types.ts";
import { anthropicProvider } from "./anthropic/protocol.ts";
import { deepseekProvider } from "./deepseek/protocol.ts";
import { geminiProvider } from "./gemini/protocol.ts";
import { groqProvider } from "./groq/protocol.ts";
import { minimaxProvider } from "./minimax/protocol.ts";
import { ollamaProvider } from "./ollama/protocol.ts";

Deno.test("private protocols receive construction-owned base URLs and headers", () => {
  const cases: readonly Readonly<{
    provider: (config: ProviderConfig) => {
      endpoint: string;
      headers(config: ProviderConfig): Record<string, string>;
    };
    config: ProviderConfig;
    endpoint: string;
  }>[] = [
    {
      provider: anthropicProvider,
      config: {
        baseUrl: "https://proxy.example/anthropic/",
        apiKey: "secret",
      },
      endpoint: "https://proxy.example/anthropic/messages",
    },
    {
      provider: geminiProvider,
      config: {
        baseUrl: "https://proxy.example/gemini/",
        model: "gemini-test",
        apiKey: "key with space",
      },
      endpoint:
        "https://proxy.example/gemini/models/gemini-test:streamGenerateContent?key=key%20with%20space&alt=sse",
    },
    {
      provider: groqProvider,
      config: {
        baseUrl: "https://proxy.example/groq/",
        apiKey: "secret",
      },
      endpoint: "https://proxy.example/groq/chat/completions",
    },
    {
      provider: deepseekProvider,
      config: {
        baseUrl: "https://proxy.example/deepseek/",
        apiKey: "secret",
      },
      endpoint: "https://proxy.example/deepseek/chat/completions",
    },
    {
      provider: ollamaProvider,
      config: {
        baseUrl: "https://proxy.example/ollama/",
        apiKey: "must-not-be-an-endpoint",
      },
      endpoint: "https://proxy.example/ollama/api/chat",
    },
    {
      provider: minimaxProvider,
      config: {
        baseUrl: "https://proxy.example/minimax/",
        apiKey: "secret",
      },
      endpoint: "https://proxy.example/minimax/anthropic/v1/messages",
    },
  ];

  for (const item of cases) {
    const config = {
      ...item.config,
      extraHeaders: { "X-Application": "copilotz" },
    };
    const protocol = item.provider(config);
    assertEquals(protocol.endpoint, item.endpoint);
    assertEquals(
      protocol.headers(config)["X-Application"],
      "copilotz",
    );
  }
});

Deno.test("Ollama no longer treats an API credential as its endpoint", () => {
  assertEquals(
    ollamaProvider({ apiKey: "credential-only" }).endpoint,
    "http://localhost:11434/api/chat",
  );
});
