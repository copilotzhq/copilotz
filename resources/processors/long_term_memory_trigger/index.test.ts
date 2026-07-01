import { assertEquals, assertExists } from "@std/assert";
import { createDatabase } from "@/database/index.ts";
import type { Event, ProcessorDeps } from "@/types/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";
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
  const readableSpace = await db.ops.mutate.graph.createNode({
    namespace,
    type: "memory_space",
    name: "Global read-only memory",
    data: { scopeType: "global", scopeId: namespace },
    sourceType: "global",
    sourceId: namespace,
  }, { threadId, namespace });
  await db.ops.mutate.graph.createEdge({
    sourceNodeId: threadId,
    targetNodeId: String(readableSpace.id),
    type: GRAPH_EDGE.USES_MEMORY_SPACE,
    data: { access: "read" },
  }, { threadId, namespace });

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
          triggerEstimatedTokens: 1,
          maxContentEstimatedTokens: 2_500,
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
  assertEquals(
    (checkpoints[0].data as Record<string, unknown>).agentId,
    "agent",
  );
  assertEquals(
    (checkpoints[0].data as Record<string, unknown>).schemaVersion,
    "2",
  );

  const spaces = await db.ops.unsafeGraph.getNodesByNamespace(
    namespace,
    "memory_space",
  );
  assertEquals(spaces.length, 2);
  const writableSpace = spaces.find((space) =>
    (space.data as Record<string, unknown>).scopeType === "thread"
  );
  assertExists(writableSpace);
  assertEquals(
    (checkpoints[0].data as Record<string, unknown>).readMemorySpaceIds,
    [writableSpace.id, readableSpace.id],
  );
  assertEquals(
    (checkpoints[0].data as Record<string, unknown>).writeMemorySpaceIds,
    [writableSpace.id],
  );

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

Deno.test("long-term-memory trigger keeps agent checkpoints independent in one thread space", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const suffix = crypto.randomUUID();
  const namespace = `long-term-trigger-agents-${suffix}`;
  const thread = await db.ops.mutate.threads.create(undefined, {
    namespace,
    name: "Agent-scoped long-term memory",
    participants: ["user", "agent-a", "agent-b"],
    status: "active",
    mode: "immediate",
  });
  const threadId = String(thread.id);
  await db.ops.mutate.messages.create({
    id: `user-${suffix}`,
    threadId,
    senderId: "user",
    senderType: "user",
    content: "Shared history for both agents.",
  }, namespace);

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
          triggerEstimatedTokens: 1,
          maxContentEstimatedTokens: 2_500,
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

  const trigger = async (agentId: string) => {
    const message = await db.ops.mutate.messages.create({
      id: `${agentId}-${suffix}`,
      threadId,
      senderId: agentId,
      senderType: "agent",
      content: `${agentId} response`,
    }, namespace);
    const event = {
      id: `event-${agentId}-${suffix}`,
      type: "message.created",
      threadId,
      subjectType: "message",
      subjectId: message.id,
      payload: {
        content: message.content,
        senderId: agentId,
        senderType: "agent",
      },
    } as unknown as Event;
    return await process(event, deps);
  };

  const first = await trigger("agent-a");
  const second = await trigger("agent-b");
  assertEquals(first?.backgroundThreadIds?.length, 1);
  assertEquals(second?.backgroundThreadIds?.length, 1);
  assertEquals(
    first?.backgroundThreadIds?.[0] === second?.backgroundThreadIds?.[0],
    false,
  );

  const checkpoints = await db.ops.unsafeGraph.getNodesByNamespace(
    namespace,
    "long_term_memory",
  );
  assertEquals(checkpoints.length, 2);
  assertEquals(
    checkpoints.map((checkpoint) => {
      const data = checkpoint.data as Record<string, unknown>;
      return [data.agentId, data.sequence];
    }).sort(),
    [["agent-a", 1], ["agent-b", 1]],
  );

  const spaces = await db.ops.unsafeGraph.getNodesByNamespace(
    namespace,
    "memory_space",
  );
  assertEquals(spaces.length, 1);
});
