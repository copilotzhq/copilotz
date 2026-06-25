import { assertEquals } from "@std/assert";
import {
  inclusiveInputTokensFromRawUsage,
  promptCacheHitRate,
  withInclusiveInputTokens,
} from "@/runtime/llm/usage.ts";

Deno.test("withInclusiveInputTokens folds Anthropic-style cache fields into input", () => {
  const usage = withInclusiveInputTokens({
    inputTokens: 1252,
    outputTokens: 213,
    cacheReadInputTokens: 114,
    cacheCreationInputTokens: 0,
  });

  assertEquals(usage.inputTokens, 1366);
  assertEquals(usage.totalTokens, 1579);
  assertEquals(usage.cacheReadInputTokens, 114);
});

Deno.test("promptCacheHitRate uses inclusive input semantics", () => {
  assertEquals(
    promptCacheHitRate({ inputTokens: 1000, cacheReadInputTokens: 800 }),
    0.8,
  );
  assertEquals(promptCacheHitRate({ inputTokens: 0, cacheReadInputTokens: 0 }), null);
});

Deno.test("inclusiveInputTokensFromRawUsage repairs stored Anthropic raw usage", () => {
  assertEquals(
    inclusiveInputTokensFromRawUsage({
      input_tokens: 1252,
      cache_read_input_tokens: 114,
      cache_creation_input_tokens: 0,
    }, 1252),
    1366,
  );
  assertEquals(
    inclusiveInputTokensFromRawUsage({ prompt_tokens: 1000 }, 1000),
    1000,
  );
});
