import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  __resetPricingCatalogCacheForTests,
  estimateUsageCost,
  resolvePricingModelCandidates,
} from "./pricing.ts";
import type { TokenUsage } from "./types.ts";

Deno.test("resolvePricingModelCandidates applies provider aliases and explicit overrides", () => {
  assertEquals(
    resolvePricingModelCandidates({
      provider: "gemini",
      model: "gemini-3.1-flash-lite-preview",
    }),
    ["google/gemini-3.1-flash-lite-preview"],
  );

  assertEquals(
    resolvePricingModelCandidates({
      provider: "xai",
      model: "grok-4-fast",
    }),
    ["x-ai/grok-4-fast"],
  );

  assertEquals(
    resolvePricingModelCandidates({
      provider: "ollama",
      model: "meta-llama/llama-3.1-70b-instruct",
    }),
    ["meta-llama/llama-3.1-70b-instruct"],
  );

  assertEquals(
    resolvePricingModelCandidates({
      provider: "groq",
      model: "llama3-70b-8192",
      pricingModelId: "meta-llama/llama-3.1-70b-instruct",
    }),
    ["meta-llama/llama-3.1-70b-instruct"],
  );
});

Deno.test("estimateUsageCost mirrors token breakdown without double-counting", async () => {
  __resetPricingCatalogCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("openrouter.ai/api/v1/models")) {
      throw new Error(`Unexpected fetch url: ${url}`);
    }

    return new Response(JSON.stringify({
      data: [{
        id: "openai/gpt-5-mini",
        canonical_slug: "openai/gpt-5-mini-2026",
        pricing: {
          prompt: "0.00000025",
          completion: "0.000002",
          internal_reasoning: "0.000003",
          input_cache_read: "0.00000005",
          input_cache_write: "0.0000001",
        },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 200,
      totalTokens: 1200,
      source: "provider",
      status: "completed",
      rawUsage: null,
    };

    const cost = await estimateUsageCost({
      provider: "openai",
      model: "gpt-5-mini",
    }, usage);

    assertEquals(cost, {
      source: "openrouter",
      currency: "USD",
      pricingModelId: "openai/gpt-5-mini",
      inputCostUsd: 0.000175,
      outputCostUsd: 0.0003,
      reasoningCostUsd: 0.00015,
      cacheReadInputCostUsd: 0.000005,
      cacheCreationInputCostUsd: 0.00002,
      totalCostUsd: 0.00065,
    });
  } finally {
    globalThis.fetch = originalFetch;
    __resetPricingCatalogCacheForTests();
  }
});

Deno.test("estimateUsageCost silently returns null when OpenRouter is unavailable", async () => {
  __resetPricingCatalogCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;

  try {
    const cost = await estimateUsageCost({
      provider: "openai",
      model: "gpt-5-mini",
    }, {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      source: "provider",
      status: "completed",
      rawUsage: null,
    });

    assertEquals(cost, null);
  } finally {
    globalThis.fetch = originalFetch;
    __resetPricingCatalogCacheForTests();
  }
});

Deno.test("estimateUsageCost skips estimated usage to avoid rough cost projections", async () => {
  __resetPricingCatalogCacheForTests();
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not fetch");
  }) as typeof fetch;

  try {
    const cost = await estimateUsageCost({
      provider: "openai",
      model: "gpt-5-mini",
    }, {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      source: "estimated",
      status: "completed",
      rawUsage: null,
    });

    assertEquals(cost, null);
    assertEquals(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    __resetPricingCatalogCacheForTests();
  }
});
