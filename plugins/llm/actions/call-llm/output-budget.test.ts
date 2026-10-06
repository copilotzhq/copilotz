import { assertEquals } from "@std/assert";
import { prepareLlmCall } from "./index.ts";

Deno.test("prepared output allowances follow provider defaults, precedence and thinking budgets", async () => {
  const cases = [
    {
      provider: "openai",
      model: "gpt-4o",
      options: { maxTokens: 1_000, maxCompletionTokens: 2_000 },
      expected: 2_000,
    },
    {
      provider: "gemini",
      model: "gemini-2.5-pro",
      options: { maxTokens: 1_000, maxCompletionTokens: 2_000 },
      expected: 1_000,
    },
    {
      provider: "minimax",
      model: "MiniMax-M2.7",
      options: {},
      expected: 4_096,
    },
    {
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      options: { reasoningEffort: "high" },
      expected: 65_537,
    },
    {
      provider: "anthropic",
      model: "claude-opus-5",
      options: { reasoningEffort: "high", maxTokens: 30_000 },
      expected: 30_000,
    },
  ] as const;
  for (const item of cases) {
    const prepared = await prepareLlmCall({
      mode: "generate",
      models: [{
        connection: "test",
        model: item.model,
        options: item.options,
      }],
      request: { instructions: "A short prompt.", messages: [] },
    }, {
      test: { provider: item.provider, auth: { apiKey: "unused-test-key" } },
    }, "test");
    assertEquals(prepared.candidates[0]?.outputTokenAllowance, item.expected);
  }
});
