import {
  assertAlmostEquals,
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import { createDatabase } from "@/database/index.ts";
import type { Event, ProcessorDeps } from "@/types/index.ts";
import type { ProviderFactory } from "@/runtime/llm/types.ts";
import type { EmbeddingProviderFactory } from "@/runtime/embeddings/types.ts";
import {
  averageNormalizedEmbeddings,
  chunkLinesForEmbedding,
  process,
} from "./index.ts";

Deno.test("embedding chunks preserve message lines until a line is oversized", () => {
  assertEquals(
    chunkLinesForEmbedding(["first", "second", "third"], 12),
    [
      { text: "first\nsecond", characterCount: 12 },
      { text: "third", characterCount: 5 },
    ],
  );
  assertEquals(
    chunkLinesForEmbedding(["123456789"], 4),
    [
      { text: "1234", characterCount: 4 },
      { text: "5678", characterCount: 4 },
      { text: "9", characterCount: 1 },
    ],
  );
});

Deno.test("embedding aggregation uses character-weighted normalized vectors", () => {
  const result = averageNormalizedEmbeddings(
    [[3, 0], [0, 4]],
    [1, 3],
  );
  assertAlmostEquals(result[0], 1 / Math.sqrt(10));
  assertAlmostEquals(result[1], 3 / Math.sqrt(10));
});

function mockRegistries(answer: string) {
  const chatRequests: Array<Record<string, unknown>> = [];
  const llmFactory: ProviderFactory = () => ({
    endpoint: "https://mock.local/chat",
    headers: () => ({}),
    body: (messages, config) => ({ messages, config }),
    extractContent: (data) =>
      typeof data?.content === "string"
        ? [{ text: data.content, isReasoning: false }]
        : null,
    extractFinishReason: (data) => data?.done ? "stop" : null,
  });
  const embeddingFactory: EmbeddingProviderFactory = () => ({
    endpoint: "https://mock.local/embeddings",
    headers: () => ({}),
    body: (texts) => ({ texts }),
    extractEmbeddings: (data) =>
      (data as { embeddings: number[][] }).embeddings,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url.endsWith("/embeddings")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        texts?: string[];
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            embeddings: (body.texts ?? []).map(() =>
              Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0)
            ),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }
    chatRequests.push(
      JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    );
    const event = JSON.stringify({ content: answer, done: true });
    return Promise.resolve(
      new Response(`data: ${event}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  return {
    llmProviders: { openai: llmFactory },
    embeddingProviders: { openai: embeddingFactory },
    chatRequests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function createPendingCheckpoint() {
  const db = await createDatabase({ url: ":memory:" });
  const suffix = crypto.randomUUID();
  const namespace = `long-term-processor-${suffix}`;
  const thread = await db.ops.mutate.threads.create(undefined, {
    namespace,
    name: "Long-term processor",
    participants: ["user", "agent"],
    status: "active",
    mode: "immediate",
  });
  const threadId = String(thread.id);
  const first = await db.ops.mutate.messages.create({
    id: `user-${suffix}`,
    threadId,
    senderId: "user",
    senderType: "user",
    content: "We decided to use a lifecycle event.",
  }, namespace);
  const last = await db.ops.mutate.messages.create({
    id: `agent-${suffix}`,
    threadId,
    senderId: "agent",
    senderType: "agent",
    content: "I will implement the lifecycle processor.",
  }, namespace);
  const memorySpace = await db.ops.mutate.graph.createNode({
    namespace,
    type: "memory_space",
    name: `thread:${threadId}`,
    data: { kind: "thread", ownerNodeId: threadId, threadId },
    sourceType: "thread",
    sourceId: threadId,
  }, { threadId, namespace });
  const checkpoint = await db.ops.mutate.graph.createNode({
    namespace,
    type: "long_term_memory",
    name: `thread:${threadId}:memory:1`,
    content: null,
    embedding: null,
    data: {
      schemaVersion: "1",
      strategy: "checkpointed_graph",
      status: "pending",
      threadId,
      memorySpaceId: String(memorySpace.id),
      sequence: 1,
      agentId: "agent",
      sourceStartMessageId: first.id,
      sourceEndMessageId: last.id,
    },
    sourceType: "thread",
    sourceId: threadId,
  }, { threadId, namespace });
  return { db, namespace, thread, threadId, checkpoint, first, last };
}

function createDeps(
  fixture: Awaited<ReturnType<typeof createPendingCheckpoint>>,
  registries: ReturnType<typeof mockRegistries>,
): ProcessorDeps {
  return {
    db: fixture.db,
    thread: fixture.thread,
    context: {
      namespace: fixture.namespace,
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
      agents: [{
        id: "agent",
        name: "Agent",
        role: "assistant",
        llmOptions: {
          provider: "openai",
          model: "mock",
          estimateCost: false,
        },
      }],
      embeddingConfig: {
        provider: "openai",
        model: "mock",
      },
      llmProviders: registries.llmProviders,
      embeddingProviders: registries.embeddingProviders,
      usage: { enabled: false },
    },
    emitToStream: () => {},
  };
}

Deno.test("long-term-memory processor finalizes the reserved node atomically", async () => {
  const fixture = await createPendingCheckpoint();
  const proposal = {
    workState: "The lifecycle-based memory processor is being implemented.",
    items: [{
      localId: "decision-1",
      kind: "decision",
      name: "Lifecycle trigger",
      content:
        "Long-term memory consolidation is triggered by long_term_memory.created.",
      confidence: 0.98,
      sourceMessageIds: [fixture.last.id],
    }],
    relations: [],
  };
  // The processor uses JSON output mode — answer is a raw JSON object.
  const answer = JSON.stringify(proposal);
  const registries = mockRegistries(answer);
  try {
    const event = {
      id: `event-${crypto.randomUUID()}`,
      type: "long_term_memory.created",
      threadId: fixture.threadId,
      subjectType: "long_term_memory",
      subjectId: fixture.checkpoint.id,
      payload: fixture.checkpoint,
    } as unknown as Event;
    const deps = createDeps(fixture, registries);
    const result = await process(event, deps);
    assertEquals(result, { producedEvents: [] });

    const checkpoint = await fixture.db.ops.unsafeGraph.getNodeById(
      String(fixture.checkpoint.id),
    );
    assertEquals(
      (checkpoint?.data as Record<string, unknown>).status,
      "ready",
    );
    assertStringIncludes(checkpoint?.content ?? "", "Lifecycle trigger");
    const items = await fixture.db.ops.unsafeGraph.getNodesByNamespace(
      fixture.namespace,
      "memory_item",
    );
    assertEquals(items.length, 1);
    assertEquals(items[0].content, proposal.items[0].content);
    assertEquals(
      (registries.chatRequests[0]?.config as Record<string, unknown>).model,
      "mock",
    );

    await process(event, deps);
    const itemsAfterRetry = await fixture.db.ops.unsafeGraph
      .getNodesByNamespace(
        fixture.namespace,
        "memory_item",
      );
    assertEquals(itemsAfterRetry.length, 1);
    assertEquals(registries.chatRequests.length, 1);
  } finally {
    registries.restore();
  }
});

Deno.test("long-term-memory processor terminalizes an invalid consolidation", async () => {
  const fixture = await createPendingCheckpoint();
  const registries = mockRegistries("not-json");
  try {
    const event = {
      id: `event-${crypto.randomUUID()}`,
      type: "long_term_memory.created",
      threadId: fixture.threadId,
      subjectType: "long_term_memory",
      subjectId: fixture.checkpoint.id,
      payload: fixture.checkpoint,
    } as unknown as Event;
    await process(event, createDeps(fixture, registries));

    const checkpoint = await fixture.db.ops.unsafeGraph.getNodeById(
      String(fixture.checkpoint.id),
    );
    assertEquals(
      (checkpoint?.data as Record<string, unknown>).status,
      "failed",
    );
  } finally {
    registries.restore();
  }
});
