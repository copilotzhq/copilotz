import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildUsageSumSelects } from "./_helpers.ts";

Deno.test("admin usage sums read only canonical llm_usage fields", () => {
  const sql = buildUsageSumSelects('u."data"');

  for (
    const field of [
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "cacheReadInputTokens",
      "cacheCreationInputTokens",
      "totalTokens",
      "inputCostUsd",
      "outputCostUsd",
      "reasoningCostUsd",
      "cacheReadInputCostUsd",
      "cacheCreationInputCostUsd",
      "totalCostUsd",
    ]
  ) {
    assertStringIncludes(sql, `->>'${field}'`);
  }

  for (
    const legacyField of [
      "promptTokens",
      "completionTokens",
      "promptCost",
      "completionCost",
      "totalCost",
    ]
  ) {
    assert(!sql.includes(`->>'${legacyField}'`));
  }
});
