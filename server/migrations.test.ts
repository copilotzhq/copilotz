import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createDatabase } from "@/database/index.ts";
import { migrateLlmUsageContractWithQuery } from "./migrations.ts";

Deno.test({
  name: "llm usage contract migration rewrites legacy fields once",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const node = await db.ops.createNode({
      namespace: "tenant-test",
      type: "llm_usage",
      name: "legacy usage",
      data: {
        threadId: "thread-1",
        promptTokens: 10,
        completionTokens: 20,
        outputTokens: 22,
        totalTokens: 30,
        promptCost: 0.01,
        completionCost: 0.02,
        totalCost: 0.03,
      },
      sourceType: "thread",
      sourceId: "thread-1",
    });

    const result = await migrateLlmUsageContractWithQuery(db, "tenant-test");
    assertEquals(result, {
      namespace: "tenant-test",
      updatedUsageRows: 1,
    });

    const migrated = await db.ops.getNodeById(node.id as string);
    const data = migrated?.data as Record<string, unknown>;
    assertEquals(data.inputTokens, 10);
    assertEquals(data.outputTokens, 22);
    assertEquals(data.totalTokens, 30);
    assertEquals(data.inputCostUsd, 0.01);
    assertEquals(data.outputCostUsd, 0.02);
    assertEquals(data.totalCostUsd, 0.03);
    assert(!("promptTokens" in data));
    assert(!("completionTokens" in data));
    assert(!("promptCost" in data));
    assert(!("completionCost" in data));
    assert(!("totalCost" in data));

    const secondResult = await migrateLlmUsageContractWithQuery(
      db,
      "tenant-test",
    );
    assertEquals(secondResult.updatedUsageRows, 0);
  },
});
