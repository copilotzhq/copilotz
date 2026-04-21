import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createCopilotz } from "@/index.ts";
import { getRuntimeThreadMetadata } from "@/runtime/thread-metadata.ts";

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

Deno.test("runThread normalizes blank thread participants and keeps a stable user identity", async () => {
  const copilotz = await createCopilotz({
    agents: [{
      id: "reviewer",
      name: "reviewer",
      role: "assistant",
      instructions: "Handle the test message.",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    }],
    processors: [{
      eventType: "NEW_MESSAGE",
      shouldProcess: () => true,
      process: async () => ({ producedEvents: [] }),
    }],
    dbConfig: { url: ":memory:" },
  });

  try {
    const handle = await copilotz.run({
      content: "hello",
      sender: { type: "user", name: "User" },
      thread: {
        externalId: "thread-identity-normalization",
        participants: ["", "reviewer"],
      },
    });

    await handle.done;

    const thread = await copilotz.ops.getThreadByExternalId(
      "thread-identity-normalization",
    );

    assertEquals(thread?.participants, ["User", "reviewer"]);

    const runtimeMetadata = getRuntimeThreadMetadata(thread?.metadata);
    assertEquals(runtimeMetadata.userExternalId, "User");
  } finally {
    await copilotz.shutdown();
  }
});
