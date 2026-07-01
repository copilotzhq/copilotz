import { assertEquals } from "@std/assert";
import { createDatabase } from "@/database/index.ts";
import type { Message } from "@/types/index.ts";
import {
  findMemorySpace,
  isLongTermMemoryAccessible,
  type LongTermMemoryData,
  type LongTermMemoryRecord,
  projectMessageForSharedMemory,
  resolveThreadMemorySpaces,
  selectLongTermMemoryRange,
  sliceMessagesAfterLongTermMemory,
} from "./long-term.ts";
import { estimateTextTokens } from "@/runtime/tokens/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

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
  const projectedLast = estimateTextTokens(projectMessageForSharedMemory(last));
  const range = await selectLongTermMemoryRange({
    db,
    threadId,
    triggerMessageId: last.id,
    previous: null,
    triggerEstimatedTokens: projectedLast + 1,
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
    triggerEstimatedTokens: 1,
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

Deno.test("long-term-memory range retains a complete recent-message tail", async () => {
  const { db, namespace, threadId, messages } = await createThreadMessages();
  const selected = messages.slice(-3);
  const triggerEstimatedTokens = selected.reduce(
    (total, message) =>
      total + estimateTextTokens(projectMessageForSharedMemory(message)),
    0,
  );
  const retainedEstimatedTokens = estimateTextTokens(
    projectMessageForSharedMemory(messages.at(-1)!),
  );
  const range = await selectLongTermMemoryRange({
    db,
    threadId,
    triggerMessageId: messages.at(-1)!.id,
    previous: null,
    triggerEstimatedTokens,
    retainRecentEstimatedTokens: retainedEstimatedTokens,
    pageSize: 2,
  });

  assertEquals(
    range?.messages.map((message) => message.id),
    selected.slice(0, -1).map((message) => message.id),
  );
  assertEquals(range?.sourceEndMessageId, selected.at(-2)?.id);
  assertEquals(range?.retainedMessageCount, 1);
  assertEquals(range?.retainedEstimatedTokens, retainedEstimatedTokens);

  const ready = {
    node: {
      id: "memory-retained-tail",
      namespace,
      type: "long_term_memory",
      name: "memory-retained-tail",
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
      sourceStartMessageId: range!.sourceStartMessageId,
      sourceEndMessageId: range!.sourceEndMessageId,
    },
  } as LongTermMemoryRecord;
  assertEquals(
    sliceMessagesAfterLongTermMemory(messages, ready).map((message) =>
      message.id
    ),
    [messages.at(-1)!.id],
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

Deno.test("shared-memory projection counts agent tool calls and arguments", () => {
  const projected = projectMessageForSharedMemory({
    threadId: "thread",
    senderId: "agent",
    senderType: "agent",
    content: "Checking.",
    toolCalls: [{
      id: "call",
      tool: { id: "sandbox" },
      args: { command: "deno test" },
    }],
  } as Message);

  assertEquals(projected.includes("[Tool call sandbox]"), true);
  assertEquals(projected.includes("deno test"), true);
});

Deno.test("thread memory spaces resolve one default writer and additional readable spaces", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const suffix = crypto.randomUUID();
  const namespace = `memory-space-access-${suffix}`;
  const thread = await db.ops.mutate.threads.create(undefined, {
    namespace,
    name: "Memory space access",
    participants: ["user", "agent"],
    status: "active",
    mode: "immediate",
  });
  const threadId = String(thread.id);
  const writable = await db.ops.mutate.graph.createNode({
    namespace,
    type: "memory_space",
    name: "Thread memory",
    data: { scopeType: "thread", scopeId: threadId },
    sourceType: "thread",
    sourceId: threadId,
  }, { threadId, namespace });
  const readable = await db.ops.mutate.graph.createNode({
    namespace,
    type: "memory_space",
    name: "Global memory",
    data: { scopeType: "global", scopeId: namespace },
    sourceType: "global",
    sourceId: namespace,
  }, { threadId, namespace });
  await db.ops.mutate.graph.mutateMany({
    createEdges: [{
      sourceNodeId: threadId,
      targetNodeId: String(writable.id),
      type: GRAPH_EDGE.USES_MEMORY_SPACE,
      data: { access: "read_write", defaultWrite: true },
    }, {
      sourceNodeId: threadId,
      targetNodeId: String(readable.id),
      type: GRAPH_EDGE.USES_MEMORY_SPACE,
      data: { access: "read" },
    }],
  }, { threadId, namespace });

  const spaces = await resolveThreadMemorySpaces(db, threadId, namespace);
  assertEquals(
    spaces.map((space) => ({
      id: space.node.id,
      access: space.access,
      defaultWrite: space.defaultWrite,
    })),
    [{
      id: writable.id,
      access: "read_write",
      defaultWrite: true,
    }, {
      id: readable.id,
      access: "read",
      defaultWrite: false,
    }],
  );
  assertEquals(
    (await findMemorySpace(db, threadId, namespace))?.id,
    writable.id,
  );
  const checkpointData = {
    schemaVersion: "2",
    strategy: "checkpointed_graph",
    status: "ready",
    threadId,
    readMemorySpaceIds: [String(writable.id), String(readable.id)],
    writeMemorySpaceIds: [String(writable.id)],
    defaultWriteMemorySpaceId: String(writable.id),
    sequence: 1,
    agentId: "agent",
    sourceStartMessageId: "start",
    sourceEndMessageId: "end",
  } satisfies LongTermMemoryData;
  assertEquals(isLongTermMemoryAccessible(checkpointData, spaces), true);
  assertEquals(
    isLongTermMemoryAccessible({
      ...checkpointData,
      readMemorySpaceIds: [...checkpointData.readMemorySpaceIds, "revoked"],
    }, spaces),
    false,
  );

  const secondThread = await db.ops.mutate.threads.create(undefined, {
    namespace,
    name: "Second memory-space consumer",
    participants: ["user", "agent"],
    status: "active",
    mode: "immediate",
  });
  const secondThreadId = String(secondThread.id);
  await db.ops.mutate.graph.createEdge({
    sourceNodeId: secondThreadId,
    targetNodeId: String(readable.id),
    type: GRAPH_EDGE.USES_MEMORY_SPACE,
    data: { access: "read_write", defaultWrite: true },
  }, { threadId: secondThreadId, namespace });
  const secondThreadSpaces = await resolveThreadMemorySpaces(
    db,
    secondThreadId,
    namespace,
  );
  assertEquals(secondThreadSpaces.map((space) => space.node.id), [
    readable.id,
  ]);
});
