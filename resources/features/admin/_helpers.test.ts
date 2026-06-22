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

Deno.test("admin usage source reads only canonical llm_attempt rows", () => {
  const sql = buildAdminUsageSourceCte();

  assertStringIncludes(sql, `a."type" = 'llm_attempt'`);
  assertStringIncludes(sql, `a."data"->'usage'->'inputTokens'`);
  assertStringIncludes(sql, `a."data"->'cost'->'totalCostUsd'`);
  assert(!sql.includes(`llm_usage`));
  assert(!sql.includes(`legacy_usage`));
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
  assert(!sql.includes(`u."namespace"`));
  assert(!sql.includes(`u."created_at"`));
});
