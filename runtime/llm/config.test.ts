import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  mergeLLMRuntimeConfig,
  resolveProviderApiKey,
  toLLMConfig,
} from "./config.ts";

Deno.test("toLLMConfig removes apiKey from primary config and fallbacks", () => {
  const config = toLLMConfig({
    provider: "openai",
    model: "gpt-4.1",
    temperature: 0.2,
    apiKey: "secret-primary",
    fallbacks: [
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5-20241022",
        apiKey: "secret-fallback",
      },
    ],
  });

  assertEquals(config, {
    limitEstimatedInputTokens: 150000,
    provider: "openai",
    model: "gpt-4.1",
    temperature: 0.2,
    fallbacks: [
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5-20241022",
      },
    ],
  });
});

Deno.test("toLLMConfig defaults limitEstimatedInputTokens to 150000", () => {
  const config = toLLMConfig({
    provider: "openai",
    model: "gpt-4.1",
  });

  assertEquals(config.limitEstimatedInputTokens, 150000);
});

Deno.test("toLLMConfig preserves an explicit limitEstimatedInputTokens value", () => {
  const config = toLLMConfig({
    provider: "openai",
    model: "gpt-4.1",
    limitEstimatedInputTokens: 32000,
  });

  assertEquals(config.limitEstimatedInputTokens, 32000);
});

Deno.test("mergeLLMRuntimeConfig overlays runtime values on persisted config", () => {
  const merged = mergeLLMRuntimeConfig(
    {
      provider: "openai",
      model: "gpt-4.1",
      baseUrl: "https://api.openai.com/v1",
    },
    {
      apiKey: "secret",
      baseUrl: "https://proxy.example.com/v1",
    },
  );

  assertEquals(merged, {
    provider: "openai",
    model: "gpt-4.1",
    baseUrl: "https://proxy.example.com/v1",
    apiKey: "secret",
  });
});

Deno.test("resolveProviderApiKey prefers provider-specific env and falls back to LLM_API_KEY", () => {
  assertEquals(
    resolveProviderApiKey(
      { provider: "anthropic", model: "claude" },
      {
        ANTHROPIC_API_KEY: "anthropic-secret",
        LLM_API_KEY: "generic-secret",
      },
    ),
    "anthropic-secret",
  );

  assertEquals(
    resolveProviderApiKey(
      { provider: "deepseek", model: "chat" },
      {
        LLM_API_KEY: "generic-secret",
      },
    ),
    "generic-secret",
  );
});
