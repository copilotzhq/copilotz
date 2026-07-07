import {
  assertAlmostEquals,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { createDatabase } from "@/database/index.ts";
import type { Event, ProcessorDeps } from "@/types/index.ts";
import type { ProviderFactory } from "@/runtime/llm/types.ts";
import type { EmbeddingProviderFactory } from "@/runtime/embeddings/types.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";
import {
  applyContinuityPatch,
  averageNormalizedEmbeddings,
  buildContinuityRetrievalTexts,
  chunkLinesForEmbedding,
  createEmptyContinuity,
  extractVisibleBrainNodeIds,
  fuseMemoryCandidateRanks,
  parseConsolidationProposal,
  process,
  renderLongTermMemory,
} from "./long_term_memory.created.ts";
import { buildAgentLlmInput } from "@/runtime/agent-llm-input/index.ts";
import { formatMessagesDetailed } from "@/runtime/llm/utils.ts";

function currentStatePatch(sourceMessageId: string, value: string | null) {
  return {
    state: {
      currentState: {
        value,
        sourceMessageIds: [sourceMessageId],
      },
    },
  };
}

interface MockRegistries {
  llmProviders: Record<string, ProviderFactory>;
  embeddingProviders: Record<string, EmbeddingProviderFactory>;
  chatRequests: Array<Record<string, unknown>>;
  chatAuthorizations: Array<string | null>;
  embeddingRequests: string[][];
  restore: () => void;
}

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
  const continuity = applyContinuityPatch(createEmptyContinuity(), {
    state: {
      currentState: {
        value: oversized,
        sourceMessageIds: ["message-1"],
      },
    },
  });
  const rendered = renderLongTermMemory({
    proposal: {
      continuityPatch: {},
      nodes: [],
      relations: [],
    },
    continuity,
    newBrainNodes: new Map(),
    olderBrainNodes: [],
    olderRelations: [],
    maxContentEstimatedTokens: 30,
  });

  assertEquals(rendered.length <= 120, true);
  assertEquals(rendered.includes("OVERSIZED_MEMORY_BLOCK_"), false);
});

Deno.test("continuity patches retain omitted fields and explicitly clear values", () => {
  const initial = applyContinuityPatch(createEmptyContinuity(), {
    intent: {
      challenge: {
        value: "Preserve the user's goal across rollovers.",
        sourceMessageIds: ["message-1"],
      },
    },
    state: {
      openQuestions: {
        value: ["How should retrieval support continuity?"],
        sourceMessageIds: ["message-1"],
      },
    },
  });
  const updated = applyContinuityPatch(initial, {
    state: {
      openQuestions: {
        value: [],
        sourceMessageIds: ["message-2"],
      },
    },
  });

  assertEquals(updated.intent.challenge, initial.intent.challenge);
  assertEquals(updated.state.openQuestions, {
    value: [],
    sourceMessageIds: ["message-2"],
  });
});

Deno.test("continuity creates separate intent and state retrieval queries", () => {
  const continuity = applyContinuityPatch(createEmptyContinuity(), {
    intent: {
      desiredOutcome: {
        value: "Long conversations retain their original objective.",
        sourceMessageIds: ["message-1"],
      },
    },
    state: {
      activeApproach: {
        value: "Use deterministic continuity patches.",
        sourceMessageIds: ["message-2"],
      },
    },
  });

  assertEquals(buildContinuityRetrievalTexts(continuity), [
    "desiredOutcome: Long conversations retain their original objective.",
    "activeApproach: Use deterministic continuity patches.",
  ]);
});

Deno.test("continuity updates require provenance from the reserved range", () => {
  assertThrows(
    () =>
      parseConsolidationProposal(
        JSON.stringify({
          continuityPatch: currentStatePatch(
            "outside-range",
            "This update has no valid provenance.",
          ),
          items: [],
          relations: [],
        }),
        new Set(["message-1"]),
        new Set(),
      ),
    Error,
    "currentState",
  );
});

