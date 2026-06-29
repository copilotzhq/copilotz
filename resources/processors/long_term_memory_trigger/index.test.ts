import { assertEquals, assertExists } from "@std/assert";
import { createDatabase } from "@/database/index.ts";
import type { Event, ProcessorDeps } from "@/types/index.ts";
import { process, shouldProcess } from "./index.ts";

Deno.test("long-term-memory trigger reserves one pending checkpoint and outbox event", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const suffix = crypto.randomUUID();
  const namespace = `long-term-trigger-${suffix}`;
  const thread = await db.ops.mutate.threads.create(undefined, {
    namespace,
    name: "Long-term trigger",
    participants: ["user", "agent"],
    status: "active",
    mode: "immediate",
  });
  const threadId = String(thread.id);
  await db.ops.mutate.messages.create({
    id: `user-${suffix}`,
    threadId,
    senderId: "user",
    senderType: "user",
    content: "A".repeat(50),
  }, namespace);
  const agentMessage = await db.ops.mutate.messages.create({
    id: `agent-${suffix}`,
    threadId,
    senderId: "agent",
    senderType: "agent",
    content: "B".repeat(50),
  }, namespace);

  const event = {
    id: `event-${suffix}`,
    type: "message.created",
    threadId,
    subjectType: "message",
    subjectId: agentMessage.id,
    payload: {
      content: agentMessage.content,
      senderId: "agent",
      senderType: "agent",
    },
  } as unknown as Event;
  const deps = {
    db,
    thread,
    context: {
      namespace,
      memory: [{
        name: "long_term",
        kind: "long_term",
        enabled: true,
        config: {
          triggerChars: 1,
          maxContentChars: 10_000,
          retrievalLimit: 5,
        },
      }],
      embeddingConfig: {
        provider: "openai",
        model: "mock",
      },
    },
    emitToStream: () => {},
  } as ProcessorDeps;

  assertEquals(await shouldProcess(event, deps), true);
  const triggerResult = await process(event, deps);
  assertEquals(triggerResult?.backgroundThreadIds?.length, 1);
  assertEquals(await process(event, deps), undefined);
  const backgroundThreadId = triggerResult!.backgroundThreadIds![0];

  const checkpoints = await db.ops.unsafeGraph.getNodesByNamespace(
    namespace,
    "long_term_memory",
  );
  assertEquals(checkpoints.length, 1);
  assertEquals(
    (checkpoints[0].data as Record<string, unknown>).status,
    "pending",
  );

  const spaces = await db.ops.unsafeGraph.getNodesByNamespace(
    namespace,
    "memory_space",
  );
  assertEquals(spaces.length, 1);
  assertExists(spaces[0]);

  const lifecycle = await db.query<{
    eventType: string;
    status: string;
    priority: number;
  }>(
    `SELECT "eventType", "status", "priority"
     FROM "events"
     WHERE "threadId" = $1
       AND "eventType" = 'long_term_memory.created'`,
    [backgroundThreadId],
  );
  assertEquals(lifecycle.rows, [{
    eventType: "long_term_memory.created",
    status: "pending",
    priority: 0,
  }]);
});
