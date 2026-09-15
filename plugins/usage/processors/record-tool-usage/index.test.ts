import { assertEquals } from "@std/assert";
import { toolUsageProcessor } from "./index.ts";
import { toolUsageRecord } from "../internal/accounting.ts";

Deno.test("Tool Usage Processor retains its canonical id", () => {
  assertEquals(
    toolUsageProcessor.id,
    "copilotz.usage.record-tool-action",
  );
});

Deno.test("deferred Ask is recorded as a deferred Action, not an answer success", () => {
  const row = toolUsageRecord(
    {
      actionRunId: "ask-run",
      status: "completed",
      metadata: {
        schema: "copilotz.core.tool-action.v1",
        action: "ask",
        threadId: "thread-a",
      },
      output: { status: "deferred" },
    },
    {
      durable: true,
      id: "event-a",
      correlationId: "correlation-a",
      createdAt: "2026-09-07T00:00:00.000Z",
    } as never,
    null,
  );
  assertEquals(row.status, "deferred");
  assertEquals(row.statusReason, "deferred");
  assertEquals(row.metrics, { calls: 1 });
});
