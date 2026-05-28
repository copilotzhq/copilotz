import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  __resetModelCatalogCacheForTests,
  OPENROUTER_MODELS_URL,
  resolveModelCatalogCandidates,
  resolveModelCatalogEntry,
} from "@/runtime/llm/model-catalog.ts";

Deno.test("resolveModelCatalogEntry normalizes OpenRouter pricing and capabilities", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url) => {
    calls += 1;
    assertEquals(String(url), OPENROUTER_MODELS_URL);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{
            id: "openai/gpt-test",
            canonical_slug: "openai/gpt-test-2026",
            pricing: {
              prompt: "0.000001",
              completion: "0.000002",
              internal_reasoning: "0.000003",
              input_cache_read: "0.0000001",
              input_cache_write: "0.0000002",
            },
            architecture: {
              input_modalities: ["text", "image", "file"],
              output_modalities: ["text"],
              tokenizer: "GPT",
              instruct_type: "responses",
              modality: "text+image->text",
            },
            supported_parameters: ["tools", "reasoning_effort"],
            context_length: 128000,
            top_provider: {
              context_length: 128000,
              max_completion_tokens: 32000,
              is_moderated: true,
            },
          }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  };

  try {
    __resetModelCatalogCacheForTests();
    const entry = await resolveModelCatalogEntry({
      provider: "openai",
      model: "gpt-test",
    });

    assertExists(entry);
    assertEquals(entry.id, "openai/gpt-test");
    assertEquals(entry.pricing.prompt, 0.000001);
    assertEquals(entry.architecture?.inputModalities, [
      "text",
      "image",
      "file",
    ]);
    assertEquals(entry.supportedParameters, ["tools", "reasoning_effort"]);
    assertEquals(entry.contextLength, 128000);
    assertEquals(entry.topProvider?.maxCompletionTokens, 32000);

    const cached = await resolveModelCatalogEntry({
      provider: "openai",
      model: "gpt-test",
    });
    assertEquals(cached?.id, "openai/gpt-test");
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetModelCatalogCacheForTests();
  }
});

Deno.test("resolveModelCatalogCandidates maps native provider names to OpenRouter ids", () => {
  assertEquals(
    resolveModelCatalogCandidates({
      provider: "gemini",
      model: "gemini-3.1-pro-preview",
    }),
    ["google/gemini-3.1-pro-preview"],
  );
  assertEquals(
    resolveModelCatalogCandidates({
      provider: "openai",
      model: "openai/gpt-test",
      pricingModelId: "custom/model",
    }),
    ["custom/model", "openai/openai/gpt-test", "openai/gpt-test"],
  );
});
