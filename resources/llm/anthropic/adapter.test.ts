import { assertEquals } from "@std/assert";

import { anthropicProvider } from "./adapter.ts";
import type { ChatMessage, ProviderConfig } from "@/runtime/llm/types.ts";

const messages: ChatMessage[] = [
  { role: "system", content: "Stable system instructions." },
  { role: "user", content: "Hello" },
];

Deno.test("anthropicProvider enables automatic prompt caching by default", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.cache_control, { type: "ephemeral" });
});

Deno.test("anthropicProvider supports 1h prompt cache TTL", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
    promptCache: { ttl: "1h" },
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.cache_control, { type: "ephemeral", ttl: "1h" });
});

Deno.test("anthropicProvider can disable prompt cache directives", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
    promptCache: false,
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals("cache_control" in body, false);
});

Deno.test("anthropicProvider forwards resolved native stop sequences", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
    nativeStopSequences: ["STOP", "<tool_results>", "</tool_results>"],
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.stop_sequences, [
    "STOP",
    "<tool_results>",
    "</tool_results>",
  ]);
});

Deno.test("anthropicProvider omits stop_sequences when none are configured", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.stop_sequences, undefined);
});

Deno.test("anthropicProvider maps adaptive effort for Claude Fable 5", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-fable-5",
    apiKey: "test",
    reasoningEffort: "high",
    temperature: 0,
    topP: 0.5,
    topK: 10,
    maxTokens: 30_000,
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.thinking, { type: "adaptive" });
  assertEquals(body.output_config, { effort: "high" });
  assertEquals(body.max_tokens, 30_000);
  assertEquals("temperature" in body, false);
  assertEquals("top_p" in body, false);
  assertEquals("top_k" in body, false);
  assertEquals(
    "budget_tokens" in (body.thinking as Record<string, unknown>),
    false,
  );
});

Deno.test("anthropicProvider enables always-on adaptive thinking for Fable without effort", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-fable-5",
    apiKey: "test",
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.thinking, { type: "adaptive" });
  assertEquals("output_config" in body, false);
});

Deno.test("anthropicProvider maps adaptive effort for Claude Opus 4.8", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-opus-4-8",
    apiKey: "test",
    reasoningEffort: "medium",
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.thinking, { type: "adaptive" });
  assertEquals(body.output_config, { effort: "medium" });
  assertEquals("temperature" in body, false);
  assertEquals(
    "budget_tokens" in (body.thinking as Record<string, unknown>),
    false,
  );
});

Deno.test("anthropicProvider keeps Opus 4.8 fallback requests valid without effort", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-opus-4-8",
    apiKey: "test",
    temperature: 1,
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals("thinking" in body, false);
  assertEquals("temperature" in body, false);
  assertEquals("top_p" in body, false);
  assertEquals("top_k" in body, false);
});

Deno.test("anthropicProvider makes Sonnet 5 adaptive thinking explicit by default", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    apiKey: "test",
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.thinking, { type: "adaptive" });
  assertEquals("output_config" in body, false);
});

Deno.test("anthropicProvider retains manual budgets for legacy Claude models", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
    reasoningEffort: "high",
    maxTokens: 30_000,
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.thinking, { type: "enabled", budget_tokens: 65536 });
  assertEquals(body.max_tokens, 65537);
  assertEquals("output_config" in body, false);
  assertEquals("temperature" in body, false);
});

Deno.test("anthropicProvider maps PDF file data URLs to document blocks", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
  };
  const body = anthropicProvider(config).body([
    {
      role: "user",
      content: [
        {
          type: "file",
          file: {
            file_data: "data:application/pdf;base64,JVBERi0xLjQK",
            mime_type: "application/pdf",
          },
        },
        { type: "text", text: "Summarize this PDF." },
      ],
    },
  ], config);

  assertEquals(body.messages, [{
    role: "user",
    content: [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "JVBERi0xLjQK",
        },
      },
      { type: "text", text: "Summarize this PDF." },
    ],
  }]);
});
