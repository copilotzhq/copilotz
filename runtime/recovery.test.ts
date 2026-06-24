import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "@/database/index.ts";
import { recoverStuckThreads } from "@/runtime/index.ts";
import type { EventProcessor, ProcessorDeps } from "@/types/index.ts";

Deno.test({
  name: "recoverStuckThreads wakes pending work without a new message",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const thread = await db.ops.findOrCreateThread(undefined, {
      name: "Recovered Thread",
      participants: ["user-1"],
      status: "active",
      mode: "immediate",
    });
    const queued = await db.ops.addToQueue(thread.id as string, {
      eventType: "NEW_MESSAGE",
      payload: { content: "resume me" },
      priority: 0,
    });
    let processed = 0;
    const processor: EventProcessor<unknown, ProcessorDeps> = {
      shouldProcess: () => true,
      process: () => {
        processed += 1;
        return { producedEvents: [] };
      },
    };

    const result = await recoverStuckThreads(db, {
      processors: { NEW_MESSAGE: [processor] },
    });

    const item = await db.ops.getQueueItemById(String(queued.id));
    assertEquals(result.checked, 1);
    assertEquals(result.started, 1);
    assertEquals(result.threadIds, [thread.id]);
    assertEquals(processed, 1);
    assertEquals(item?.status, "completed");
  },
});
