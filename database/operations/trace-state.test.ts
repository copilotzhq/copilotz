import { assertEquals } from "@std/assert";
import { createDatabase } from "../index.ts";

Deno.test({
  name: "getQueueTraceState returns only active or terminal trace state",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'events'
         AND indexname = 'idx_events_trace_status'`,
    );
    assertEquals(indexes.rows[0]?.indexname, "idx_events_trace_status");

    const thread = await db.ops.findOrCreateThread(undefined, {
      name: "Trace State Test",
      participants: ["user-1"],
      status: "active",
      mode: "immediate",
    });
    const traceId = crypto.randomUUID();

    const completed = await db.ops.addToQueue(thread.id as string, {
      eventType: "NEW_MESSAGE",
      payload: { content: "completed" },
      traceId,
      status: "completed",
    });
    assertEquals(await db.ops.getQueueTraceState(traceId), undefined);

    const pending = await db.ops.addToQueue(thread.id as string, {
      eventType: "NEW_MESSAGE",
      payload: { content: "pending" },
      traceId,
      status: "pending",
    });
    assertEquals(await db.ops.getQueueTraceState(traceId), {
      id: pending.id,
      status: "pending",
    });

    const failed = await db.ops.addToQueue(thread.id as string, {
      eventType: "NEW_MESSAGE",
      payload: { content: "failed" },
      traceId,
      status: "failed",
    });
    assertEquals(await db.ops.getQueueTraceState(traceId), {
      id: failed.id,
      status: "failed",
    });

    await db.ops.updateQueueItemStatus(String(pending.id), "completed");
    await db.ops.updateQueueItemStatus(String(failed.id), "completed");
    assertEquals(await db.ops.getQueueTraceState(traceId), undefined);
    assertEquals(
      (await db.ops.getQueueItemById(String(completed.id)))?.status,
      "completed",
    );
  },
});
