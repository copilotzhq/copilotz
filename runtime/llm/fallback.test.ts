import {
  assertEquals,
  assertInstanceOf,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { chat, LLMProviderError } from "@/runtime/llm/index.ts";
import type { ProviderRegistry } from "@/runtime/llm/types.ts";

const registry: ProviderRegistry = {
  anthropic: () => ({
    endpoint: "https://example.test/anthropic",
    headers: () => ({}),
    body: () => ({}),
    extractContent: () => null,
  }),
};

Deno.test("chat wraps provider rate limits as structured LLMProviderError when no fallback is configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("rate limited", {
      status: 429,
      statusText: "Too Many Requests",
    }));

  try {
    let thrown: unknown;
    try {
      await chat(
        { messages: [{ role: "user", content: "hello" }] },
        { provider: "anthropic", model: "claude-test", apiKey: "test" },
        {},
        undefined,
        registry,
      );
    } catch (error) {
      thrown = error;
    }

    assertInstanceOf(thrown, LLMProviderError);
    assertEquals(thrown.reason, "rate_limit");
    assertEquals(thrown.provider, "anthropic");
    assertEquals(thrown.model, "claude-test");
    assertEquals(thrown.status, 429);
    assertEquals(thrown.fallbackAttempted, false);
    assertEquals(thrown.attempts.length, 1);
    assertEquals(thrown.attempts[0].reason, "rate_limit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