Deno.test("checkpoint item IDs are extractable only when fully rendered", () => {
  assertEquals(
    extractVisibleBrainNodeIds(
      "- [id:item-1] [fact] One\n- [id:item-2] [task] Two\n[id:item-1]",
    ),
    ["item-1", "item-2"],
  );
  assertEquals(extractVisibleBrainNodeIds("- [id:truncated"), []);
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

Deno.test("consolidation accepts mentions relations and rejects unknown relation types", () => {
  const parsed = parseConsolidationProposal(
    JSON.stringify({
      continuityPatch: {},
      nodes: [{
        localId: "entity-compass",
        kind: "entity",
        name: "Compass",
        content: "Compass is the workspace being improved.",
        sourceMessageIds: ["message-1"],
      }, {
        localId: "decision-admin",
        kind: "decision",
        name: "Admin decision",
        content: "Admin memory should be entity-anchored.",
        sourceMessageIds: ["message-1"],
      }],
      relations: [{
        source: "decision-admin",
        type: GRAPH_EDGE.MENTIONS,
        target: "entity-compass",
      }, {
        source: "decision-admin",
        type: "owns",
        target: "entity-compass",
      }],
    }),
    new Set(["message-1"]),
    new Set(),
  );

  assertEquals(parsed.relations, [{
    source: "decision-admin",
    type: GRAPH_EDGE.MENTIONS,
    target: "entity-compass",
  }]);
});

Deno.test("consolidation relations may target visible older brain nodes", () => {
  const parsed = parseConsolidationProposal(
    JSON.stringify({
      continuityPatch: {},
      nodes: [{
        localId: "task-credentials",
        kind: "task",
        name: "Credentials task",
        content: "Build the tenant credentials admin.",
        sourceMessageIds: ["message-1"],
      }],
      relations: [{
        source: "task-credentials",
        type: GRAPH_EDGE.MENTIONS,
        target: "older-entity",
      }],
    }),
    new Set(["message-1"]),
    new Set(["older-entity"]),
  );

  assertEquals(parsed.relations, [{
    source: "task-credentials",
    type: GRAPH_EDGE.MENTIONS,
    target: "older-entity",
  }]);
});

Deno.test("consolidation may supersede only a visible checkpoint brain node", () => {
  const proposal = JSON.stringify({
    continuityPatch: currentStatePatch(
      "message-1",
      "Updating a prior decision.",
    ),
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

  assertEquals(parsed.nodes[0].supersedesNodeId, "visible-item");
  assertEquals(parsed.nodes[1].supersedesNodeId, undefined);
});

Deno.test("consolidation routes invalid memory-space targets to the default", () => {
  const parsed = parseConsolidationProposal(
    JSON.stringify({
      continuityPatch: currentStatePatch("message-1", "Routing memory."),
      items: [{
        localId: "item",
        kind: "fact",
        name: "Routed fact",
        content: "Use a validated writable target.",
        sourceMessageIds: ["message-1"],
        memorySpaceId: "not-attached",
      }],
      relations: [],
    }),
    new Set(["message-1"]),
    new Set(),
    {
      writableMemorySpaceIds: new Set(["default-space", "shared-space"]),
      defaultWriteMemorySpaceId: "default-space",
    },
  );

  assertEquals(parsed.nodes[0].memorySpaceId, "default-space");
});

function mockRegistries(answer: string | string[]): MockRegistries {
  const answers = Array.isArray(answer) ? answer : [answer];
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
    const responseAnswer =
      answers[Math.min(chatRequests.length - 1, answers.length - 1)];
    const event = JSON.stringify({ content: responseAnswer, done: true });
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
    chatAuthorizations: [],
    embeddingRequests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function mockFallbackRegistries(
  answer: string,
  fallbackStatus?: number,
): MockRegistries {
  const chatRequests: Array<Record<string, unknown>> = [];
  const chatAuthorizations: Array<string | null> = [];
  const embeddingRequests: string[][] = [];
  const anthropicFactory: ProviderFactory = () => ({
    endpoint: "https://mock.local/anthropic",
    headers: (config) => ({ "x-api-key": config.apiKey ?? "" }),
    body: (messages, config) => ({ messages, config }),
    extractContent: () => null,
  });
  const openaiFactory: ProviderFactory = () => ({
    endpoint: "https://mock.local/openai",
    headers: (config) => ({
      "Authorization": `Bearer ${config.apiKey}`,
    }),
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
    chatAuthorizations.push(
      new Headers(init?.headers).get("authorization") ??
        new Headers(init?.headers).get("x-api-key"),
    );
    if (url.endsWith("/anthropic")) {
      return Promise.resolve(
        new Response("primary unavailable", {
          status: 400,
          statusText: "Bad Request",
        }),
      );
    }
    if (fallbackStatus) {
      return Promise.resolve(
        new Response("fallback unavailable", {
          status: fallbackStatus,
          statusText: "Fallback unavailable",
        }),
      );
    }
    const event = JSON.stringify({ content: answer, done: true });
    return Promise.resolve(
      new Response(`data: ${event}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  return {
    llmProviders: {
      anthropic: anthropicFactory,
      openai: openaiFactory,
    },
    embeddingProviders: { openai: embeddingFactory },
    chatRequests,
    chatAuthorizations,
    embeddingRequests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function createPendingCheckpoint(
  options: {
    withPrevious?: boolean;
    withForeignItem?: boolean;
    withSharedSpace?: boolean;
  } = {},
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
    data: { scopeType: "thread", scopeId: threadId },
    sourceType: "thread",
    sourceId: threadId,
  }, { threadId, namespace });
  await db.ops.mutate.graph.createEdge({
    sourceNodeId: threadId,
    targetNodeId: String(memorySpace.id),
    type: GRAPH_EDGE.USES_MEMORY_SPACE,
    data: { access: "read_write", defaultWrite: true },
  }, { threadId, namespace });
  let sharedMemorySpaceId: string | null = null;
  let sharedItemId: string | null = null;
  if (options.withSharedSpace) {
    const sharedSpace = await db.ops.mutate.graph.createNode({
      namespace,
      type: "memory_space",
      name: "Shared user memory",
      data: { scopeType: "user", scopeId: "user" },
      sourceType: "user",
      sourceId: "user",
    }, { threadId, namespace });
    sharedMemorySpaceId = String(sharedSpace.id);
    await db.ops.mutate.graph.createEdge({
      sourceNodeId: threadId,
      targetNodeId: sharedMemorySpaceId,
      type: GRAPH_EDGE.USES_MEMORY_SPACE,
      data: { access: "read_write" },
    }, { threadId, namespace });
    sharedItemId = `shared-item-${suffix}`;
    await db.ops.mutate.graph.createNode({
      id: sharedItemId,
      namespace,
      type: "brain_node",
      name: "Cross-thread preference",
      content: "The user prefers memories shared across threads.",
      embedding: Array.from(
        { length: 1536 },
        (_, index) => index === 0 ? 1 : 0,
      ),
      data: {
        memorySpaceId: sharedMemorySpaceId,
        checkpointId: `shared-checkpoint-${suffix}`,
        createdByAgentId: "agent",
        originThreadId: `other-thread-${suffix}`,
        kind: "preference",
        name: "Cross-thread preference",
        content: "The user prefers memories shared across threads.",
        sourceMessageIds: [],
      },
      sourceType: "long_term_memory",
      sourceId: `shared-checkpoint-${suffix}`,
    }, { threadId, namespace });
  }
  let previousItemId: string | null = null;
  let foreignItemId: string | null = null;
  if (options.withPrevious) {
    const previousCheckpointId = `previous-checkpoint-${suffix}`;
    previousItemId = `previous-item-${suffix}`;
    const previousContinuity = applyContinuityPatch(
      createEmptyContinuity(),
      {
        intent: {
          challenge: {
            value: "Keep long-running work aligned with the user's goal.",
            sourceMessageIds: [first.id],
          },
        },
        state: {
          currentState: {
            value: "A previous implementation decision is active.",
            sourceMessageIds: [first.id],
          },
        },
      },
    );
    await db.ops.mutate.graph.createNode({
      id: previousItemId,
      namespace,
      type: "brain_node",
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
        originThreadId: threadId,
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
        metadata: {
          continuityVersion: "1",
          continuity: previousContinuity,
          visibleBrainNodeIds: [previousItemId],
        },
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
      type: "brain_node",
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
        originThreadId: threadId,
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
      schemaVersion: options.withSharedSpace ? "2" : "1",
      strategy: "checkpointed_graph",
      status: "pending",
      threadId,
      ...(options.withSharedSpace
        ? {
          readMemorySpaceIds: [
            String(memorySpace.id),
            sharedMemorySpaceId!,
          ],
          writeMemorySpaceIds: [
            String(memorySpace.id),
            sharedMemorySpaceId!,
          ],
          defaultWriteMemorySpaceId: String(memorySpace.id),
        }
        : { memorySpaceId: String(memorySpace.id) }),
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
    memorySpaceId: String(memorySpace.id),
    sharedMemorySpaceId,
    sharedItemId,
  };
}

function createDeps(
  fixture: Awaited<ReturnType<typeof createPendingCheckpoint>>,
  registries: MockRegistries,
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
    continuityPatch: currentStatePatch(
      fixture.last.id,
      "The lifecycle-based memory processor is being implemented.",
    ),
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
    const brainNodes = await fixture.db.ops.unsafeGraph.getNodesByNamespace(
      fixture.namespace,
      "brain_node",
    );
    const knowledgeNodes = brainNodes.filter((node) =>
      (node.data as Record<string, unknown>).layer === "knowledge"
    );
    const workingNodes = brainNodes.filter((node) =>
      (node.data as Record<string, unknown>).layer === "working"
    );
    assertEquals(knowledgeNodes.length, 1);
    assertEquals(workingNodes.length, 1);
    assertEquals(knowledgeNodes[0].content, proposal.items[0].content);
    assertEquals(
      workingNodes[0].content,
      proposal.continuityPatch.state
        ?.currentState?.value,
    );
    assertEquals(
      (knowledgeNodes[0].data as Record<string, unknown>).createdByAgentId,
      "agent",
    );
    assertEquals(
      (knowledgeNodes[0].data as Record<string, unknown>).status,
      "active",
    );
    assertStringIncludes(
      checkpoint?.content ?? "",
      `[id:${knowledgeNodes[0].id}]`,
    );
    assertEquals(
      (
        (checkpoint?.data as Record<string, unknown>).metadata as Record<
          string,
          unknown
        >
      ).visibleBrainNodeIds,
      [knowledgeNodes[0].id],
    );
    assertEquals(registries.embeddingRequests[0], [
      proposal.items[0].content,
      proposal.continuityPatch.state?.currentState?.value,
      "currentState: The lifecycle-based memory processor is being implemented.",
    ]);
    assertEquals(
      (registries.chatRequests[0]?.config as Record<string, unknown>).model,
      "mock",
    );

    await process(event, deps);
    const brainNodesAfterRetry = await fixture.db.ops.unsafeGraph
      .getNodesByNamespace(
        fixture.namespace,
        "brain_node",
      );
    assertEquals(brainNodesAfterRetry.length, 2);
    assertEquals(registries.chatRequests.length, 1);
  } finally {
    registries.restore();
  }
});

Deno.test("long-term-memory processor persists entity-anchored mentions edges", async () => {
  const fixture = await createPendingCheckpoint();
  const proposal = {
    continuityPatch: currentStatePatch(
      fixture.last.id,
      "Compass admin memory is being made entity-anchored.",
    ),
    items: [{
      localId: "entity-compass",
      kind: "entity",
      name: "Compass",
      content:
        "Compass is the tenant-aware workspace using Copilotz admin features.",
      confidence: 0.95,
      sourceMessageIds: [fixture.first.id],
    }, {
      localId: "decision-admin",
      kind: "decision",
      name: "Entity-anchored brain",
      content:
        "Brain consolidation should connect durable decisions back to entity nodes.",
      confidence: 0.97,
      sourceMessageIds: [fixture.last.id],
    }],
    relations: [{
      source: "decision-admin",
      type: GRAPH_EDGE.MENTIONS,
      target: "entity-compass",
    }],
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

    const brainNodes = await fixture.db.ops.unsafeGraph.getNodesByNamespace(
      fixture.namespace,
      "brain_node",
    );
    const entity = brainNodes.find((node) =>
      (node.data as Record<string, unknown>).kind === "entity" &&
      node.name === "Compass"
    );
    const decision = brainNodes.find((node) =>
      (node.data as Record<string, unknown>).kind === "decision" &&
      node.name === "Entity-anchored brain"
    );
    if (!entity || !decision) {
      throw new Error("Expected entity and decision brain nodes.");
    }
    assertEquals(entity.name, "Compass");
    assertEquals(decision.name, "Entity-anchored brain");
    const mentions = await fixture.db.ops.unsafeGraph.getEdgesForNode(
      String(decision.id),
      "out",
      [GRAPH_EDGE.MENTIONS],
    );
    assertEquals(mentions.length, 1);
    assertEquals(String(mentions[0].targetNodeId), String(entity.id));

    const checkpoint = await fixture.db.ops.unsafeGraph.getNodeById(
      String(fixture.checkpoint.id),
    );
    assertStringIncludes(checkpoint?.content ?? "", "[entity] Compass");
    assertStringIncludes(
      checkpoint?.content ?? "",
      "Entity-anchored brain --mentions--> Compass",
    );
  } finally {
    registries.restore();
  }
});

Deno.test("long-term-memory consolidation appends one instruction to shared agent input", async () => {
  const fixture = await createPendingCheckpoint();
  const proposal = {
    continuityPatch: currentStatePatch(
      fixture.last.id,
      "The shared agent input path is used for consolidation.",
    ),
    items: [],
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
    const deps = createDeps(fixture, registries);
    deps.context.tools = [{
      id: "lookup-tool",
      key: "lookup_tool",
      name: "Lookup Tool",
      description: "Looks up supporting information.",
      inputSchema: "type Input = { query: string }",
      execute: () => ({ ok: true }),
    } as never];
    const agent = deps.context.agents![0];
    const sharedInput = await buildAgentLlmInput({
      deps,
      event,
      threadId: fixture.threadId,
      agent,
      historyMode: {
        type: "range",
        startMessageId: fixture.first.id,
        endMessageId: fixture.last.id,
      },
    });

    await process(event, deps);

    const promptFingerprint = (messages: unknown[]) =>
      messages.map((message) => {
        const typed = message as {
          role?: string;
          content?: unknown;
          senderId?: string;
          metadata?: { sourceMessageId?: string };
        };
        return {
          role: typed.role,
          content: typed.content,
          senderId: typed.senderId,
          sourceMessageId: typed.metadata?.sourceMessageId,
        };
      });
    const sentMessages = registries.chatRequests[0]?.messages as unknown[];
    const expectedPrefix = formatMessagesDetailed({
      messages: sharedInput.messages,
      tools: sharedInput.tools,
      config: sharedInput.config,
    }).messages;
    assertEquals(
      promptFingerprint(sentMessages.slice(0, expectedPrefix.length)),
      promptFingerprint(expectedPrefix),
    );

    const finalInstruction = sentMessages.at(-1) as {
      role?: string;
      content?: string;
    };
    assertEquals(finalInstruction.role, "user");
    assertStringIncludes(
      finalInstruction.content ?? "",
      "Source message map for provenance",
    );
    assertStringIncludes(finalInstruction.content ?? "", fixture.first.id);
    assertStringIncludes(finalInstruction.content ?? "", fixture.last.id);
    assertStringIncludes(
      finalInstruction.content ?? "",
      "Do not answer the user, do not route the conversation, and do not call tools.",
    );
    assertStringIncludes(
      finalInstruction.content ?? "",
      "Entity preservation:",
    );
    assertStringIncludes(
      finalInstruction.content ?? "",
      "Every non-entity node that is about a durable entity must include a mentions relation",
    );
    assertStringIncludes(
      finalInstruction.content ?? "",
      "Reuse visible older entity nodes by relating to their IDs instead of duplicating them.",
    );
    assertStringIncludes(
      finalInstruction.content ?? "",
      "mentions, related_to, supports, contradicts, depends_on, supersedes",
    );
    assertStringIncludes(
      finalInstruction.content ?? "",
      "Before returning JSON, verify that important entities are represented",
    );
    assertEquals(
      (finalInstruction.content ?? "").includes(
        ["Conversation range", "to consolidate"].join(" "),
      ),
      false,
    );
    assertStringIncludes(
      JSON.stringify(registries.chatRequests[0]?.messages),
      "lookup_tool",
    );
  } finally {
    registries.restore();
  }
});

Deno.test("long-term-memory consolidation rejects tool calls and repairs", async () => {
  const fixture = await createPendingCheckpoint();
  const proposal = {
    continuityPatch: currentStatePatch(
      fixture.last.id,
      "The repaired consolidation avoided tool calls.",
    ),
    items: [],
    relations: [],
  };
  const registries = mockRegistries([
    [
      "<tool_calls>",
      '{"name":"lookup_tool","arguments":{"query":"memory"}}',
      "</tool_calls>",
    ].join("\n"),
    JSON.stringify(proposal),
  ]);
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
    deps.context.tools = [{
      id: "lookup-tool",
      key: "lookup_tool",
      name: "Lookup Tool",
      description: "Looks up supporting information.",
      inputSchema: "type Input = { query: string }",
      execute: () => ({ ok: true }),
    } as never];

    await process(event, deps);

    assertEquals(registries.chatRequests.length, 2);
    assertStringIncludes(
      JSON.stringify(registries.chatRequests[1]?.messages),
      "Do not call tools.",
    );
    const checkpoint = await fixture.db.ops.unsafeGraph.getNodeById(
      String(fixture.checkpoint.id),
    );
    assertEquals(
      (checkpoint?.data as Record<string, unknown>).status,
      "ready",
    );
  } finally {
    registries.restore();
  }
});

Deno.test("processor may supersede a brain node visible in the previous checkpoint", async () => {
  const fixture = await createPendingCheckpoint({ withPrevious: true });
  const proposal = {
    continuityPatch: currentStatePatch(
      fixture.last.id,
      "The previous decision is being replaced.",
    ),
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
      "brain_node",
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
    assertEquals(metadata.retrievedBrainNodeIds, [fixture.previousItemId]);
  } finally {
    registries.restore();
  }
});

Deno.test("processor retains prior intent and retrieves memory without new knowledge nodes", async () => {
  const fixture = await createPendingCheckpoint({ withPrevious: true });
  const proposal = {
    continuityPatch: currentStatePatch(
      fixture.last.id,
      "Implementation details are being reviewed.",
    ),
    items: [],
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
    const metadata = (checkpoint?.data as Record<string, unknown>)
      .metadata as Record<string, unknown>;
    const continuity = metadata.continuity as ReturnType<
      typeof createEmptyContinuity
    >;
    assertEquals(
      continuity.intent.challenge.value,
      "Keep long-running work aligned with the user's goal.",
    );
    assertEquals(
      continuity.intent.challenge.sourceMessageIds,
      [fixture.first.id],
    );
    assertEquals(
      continuity.state.currentState.value,
      "Implementation details are being reviewed.",
    );
    assertEquals(metadata.retrievedBrainNodeIds, [fixture.previousItemId]);
    assertStringIncludes(
      checkpoint?.content ?? "",
      "Keep long-running work aligned with the user's goal.",
    );
    assertStringIncludes(
      checkpoint?.content ?? "",
      "Previous decision",
    );
    assertEquals(registries.embeddingRequests[0], [
      "Keep long-running work aligned with the user's goal.",
      "Implementation details are being reviewed.",
      "challenge: Keep long-running work aligned with the user's goal.",
      [
        "currentState: Implementation details are being reviewed.",
      ].join("\n"),
    ]);
  } finally {
    registries.restore();
  }
});

Deno.test("processor retrieves only brain nodes created by its agent", async () => {
  const fixture = await createPendingCheckpoint({ withForeignItem: true });
  const proposal = {
    continuityPatch: currentStatePatch(
      fixture.last.id,
      "The current agent is recording its own decision.",
    ),
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
      ).retrievedBrainNodeIds,
      [],
    );
  } finally {
    registries.restore();
  }
});

Deno.test("processor reads and writes across attached memory spaces", async () => {
  const fixture = await createPendingCheckpoint({ withSharedSpace: true });
  const proposal = {
    continuityPatch: currentStatePatch(
      fixture.last.id,
      "The shared user memory is being updated.",
    ),
    items: [{
      localId: "shared-decision",
      kind: "decision",
      name: "Shared decision",
      content: "Store this decision in the shared user memory.",
      confidence: 0.95,
      sourceMessageIds: [fixture.last.id],
      memorySpaceId: fixture.sharedMemorySpaceId,
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

    const items = await fixture.db.ops.unsafeGraph.getNodesByNamespace(
      fixture.namespace,
      "brain_node",
    );
    const created = items.find((item) => item.name === "Shared decision");
    const createdData = created?.data as Record<string, unknown>;
    assertEquals(createdData.memorySpaceId, fixture.sharedMemorySpaceId);
    assertEquals(createdData.originThreadId, fixture.threadId);

    const checkpoint = await fixture.db.ops.unsafeGraph.getNodeById(
      String(fixture.checkpoint.id),
    );
    assertStringIncludes(
      checkpoint?.content ?? "",
      "The user prefers memories shared across threads.",
    );
    const metadata = (checkpoint?.data as Record<string, unknown>)
      .metadata as Record<string, unknown>;
    assertEquals(metadata.retrievedBrainNodeIds, [fixture.sharedItemId]);
    assertStringIncludes(
      JSON.stringify(registries.chatRequests[0]?.messages),
      String(fixture.sharedMemorySpaceId),
    );
  } finally {
    registries.restore();
  }
});

Deno.test("long-term-memory processor authenticates cross-provider fallbacks from runtime env", async () => {
  const fixture = await createPendingCheckpoint();
  const answer = JSON.stringify({
    continuityPatch: currentStatePatch(
      fixture.last.id,
      "The fallback completed memory consolidation.",
    ),
    items: [],
    relations: [],
  });
  const registries = mockFallbackRegistries(answer);
  const previousOpenAiKey = Deno.env.get("OPENAI_API_KEY");
  Deno.env.set("OPENAI_API_KEY", "fallback-openai-key");
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
    deps.context.agents = [{
      id: "agent",
      name: "Agent",
      role: "assistant",
      llmOptions: {
        provider: "anthropic",
        model: "primary",
        fallbacks: [{ provider: "openai", model: "fallback" }],
        estimateCost: false,
      },
    }];
    deps.context.security = {
      resolveLLMRuntimeConfig: () => ({ apiKey: "primary-anthropic-key" }),
    };
    await process(event, deps);

    const checkpoint = await fixture.db.ops.unsafeGraph.getNodeById(
      String(fixture.checkpoint.id),
    );
    assertEquals(
      (checkpoint?.data as Record<string, unknown>).status,
      "ready",
    );
    assertEquals(registries.chatRequests.length, 2);
    assertEquals(registries.chatAuthorizations, [
      "primary-anthropic-key",
      "Bearer fallback-openai-key",
    ]);
    const attempts = await fixture.db.ops.unsafeGraph.getNodesByNamespace(
      fixture.namespace,
      "llm_attempt",
    );
    const debug = (attempts[0].data as Record<string, unknown>)
      .debug as Record<string, unknown>;
    const consolidation = debug.consolidation as Record<string, unknown>;
    const providerAttempts = consolidation.providerAttempts as Array<
      Record<string, unknown>
    >;
    assertEquals(
      providerAttempts.map((attempt) => attempt.model),
      ["primary", "fallback"],
    );
    assertEquals(
      providerAttempts[0].error,
      {
        reason: "provider_error",
        status: 400,
        message: "Request failed with status 400",
      },
    );
  } finally {
    if (previousOpenAiKey === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", previousOpenAiKey);
    registries.restore();
  }
});

Deno.test("long-term-memory processor persists the complete failed fallback chain", async () => {
  const fixture = await createPendingCheckpoint();
  const registries = mockFallbackRegistries("", 401);
  const previousOpenAiKey = Deno.env.get("OPENAI_API_KEY");
  Deno.env.set("OPENAI_API_KEY", "fallback-openai-key");
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
    deps.context.agents = [{
      id: "agent",
      name: "Agent",
      role: "assistant",
      llmOptions: {
        provider: "anthropic",
        model: "primary",
        fallbacks: [{ provider: "openai", model: "fallback" }],
        estimateCost: false,
      },
    }];
    deps.context.security = {
      resolveLLMRuntimeConfig: () => ({ apiKey: "primary-anthropic-key" }),
    };
    await process(event, deps);

    const checkpoint = await fixture.db.ops.unsafeGraph.getNodeById(
      String(fixture.checkpoint.id),
    );
    const checkpointData = checkpoint?.data as Record<string, unknown>;
    assertEquals(checkpointData.status, "failed");
    const checkpointError = checkpointData.error as Record<string, unknown>;
    assertEquals(checkpointError.fallbackAttempted, true);
    assertEquals(checkpointError.provider, "openai");
    const providerAttempts = checkpointError.attempts as Array<
      Record<string, unknown>
    >;
    assertEquals(
      providerAttempts.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model,
        status: attempt.status,
      })),
      [
        { provider: "anthropic", model: "primary", status: 400 },
        { provider: "openai", model: "fallback", status: 401 },
      ],
    );

    const attempts = await fixture.db.ops.unsafeGraph.getNodesByNamespace(
      fixture.namespace,
      "llm_attempt",
    );
    assertEquals(
      (attempts[0].data as Record<string, unknown>).error,
      checkpointError,
    );
  } finally {
    if (previousOpenAiKey === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", previousOpenAiKey);
    registries.restore();
  }
});

Deno.test("long-term-memory processor repairs an invalid consolidation response once", async () => {
  const fixture = await createPendingCheckpoint();
  const repairedAnswer = JSON.stringify({
    continuityPatch: currentStatePatch(
      fixture.last.id,
      "The malformed consolidation response was repaired.",
    ),
    items: [],
    relations: [],
  });
  const registries = mockRegistries(["not-json", repairedAnswer]);
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
      "ready",
    );
    assertEquals(registries.chatRequests.length, 2);
    assertStringIncludes(
      JSON.stringify(registries.chatRequests[1]),
      "failed validation",
    );

    const attempts = await fixture.db.ops.unsafeGraph.getNodesByNamespace(
      fixture.namespace,
      "llm_attempt",
    );
    const attemptData = attempts[0].data as Record<string, unknown>;
    assertEquals(attemptData.status, "completed");
    assertEquals(attemptData.answer, repairedAnswer);
    const debug = attemptData.debug as Record<string, unknown>;
    const consolidation = debug.consolidation as Record<string, unknown>;
    assertEquals(consolidation.repairAttempted, true);
    const rejected = consolidation.rejectedValidationAttempts as Array<
      Record<string, unknown>
    >;
    const rejectedDebug = rejected[0].debug as Record<string, unknown>;
    assertEquals(
      (rejectedDebug.rawOutput as Record<string, unknown>).content,
      "not-json",
    );
  } finally {
    registries.restore();
  }
});

Deno.test("long-term-memory processor terminalizes an invalid consolidation after one repair", async () => {
  const fixture = await createPendingCheckpoint();
  const registries = mockRegistries(["not-json", "still-not-json"]);
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
    assertEquals(registries.chatRequests.length, 2);
    const attempts = await fixture.db.ops.unsafeGraph.getNodesByNamespace(
      fixture.namespace,
      "llm_attempt",
    );
    const attemptData = attempts[0].data as Record<string, unknown>;
    assertEquals(attemptData.status, "failed");
    assertEquals(attemptData.answer, "still-not-json");
    const error = attemptData.error as Record<string, unknown>;
    assertEquals(error.reason, "invalid_response");
    assertEquals(error.validationRepairAttempted, true);
    const debug = attemptData.debug as Record<string, unknown>;
    assertEquals(
      (debug.rawOutput as Record<string, unknown>).content,
      "still-not-json",
    );
  } finally {
    registries.restore();
  }
});
