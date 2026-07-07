import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildAdminUsageSourceCte,
  buildAttemptUsageSumSelects,
  buildUsageMeteringSumSelects,
  buildUsageSumSelects,
} from "./_helpers.ts";

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

Deno.test("admin attempt usage sums read nested canonical fields", () => {
  const sql = buildAttemptUsageSumSelects('u."data"');

  assertStringIncludes(sql, `->'usage'->>'inputTokens'`);
  assertStringIncludes(sql, `->'usage'->>'totalTokens'`);
  assertStringIncludes(sql, `->'cost'->>'inputCostUsd'`);
  assertStringIncludes(sql, `->'cost'->>'totalCostUsd'`);
  assert(!sql.includes(`legacy_usage`));
});

Deno.test("admin usage metering sums read generic metrics", () => {
  const sql = buildUsageMeteringSumSelects('u."data"');

  assertStringIncludes(sql, `->'metrics'->>'calls'`);
  assertStringIncludes(sql, `->'metrics'->>'durationMs'`);
  assertStringIncludes(sql, `->'metrics'->>'credits'`);
  assertStringIncludes(sql, `"failedCalls"`);
  assertStringIncludes(sql, `"unpricedCalls"`);
});

Deno.test("admin usage source reads canonical usage ledger rows", () => {
  const sql = buildAdminUsageSourceCte();

  assertStringIncludes(sql, `a."type" = 'usage'`);
  assertStringIncludes(sql, `a."data"->>'kind' = 'llm'`);
  // Flat passthrough — no per-row jsonb rebuild of nested usage/cost.
  assert(!sql.includes(`jsonb_build_object(`));
  assertStringIncludes(sql, `a."data" AS "data"`);
  assertStringIncludes(sql, `a."data"->>'resource'`);
  assertStringIncludes(sql, `a."data"->>'operation'`);
  assertStringIncludes(sql, `a."data"->>'status'`);
  assertStringIncludes(sql, `a."data"->>'initiatedById'`);
  assert(!sql.includes(`legacy_usage`));
  assertStringIncludes(sql, `a."data"->>'eventId'`);
});

Deno.test("admin usage source can opt into all usage kinds", () => {
  const sql = buildAdminUsageSourceCte(`"admin_usage_source"`, {
    includeAllKinds: true,
  });

  assertStringIncludes(sql, `a."type" = 'usage'`);
  assert(!sql.includes(`a."data"->>'kind' = 'llm'`));
});

Deno.test("admin usage source can filter a specific non-LLM kind", () => {
  const sql = buildAdminUsageSourceCte(`"admin_usage_source"`, {
    kindPlaceholder: "$1",
  });

  assertStringIncludes(sql, `a."data"->>'kind' = $1`);
  assert(!sql.includes(`a."data"->>'kind' = 'llm'`));
});

Deno.test("admin usage source can push threadId into source scans", () => {
  const sql = buildAdminUsageSourceCte(`"admin_usage_source"`, {
    threadIdPlaceholder: "$1",
  });

  assertStringIncludes(
    sql,
    `COALESCE(a."data"->>'threadId', a."source_id") = $1`,
  );
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
