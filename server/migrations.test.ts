import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createDatabase } from "@/database/index.ts";
import {
  migrateLlmUsageContractWithQuery,
  migrateLlmUsageToUsageLedgerWithQuery,
} from "./migrations.ts";

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

Deno.test({
  name: "llm_usage -> usage ledger migration converts rows in place and is idempotent",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const node = await db.ops.createNode({
      namespace: "tenant-ledger",
      type: "llm_usage",
      name: "completed:openai:gpt-test",
      data: {
        threadId: "thread-1",
        eventId: "event-1",
        agentId: "agent-1",
        provider: "openai",
        model: "gpt-test",
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        totalCostUsd: 0.03,
        runSender: { externalId: "user-1" },
      },
      sourceType: "thread",
      sourceId: "thread-1",
    });

    const result = await migrateLlmUsageToUsageLedgerWithQuery(
      db,
      "tenant-ledger",
    );
    assertEquals(result, { namespace: "tenant-ledger", migratedRows: 1 });

    // Node id is preserved so usageNodeId references and edges stay valid.
    const migrated = await db.ops.getNodeById(node.id as string);
    assertEquals(migrated?.type, "usage");
    const data = migrated?.data as Record<string, unknown>;
    assertEquals(data.kind, "llm");
    assertEquals(data.resource, "gpt-test");
    assertEquals(data.operation, "chat");
    assertEquals(data.initiatedById, "user-1");
    // Flat fields are retained; metrics map is derived from them.
    assertEquals(data.totalTokens, 30);
    assertEquals(data.totalCostUsd, 0.03);
    const metrics = data.metrics as Record<string, number>;
    assertEquals(metrics.inputTokens, 10);
    assertEquals(metrics.outputTokens, 20);
    assertEquals(metrics.totalTokens, 30);

    const second = await migrateLlmUsageToUsageLedgerWithQuery(
      db,
      "tenant-ledger",
    );
    assertEquals(second.migratedRows, 0);
  },
});
