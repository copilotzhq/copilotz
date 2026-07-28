import { assertEquals, assertExists } from "@std/assert";

import { createDatabase } from "@/database/index.ts";
import { runThread } from "./index.ts";
import type { ChatContext, MessagePayload } from "@/types/index.ts";

Deno.test({
  name:
    "runThread advances abort generations atomically and preserves soft runs",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const context = {
      namespace: "tenant-run-generation",
      processors: {},
      agents: [],
      stream: false,
    } as ChatContext;
    const message = (content: string): MessagePayload => ({
      content,
      sender: { id: "user-1", type: "user", name: "User" },
      thread: {
        externalId: "external-run-generation",
        name: "Run generation",
      },
    });

    const first = await runThread(db, context, message("first"));
    await first.done;
    const thread = await db.ops.getThreadByExternalId(
      "external-run-generation",
      context.namespace,
    );
    assertExists(thread);
    assertEquals(await db.ops.getThreadRunGeneration(String(thread.id)), 1);

    const firstEvent = await db.ops.getQueueItemById(first.queueId);
    assertEquals(firstEvent?.runGeneration, 1);
    assertEquals(
      (firstEvent?.metadata as Record<string, unknown>)?.runId,
      firstEvent?.traceId,
    );

    const soft = await runThread(
      db,
      context,
      message("soft"),
      { interruptMode: "soft", stream: false },
    );
    await soft.done;
    assertEquals(await db.ops.getThreadRunGeneration(String(thread.id)), 1);
    assertEquals(
      (await db.ops.getQueueItemById(soft.queueId))?.runGeneration,
      1,
    );
  },
});
