import { assertEquals } from "@std/assert";
import { createDatabase } from "@/database/index.ts";
import { buildProcessingContext } from "@/runtime/agent-llm-input/index.ts";
import type { LongTermMemoryRecord } from "@/runtime/memory/index.ts";
import type { ChatContext } from "@/types/index.ts";

Deno.test("LLM history after long-term memory excludes the checkpoint boundary", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const suffix = crypto.randomUUID();
  const namespace = `llm-history-boundary-${suffix}`;
  const thread = await db.ops.mutate.threads.create(undefined, {
    namespace,
    name: "LLM history boundary",
    participants: ["user", "agent"],
    status: "active",
    mode: "immediate",
  });
  const threadId = String(thread.id);
  const boundary = await db.ops.mutate.messages.create({
    id: `boundary-${suffix}`,
    threadId,
    senderId: "agent",
    senderType: "agent",
    content: "checkpoint boundary",
  }, namespace);
  const userMessage = await db.ops.mutate.messages.create({
    id: `user-${suffix}`,
    threadId,
    senderId: "user",
    senderType: "user",
    content: "after checkpoint",
  }, namespace);
  const agentMessage = await db.ops.mutate.messages.create({
    id: `agent-${suffix}`,
    threadId,
    senderId: "agent",
    senderType: "agent",
    content: "response",
  }, namespace);
  const timestamps = [
    [boundary.id, "2026-07-31T18:28:45.297017Z"],
    [userMessage.id, "2026-07-31T18:28:45.297031Z"],
    [agentMessage.id, "2026-07-31T18:28:45.297049Z"],
  ];
  for (const [messageId, createdAt] of timestamps) {
    await db.query(
      `UPDATE "nodes"
       SET "created_at" = $1::timestamptz
       WHERE "id" = $2`,
      [createdAt, messageId],
    );
  }

  const longTermMemory = {
    node: {
      id: `memory-${suffix}`,
      namespace,
      type: "long_term_memory",
      name: "memory",
      content: "consolidated memory",
      embedding: null,
      data: {},
      sourceType: "thread",
      sourceId: threadId,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    data: {
      schemaVersion: "2",
      strategy: "checkpointed_graph",
      status: "ready",
      threadId,
      readMemorySpaceIds: ["space"],
      writeMemorySpaceIds: ["space"],
      defaultWriteMemorySpaceId: "space",
      sequence: 1,
      agentId: "agent",
      sourceStartMessageId: boundary.id,
      sourceEndMessageId: boundary.id,
    },
  } as LongTermMemoryRecord;
  const context = {
    namespace,
    agents: [{ id: "agent", name: "Agent", role: "assistant" }],
  } as ChatContext;

  const processingContext = await buildProcessingContext(
    db.ops,
    threadId,
    context,
    "agent",
    undefined,
    "afterReadyLongTermMemory",
    undefined,
    longTermMemory,
    thread,
  );

  assertEquals(
    processingContext.chatHistory.map((message) => message.content),
    ["after checkpoint", "response"],
  );
});
