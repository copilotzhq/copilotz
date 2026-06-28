import { assertEquals } from "@std/assert";
import { createDatabase } from "@/database/index.ts";
import type { Message } from "@/types/index.ts";
import {
  type LongTermMemoryRecord,
  projectMessageForSharedMemory,
  selectLongTermMemoryRange,
  sliceMessagesAfterLongTermMemory,
} from "./long-term.ts";

async function createThreadMessages() {
  const db = await createDatabase({ url: ":memory:" });
  const suffix = crypto.randomUUID();
  const namespace = `long-term-range-${suffix}`;
  const thread = await db.ops.mutate.threads.create(undefined, {
    namespace,
    name: "Long-term memory range",
    participants: ["user", "agent"],
    status: "active",
    mode: "immediate",
  });
  const threadId = String(thread.id);
  const messages: Message[] = [];
  for (let index = 1; index <= 5; index++) {
    messages.push(
      await db.ops.mutate.messages.create({
        id: `message-${index}-${suffix}`,
        threadId,
        senderId: index % 2 === 0 ? "agent" : "user",
        senderType: index % 2 === 0 ? "agent" : "user",
        content: String(index).repeat(40),
      }, namespace),
    );
  }
  return { db, namespace, threadId, messages };
}

Deno.test("first long-term-memory range scans only the recent threshold suffix", async () => {
  const { db, threadId, messages } = await createThreadMessages();
  const last = messages.at(-1)!;
  const projectedLast = projectMessageForSharedMemory(last).length;
  const range = await selectLongTermMemoryRange({
    db,
    threadId,
    triggerMessageId: last.id,
    previous: null,
    triggerChars: projectedLast + 1,
    pageSize: 2,
  });

  assertEquals(range?.sourceStartMessageId, messages.at(-2)?.id);
  assertEquals(range?.sourceEndMessageId, last.id);
  assertEquals(range?.messages.map((message) => message.id), [
    messages.at(-2)?.id,
    last.id,
  ]);
});

Deno.test("later long-term-memory ranges preserve the complete prior-boundary delta", async () => {
  const { db, namespace, threadId, messages } = await createThreadMessages();
  const previous = {
    node: {
      id: "memory-1",
      namespace,
      type: "long_term_memory",
      name: "memory-1",
      content: "ready",
      embedding: null,
      data: {},
      sourceType: "thread",
      sourceId: threadId,
    },
    data: {
      schemaVersion: "1",
      strategy: "checkpointed_graph",
      status: "ready",
      threadId,
      memorySpaceId: "space-1",
      sequence: 1,
      agentId: "agent",
      sourceStartMessageId: messages[0].id,
      sourceEndMessageId: messages[1].id,
    },
  } as LongTermMemoryRecord;
  const range = await selectLongTermMemoryRange({
    db,
    threadId,
    triggerMessageId: messages[4].id,
    previous,
    triggerChars: 1,
    pageSize: 2,
  });

  assertEquals(range?.messages.map((message) => message.id), [
    messages[2].id,
    messages[3].id,
    messages[4].id,
  ]);
  assertEquals(
    sliceMessagesAfterLongTermMemory(messages, previous).map((message) =>
      message.id
    ),
    [messages[2].id, messages[3].id, messages[4].id],
  );
});

Deno.test("shared-memory projection hides requester-only tool output", () => {
  const message = {
    id: "tool-message",
    threadId: "thread",
    senderId: "agent",
    senderType: "tool",
    content: "secret",
    metadata: {
      toolCalls: [{
        id: "call",
        tool: { id: "private_tool" },
        output: { secret: true },
        visibility: "requester_only",
      }],
    },
  } satisfies Message;

  assertEquals(projectMessageForSharedMemory(message), "");
});
