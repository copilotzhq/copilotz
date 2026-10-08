import { assert, assertEquals } from "@std/assert";
import { historyLimitEstimatedTokens } from "./history-budget.ts";

Deno.test("history capacity follows the preferred model regardless of fallback capacity", async () => {
  const connections = { test: { adapter: "test" } };
  const request = { instructions: "prefix ".repeat(2_000), messages: [] };
  const first = {
    connection: "test",
    model: "first",
    options: {
      limitEstimatedInputTokens: 180_000,
      maxTokens: 30_000,
    },
  };
  const single = await historyLimitEstimatedTokens(
    { models: [first], request, mode: "generate" },
    connections,
    "test",
  );
  const constrained = await historyLimitEstimatedTokens(
    {
      mode: "generate",
      models: [first, {
        connection: "test",
        model: "fallback",
        options: {
          limitEstimatedInputTokens: 70_000,
          maxTokens: 40_000,
        },
      }],
      request,
    },
    connections,
    "test",
  );
  assert(single > 140_000 && single < 150_000);
  assertEquals(constrained, single);
  const larger = await historyLimitEstimatedTokens(
    {
      mode: "generate",
      models: [first, {
        connection: "test",
        model: "larger",
        options: {
          limitEstimatedInputTokens: 240_000,
          maxTokens: 20_000,
        },
      }],
      request,
    },
    connections,
    "test",
  );
  assertEquals(larger, single);
  assertEquals(
    await historyLimitEstimatedTokens(
      {
        mode: "generate",
        models: [{
          ...first,
          options: { limitEstimatedInputTokens: 1_000, maxTokens: 1_000 },
        }],
        request,
      },
      connections,
      "test",
    ),
    0,
  );
});
