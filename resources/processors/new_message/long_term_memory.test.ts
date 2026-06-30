import {
  assertEquals,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import { createDatabase } from "@/database/index.ts";
import type { Event, ProcessorDeps } from "@/types/index.ts";
import { messageProcessor } from "./index.ts";

Deno.test("new_message injects ready memory and keeps only messages after its boundary", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const suffix = crypto.randomUUID();
  const namespace = `new-message-memory-${suffix}`;
  const thread = await db.ops.mutate.threads.create(undefined, {
    namespace,
    name: "Memory read path",
    participants: ["user", "assistant"],
    status: "active",
    mode: "immediate",
  });
  const threadId = String(thread.id);
  await db.ops.mutate.messages.create({
    id: `old-user-${suffix}`,
    threadId,
    senderId: "user",
    senderType: "user",
    content: "OLD_HISTORY_SENTINEL",
  }, namespace);
  const boundary = await db.ops.mutate.messages.create({
    id: `old-agent-${suffix}`,
    threadId,
    senderId: "assistant",
    senderType: "agent",
    content: "OLD_AGENT_SENTINEL",
  }, namespace);
  const current = await db.ops.mutate.messages.create({
    id: `current-user-${suffix}`,
    threadId,
    senderId: "user",
    senderType: "user",
    content: "CURRENT_HISTORY_SENTINEL",
  }, namespace);
  await db.ops.mutate.graph.createNode({
    namespace,
    type: "long_term_memory",
    name: `thread:${threadId}:memory:1`,
    content: "READY_MEMORY_SENTINEL",
    data: {
      schemaVersion: "1",
      strategy: "checkpointed_graph",
      status: "ready",
      threadId,
      memorySpaceId: `space-${suffix}`,
      sequence: 1,
      agentId: "assistant",
      sourceStartMessageId: `old-user-${suffix}`,
      sourceEndMessageId: boundary.id,
    },
    sourceType: "thread",
    sourceId: threadId,
  }, { threadId, namespace });
  await db.ops.mutate.graph.createNode({
    namespace,
    type: "long_term_memory",
    name: `thread:${threadId}:memory:2`,
    content: "PENDING_MEMORY_SENTINEL",
    data: {
      schemaVersion: "1",
      strategy: "checkpointed_graph",
      status: "pending",
      threadId,
      memorySpaceId: `space-${suffix}`,
      sequence: 2,
      agentId: "assistant",
      sourceStartMessageId: current.id,
      sourceEndMessageId: current.id,
    },
    sourceType: "thread",
    sourceId: threadId,
  }, { threadId, namespace });

  const event = {
    id: `event-${suffix}`,
    type: "message.created",
    threadId,
    subjectType: "message",
    subjectId: current.id,
    payload: {
      content: current.content,
      sender: { id: "user", name: "User", type: "user" },
    },
    metadata: {
      targetId: "assistant",
      targetQueue: [],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
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
          triggerEstimatedTokens: 20_000,
          maxContentEstimatedTokens: 12_000,
          retrievalLimit: 20,
        },
      }],
      agents: [{
        id: "assistant",
        name: "Assistant",
        role: "assistant",
        instructions: "Help the user.",
        llmOptions: {
          provider: "openai",
          model: "mock",
          estimateCost: false,
        },
      }],
      tools: [],
    },
    emitToStream: () => {},
  } as ProcessorDeps;

  const result = await messageProcessor.process(event, deps);
  assertEquals(result, { producedEvents: [] });

  const attempts = await db.ops.unsafeGraph.getNodesByNamespace(
    namespace,
    "llm_attempt",
  );
  assertEquals(attempts.length, 1);
  const attemptData = attempts[0].data as Record<string, unknown>;
  const serializedMessages = JSON.stringify(attemptData.messages);
  assertStringIncludes(serializedMessages, "READY_MEMORY_SENTINEL");
  assertStringIncludes(serializedMessages, "CURRENT_HISTORY_SENTINEL");
  assertNotMatch(serializedMessages, /OLD_HISTORY_SENTINEL/);
  assertNotMatch(serializedMessages, /OLD_AGENT_SENTINEL/);
  assertNotMatch(serializedMessages, /PENDING_MEMORY_SENTINEL/);
});
