import { geminiProvider } from "./providers/gemini.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import { openaiProvider } from "./providers/openai.ts";
import type { ProviderConfig } from "./types.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ||
        `Assertion failed.\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
    );
  }
}

const msg = [{ role: "user" as const, content: "hi" }];

// ---------------------------------------------------------------------------
// Gemini — thinkingConfig in body()
// ---------------------------------------------------------------------------

Deno.test("gemini body includes thinkingConfig with thinkingBudget for 2.5 + reasoningEffort", () => {
  const cfg: ProviderConfig = { apiKey: "k", model: "gemini-2.5-flash", reasoningEffort: "low" };
  const body = geminiProvider(cfg).body(msg, cfg);
  assertEquals(body.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingBudget: 2048,
  });
});

Deno.test("gemini body includes thinkingConfig with thinkingLevel for 3.x + reasoningEffort", () => {
  const cfg: ProviderConfig = { apiKey: "k", model: "gemini-3-flash-preview", reasoningEffort: "low" };
  const body = geminiProvider(cfg).body(msg, cfg);
  assertEquals(body.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: "LOW",
  });
});

Deno.test("gemini body includes thinkingConfig without effort fields when no reasoningEffort", () => {
  const cfg: ProviderConfig = { apiKey: "k", model: "gemini-2.5-flash" };
  const body = geminiProvider(cfg).body(msg, cfg);
  assertEquals(body.generationConfig.thinkingConfig, { includeThoughts: true });
});

Deno.test("gemini body omits thinkingConfig for non-thinking models", () => {
  const cfg: ProviderConfig = { apiKey: "k", model: "gemini-2.0-flash-lite-preview-02-05" };
  const body = geminiProvider(cfg).body(msg, cfg);
  assertEquals(body.generationConfig.thinkingConfig, undefined);
});

Deno.test("gemini body omits thinkingConfig for lite models without reasoningEffort", () => {
  const cfg: ProviderConfig = { apiKey: "k", model: "gemini-3.1-flash-lite-preview" };
  const body = geminiProvider(cfg).body(msg, cfg);
  assertEquals(body.generationConfig.thinkingConfig, undefined);
});

Deno.test("gemini body includes thinkingConfig for lite models with reasoningEffort", () => {
  const cfg: ProviderConfig = { apiKey: "k", model: "gemini-3.1-flash-lite-preview", reasoningEffort: "high" };
  const body = geminiProvider(cfg).body(msg, cfg);
  assertEquals(body.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: "HIGH",
  });
});

Deno.test("gemini body omits thinkingConfig when outputReasoning is false", () => {
  const cfg: ProviderConfig = { apiKey: "k", model: "gemini-2.5-flash", outputReasoning: false };
  const body = geminiProvider(cfg).body(msg, cfg);
  assertEquals(body.generationConfig.thinkingConfig, undefined);
});

Deno.test("gemini body respects geminiThinkingConfig override over reasoningEffort", () => {
  const cfg: ProviderConfig = {
    apiKey: "k",
    model: "gemini-3-flash-preview",
    reasoningEffort: "high",
    geminiThinkingConfig: { thinkingLevel: "MINIMAL" },
  };
  const body = geminiProvider(cfg).body(msg, cfg);
  assertEquals(body.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: "MINIMAL",
  });
});

Deno.test("gemini body respects geminiThinkingConfig.includeThoughts: false", () => {
  const cfg: ProviderConfig = {
    apiKey: "k",
    model: "gemini-2.5-flash",
    geminiThinkingConfig: { includeThoughts: false },
  };
  const body = geminiProvider(cfg).body(msg, cfg);
  assertEquals(body.generationConfig.thinkingConfig, undefined);
});

Deno.test("gemini extractContent tags thought parts correctly", () => {
  const api = geminiProvider({ apiKey: "k" } as ProviderConfig);
  const parts = api.extractContent({
    candidates: [{
      content: {
        parts: [
          { thought: true, text: "internal" },
          { text: "visible" },
        ],
      },
    }],
  });
  assertEquals(parts, [
    { text: "internal", isReasoning: true },
    { text: "visible" },
  ]);
});

// ---------------------------------------------------------------------------
// Anthropic — thinking config in body()
// ---------------------------------------------------------------------------

Deno.test("anthropic body adds thinking when reasoningEffort is set", () => {
  const cfg: ProviderConfig = { apiKey: "k", reasoningEffort: "low", maxTokens: 8000 };
  const body = anthropicProvider(cfg).body(msg, cfg) as Record<string, unknown>;
  assertEquals(body.thinking, { type: "enabled", budget_tokens: 4096 });
  assertEquals(body.temperature, undefined);
  assertEquals(body.max_tokens, 8000);
});

Deno.test("anthropic body ensures max_tokens > budget_tokens", () => {
  const cfg: ProviderConfig = { apiKey: "k", reasoningEffort: "high", maxTokens: 1000 };
  const body = anthropicProvider(cfg).body(msg, cfg) as Record<string, unknown>;
  assertEquals(body.thinking, { type: "enabled", budget_tokens: 65536 });
  assertEquals(body.max_tokens, 65537);
});

Deno.test("anthropic body omits thinking when no reasoningEffort", () => {
  const cfg: ProviderConfig = { apiKey: "k" };
  const body = anthropicProvider(cfg).body(msg, cfg) as Record<string, unknown>;
  assertEquals(body.thinking, undefined);
  assertEquals(body.temperature, 0);
});

Deno.test("anthropic extractContent parses thinking_delta and text_delta", () => {
  const api = anthropicProvider({ apiKey: "k" } as ProviderConfig);
  assertEquals(
    api.extractContent({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }),
    [{ text: "hmm", isReasoning: true }],
  );
  assertEquals(
    api.extractContent({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }),
    [{ text: "ok" }],
  );
});

// ---------------------------------------------------------------------------
// OpenAI — extractContent and reasoningEffort passthrough
// ---------------------------------------------------------------------------

Deno.test("openai body passes reasoningEffort directly", () => {
  const cfg: ProviderConfig = { apiKey: "k", reasoningEffort: "low" };
  const body = openaiProvider(cfg).body(msg, cfg);
  assertEquals(body.reasoning_effort, "low");
});

Deno.test("openai extractContent handles plain content", () => {
  const api = openaiProvider({ apiKey: "k" } as ProviderConfig);
  assertEquals(
    api.extractContent({ choices: [{ delta: { content: "hello" } }] }),
    [{ text: "hello" }],
  );
});

Deno.test("openai extractContent returns null for empty delta", () => {
  const api = openaiProvider({ apiKey: "k" } as ProviderConfig);
  assertEquals(api.extractContent({ choices: [{ delta: {} }] }), null);
  assertEquals(api.extractContent({ choices: [{ delta: { content: "" } }] }), null);
  assertEquals(api.extractContent({}), null);
});

Deno.test("openai extractContent extracts reasoning_content", () => {
  const api = openaiProvider({ apiKey: "k" } as ProviderConfig);
  assertEquals(
    api.extractContent({ choices: [{ delta: { reasoning_content: "think", content: "say" } }] }),
    [{ text: "think", isReasoning: true }, { text: "say" }],
  );
});

Deno.test("openai extractContent handles reasoning_content alone", () => {
  const api = openaiProvider({ apiKey: "k" } as ProviderConfig);
  assertEquals(
    api.extractContent({ choices: [{ delta: { reasoning_content: "step" } }] }),
    [{ text: "step", isReasoning: true }],
  );
});
