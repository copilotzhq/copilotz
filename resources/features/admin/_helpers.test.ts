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
  assertStringIncludes(sql, `"admin_usage_attempts"`);
  assertStringIncludes(sql, `"admin_usage_legacy_match"`);
  assertStringIncludes(sql, `WHERE NOT EXISTS`);
  assertStringIncludes(sql, `a."data"->>'eventId'`);
});

Deno.test("admin usage source pushes namespace and time filters into source scans", () => {
  const sql = buildAdminUsageSourceCte(`"admin_usage_source"`, {
    namespacePlaceholder: "$1",
    fromPlaceholder: "$2",
    toPlaceholder: "$3",
  });

  assertStringIncludes(sql, `a."namespace" = $1`);
  assertStringIncludes(sql, `a."created_at" >= $2`);
  assertStringIncludes(sql, `a."created_at" <= $3`);
  assertStringIncludes(sql, `u."namespace" = $1`);
  assertStringIncludes(sql, `u."created_at" >= $2`);
  assertStringIncludes(sql, `u."created_at" <= $3`);
  assertStringIncludes(sql, `legacy_usage."namespace" = a."namespace"`);
});
