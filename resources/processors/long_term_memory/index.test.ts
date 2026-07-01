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
  extractVisibleMemoryItemIds,
  fuseMemoryCandidateRanks,
  parseConsolidationProposal,
  process,
  renderLongTermMemory,
} from "./index.ts";

Deno.test("embedding chunks preserve message lines until a line is oversized", () => {
  assertEquals(
    chunkLinesForEmbedding(["first", "second", "third"], 3),
    [
      { text: "first\nsecond", characterCount: 12 },
      { text: "third", characterCount: 5 },
    ],
  );
  assertEquals(
    chunkLinesForEmbedding(["123456789"], 2),
    [
      { text: "12345678", characterCount: 8 },
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

Deno.test("checkpoint rendering omits oversized blocks instead of slicing them", () => {
  const oversized = "OVERSIZED_MEMORY_BLOCK_".repeat(20);
  const rendered = renderLongTermMemory({
    proposal: {
      workState: oversized,
      items: [],
      relations: [],
    },
    newItemNodes: new Map(),
    olderItems: [],
    olderRelations: [],
    maxContentEstimatedTokens: 30,
  });

  assertEquals(rendered.length <= 120, true);
  assertEquals(rendered.includes("OVERSIZED_MEMORY_BLOCK_"), false);
});

Deno.test("checkpoint item IDs are extractable only when fully rendered", () => {
  assertEquals(
    extractVisibleMemoryItemIds(
      "- [id:item-1] [fact] One\n- [id:item-2] [task] Two\n[id:item-1]",
    ),
    ["item-1", "item-2"],
  );
  assertEquals(extractVisibleMemoryItemIds("- [id:truncated"), []);
});

Deno.test("memory candidate fusion preserves strong matches and rewards consensus", () => {
  assertEquals(
    fuseMemoryCandidateRanks([
      [{ id: "rare", similarity: 0.99 }, {
        id: "consensus",
        similarity: 0.7,
      }],
      [{ id: "consensus", similarity: 0.7 }],
    ], 2),
    ["rare", "consensus"],
  );
});

Deno.test("consolidation may supersede only a visible checkpoint item", () => {
  const proposal = JSON.stringify({
    workState: "Updating a prior decision.",
    items: [{
      localId: "new-decision",
      kind: "decision",
      name: "Updated decision",
      content: "Use the new approach.",
      sourceMessageIds: ["message-1"],
      supersedesItemId: "visible-item",
    }, {
      localId: "other-decision",
      kind: "decision",
      name: "Other decision",
      content: "Do not supersede an unseen item.",
      sourceMessageIds: ["message-1"],
      supersedesItemId: "hidden-item",
    }],
    relations: [],
  });
  const parsed = parseConsolidationProposal(
    proposal,
    new Set(["message-1"]),
    new Set(["visible-item"]),
  );

  assertEquals(parsed.items[0].supersedesItemId, "visible-item");
  assertEquals(parsed.items[1].supersedesItemId, undefined);
});

function mockRegistries(answer: string) {
  const chatRequests: Array<Record<string, unknown>> = [];
  const embeddingRequests: string[][] = [];
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
      embeddingRequests.push(body.texts ?? []);
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
    embeddingRequests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function createPendingCheckpoint(
  options: { withPrevious?: boolean; withForeignItem?: boolean } = {},
) {
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
  let previousItemId: string | null = null;
  let foreignItemId: string | null = null;
  if (options.withPrevious) {
    const previousCheckpointId = `previous-checkpoint-${suffix}`;
    previousItemId = `previous-item-${suffix}`;
    await db.ops.mutate.graph.createNode({
      id: previousItemId,
      namespace,
      type: "memory_item",
      name: "Previous decision",
      content: "Use the previous approach.",
      embedding: Array.from(
        { length: 1536 },
        (_, index) => index === 0 ? 1 : 0,
      ),
      data: {
        memorySpaceId: String(memorySpace.id),
        checkpointId: previousCheckpointId,
        createdByAgentId: "agent",
        kind: "decision",
        name: "Previous decision",
        content: "Use the previous approach.",
        sourceMessageIds: [first.id],
      },
      sourceType: "long_term_memory",
      sourceId: previousCheckpointId,
    }, { threadId, namespace });
    await db.ops.mutate.graph.createNode({
      id: previousCheckpointId,
      namespace,
      type: "long_term_memory",
      name: `thread:${threadId}:memory:1`,
      content:
        `## LONG-TERM CONVERSATION MEMORY\n\n### Relevant memory\n- [id:${previousItemId}] [decision] Previous decision: Use the previous approach.`,
      embedding: null,
      data: {
        schemaVersion: "1",
        strategy: "checkpointed_graph",
        status: "ready",
        threadId,
        memorySpaceId: String(memorySpace.id),
        sequence: 1,
        agentId: "agent",
        sourceStartMessageId: first.id,
        sourceEndMessageId: first.id,
        metadata: { visibleItemIds: [previousItemId] },
      },
      sourceType: "thread",
      sourceId: threadId,
    }, { threadId, namespace });
  }
  if (options.withForeignItem) {
    foreignItemId = `foreign-item-${suffix}`;
    await db.ops.mutate.graph.createNode({
      id: foreignItemId,
      namespace,
      type: "memory_item",
      name: "Other agent memory",
      content: "Only the other agent should recall this.",
      embedding: Array.from(
        { length: 1536 },
        (_, index) => index === 0 ? 1 : 0,
      ),
      data: {
        memorySpaceId: String(memorySpace.id),
        checkpointId: `foreign-checkpoint-${suffix}`,
        createdByAgentId: "other-agent",
        kind: "fact",
        name: "Other agent memory",
        content: "Only the other agent should recall this.",
        sourceMessageIds: [first.id],
      },
      sourceType: "long_term_memory",
      sourceId: `foreign-checkpoint-${suffix}`,
    }, { threadId, namespace });
  }
  const checkpoint = await db.ops.mutate.graph.createNode({
    namespace,
    type: "long_term_memory",
    name: `thread:${threadId}:memory:${options.withPrevious ? 2 : 1}`,
    content: null,
    embedding: null,
    data: {
      schemaVersion: "1",
      strategy: "checkpointed_graph",
      status: "pending",
      threadId,
      memorySpaceId: String(memorySpace.id),
      sequence: options.withPrevious ? 2 : 1,
      agentId: "agent",
      sourceStartMessageId: first.id,
      sourceEndMessageId: last.id,
    },
    sourceType: "thread",
    sourceId: threadId,
  }, { threadId, namespace });
  return {
    db,
    namespace,
    thread,
    threadId,
    checkpoint,
    first,
    last,
    previousItemId,
    foreignItemId,
  };
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
          triggerEstimatedTokens: 1,
          maxContentEstimatedTokens: 2_500,
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
      (items[0].data as Record<string, unknown>).createdByAgentId,
      "agent",
    );
    assertStringIncludes(
      checkpoint?.content ?? "",
      `[id:${items[0].id}]`,
    );
    assertEquals(
      (
        (checkpoint?.data as Record<string, unknown>).metadata as Record<
          string,
          unknown
        >
      ).visibleItemIds,
      [items[0].id],
    );
    assertEquals(registries.embeddingRequests[0], [
      proposal.items[0].content,
    ]);
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

Deno.test("processor may supersede an item visible in the previous checkpoint", async () => {
  const fixture = await createPendingCheckpoint({ withPrevious: true });
  const proposal = {
    workState: "The previous decision is being replaced.",
    items: [{
      localId: "replacement",
      kind: "decision",
      name: "Replacement decision",
      content: "Use the replacement approach.",
      confidence: 0.95,
      sourceMessageIds: [fixture.last.id],
      supersedesItemId: fixture.previousItemId,
    }],
    relations: [],
  };
  const registries = mockRegistries(JSON.stringify(proposal));
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

    assertStringIncludes(
      JSON.stringify(registries.chatRequests[0]?.messages),
      `[id:${fixture.previousItemId}]`,
    );
    const items = await fixture.db.ops.unsafeGraph.getNodesByNamespace(
      fixture.namespace,
      "memory_item",
    );
    const replacement = items.find((item) =>
      item.name === "Replacement decision"
    );
    const edges = await fixture.db.ops.unsafeGraph.getEdgesForNode(
      String(replacement?.id),
      "out",
      ["supersedes"],
    );
    assertEquals(edges.length, 1);
    assertEquals(String(edges[0].targetNodeId), fixture.previousItemId);
    const checkpoint = await fixture.db.ops.unsafeGraph.getNodeById(
      String(fixture.checkpoint.id),
    );
    const metadata = (checkpoint?.data as Record<string, unknown>)
      .metadata as Record<
        string,
        unknown
      >;
    assertEquals(metadata.retrievedItemIds, []);
  } finally {
    registries.restore();
  }
});

Deno.test("processor retrieves only memory items created by its agent", async () => {
  const fixture = await createPendingCheckpoint({ withForeignItem: true });
  const proposal = {
    workState: "The current agent is recording its own decision.",
    items: [{
      localId: "own-decision",
      kind: "decision",
      name: "Own decision",
      content: "This decision belongs to the current agent.",
      confidence: 0.95,
      sourceMessageIds: [fixture.last.id],
    }],
    relations: [],
  };
  const registries = mockRegistries(JSON.stringify(proposal));
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
      checkpoint?.content?.includes("Only the other agent should recall this."),
      false,
    );
    assertEquals(
      (
        (checkpoint?.data as Record<string, unknown>).metadata as Record<
          string,
          unknown
        >
      ).retrievedItemIds,
      [],
    );
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
