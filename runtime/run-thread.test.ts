import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createCopilotz } from "@/index.ts";

Deno.test("runThread keeps done pending for same-thread work queued behind an active worker", async () => {
  const copilotz = await createCopilotz({
    agents: [{
      id: "test-agent",
      name: "Test Agent",
      role: "Test Agent",
      instructions: "Handle the test message.",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    }],
    processors: [{
      eventType: "NEW_MESSAGE",
      shouldProcess: () => true,
      process: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { producedEvents: [] };
      },
    }],
    dbConfig: {
      url: ":memory:",
      threadLeaseMs: 1_000,
      threadLeaseHeartbeatMs: 100,
    },
  });

  try {
    const baseMessage = {
      sender: { type: "user" as const, externalId: "user-1", name: "User 1" },
      thread: { externalId: "thread-1" },
    };

    const first = await copilotz.run({
      ...baseMessage,
      content: "first",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await copilotz.run({
      ...baseMessage,
      content: "second",
    });

    let secondDoneResolved = false;
    second.done.then(() => {
      secondDoneResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const queuedItem = await copilotz.ops.getQueueItemById(second.queueId);
    assertEquals(queuedItem?.status, "pending");
    assertEquals(secondDoneResolved, false);

    await second.done;

    const completedItem = await copilotz.ops.getQueueItemById(second.queueId);
    assertEquals(completedItem?.status, "completed");

    await first.done;
  } finally {
    await copilotz.shutdown();
  }
});
