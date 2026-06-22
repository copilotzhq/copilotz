import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildAdminUsageSourceCte, buildUsageSumSelects } from "./_helpers.ts";

Deno.test("admin usage sums read only canonical flattened fields", () => {
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

Deno.test("admin usage source prefers llm_attempt and keeps llm_usage as fallback", () => {
  const sql = buildAdminUsageSourceCte();

  assertStringIncludes(sql, `a."type" = 'llm_attempt'`);
  assertStringIncludes(sql, `a."data"->'usage'->'inputTokens'`);
  assertStringIncludes(sql, `a."data"->'cost'->'totalCostUsd'`);
  assertStringIncludes(sql, `legacy_usage."data"->'totalCostUsd'`);
  assertStringIncludes(sql, `u."type" = 'llm_usage'`);
  assertStringIncludes(sql, `AND NOT EXISTS`);
  assertStringIncludes(sql, `a."data"->>'eventId'`);
});
