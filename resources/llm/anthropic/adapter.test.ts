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
