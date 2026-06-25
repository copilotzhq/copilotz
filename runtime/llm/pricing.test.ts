import { assertEquals } from "@std/assert";
import type { TokenUsage } from "@/runtime/llm/types.ts";
import { OPENROUTER_MODELS_URL } from "@/runtime/llm/model-catalog.ts";
import {
  __resetPricingCatalogCacheForTests,
  estimateUsageCost,
} from "@/runtime/llm/pricing.ts";

const catalogEntry = {
  id: "test/model",
  pricing: {
    prompt: "0.001",
    completion: "0.002",
    input_cache_read: "0.0001",
    input_cache_write: "0.0005",
  },
};

function withMockCatalog(
  fn: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    assertEquals(String(url), OPENROUTER_MODELS_URL);
    return Promise.resolve(
      new Response(
        JSON.stringify({ data: [catalogEntry] }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  };

  return fn().finally(() => {
    globalThis.fetch = originalFetch;
    __resetPricingCatalogCacheForTests();
  });
}

Deno.test("estimateUsageCost bills inclusive OpenAI-style input tokens", async () => {
  await withMockCatalog(async () => {
    const usage: TokenUsage = {
      source: "provider",
      status: "completed",
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadInputTokens: 800,
      rawUsage: {
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    };

    const cost = await estimateUsageCost(
      {
        provider: "openai",
        model: "ignored",
        pricingModelId: "test/model",
        estimateCost: true,
      },
      usage,
    );

    assertEquals(cost?.inputCostUsd, 0.2);
    assertEquals(cost?.cacheReadInputCostUsd, 0.08);
  });
});

Deno.test("estimateUsageCost repairs Anthropic-style raw usage for billing", async () => {
  await withMockCatalog(async () => {
    const usage: TokenUsage = {
      source: "provider",
      status: "completed",
      inputTokens: 1252,
      outputTokens: 213,
      cacheReadInputTokens: 114,
      rawUsage: {
        input_tokens: 1252,
        output_tokens: 213,
        cache_read_input_tokens: 114,
        cache_creation_input_tokens: 0,
      },
    };

    const cost = await estimateUsageCost(
      {
        provider: "minimax",
        model: "ignored",
        pricingModelId: "test/model",
        estimateCost: true,
      },
      usage,
    );

    assertEquals(cost?.inputCostUsd, 1.252);
    assertEquals(cost?.cacheReadInputCostUsd, 0.0114);
  });
});
