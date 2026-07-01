import { assertEquals } from "@std/assert";
import { createDatabase } from "@/database/index.ts";
import { AGENT_MEMORY_OWNERSHIP_MIGRATIONS } from "@/database/migrations/migration_0013_agent_memory_ownership.ts";
import { MEMORY_SPACE_ACCESS_DATA_MIGRATIONS } from "@/database/migrations/migration_0014_memory_space_access.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

Deno.test({
  name: "graph semantic search applies node data filters before ranking",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const suffix = crypto.randomUUID();
    const namespace = `graph-search-data-${suffix}`;
    const embedding = Array.from(
      { length: 1536 },
      (_, index) => index === 0 ? 1 : 0,
    );

    await db.ops.unsafeGraph.createNode({
      id: `agent-a-${suffix}`,
      namespace,
      type: "memory_item",
      name: "Agent A memory",
      content: "A",
      embedding,
      data: {
        memorySpaceId: "shared-space",
        createdByAgentId: "agent-a",
      },
      sourceType: "long_term_memory",
      sourceId: `checkpoint-a-${suffix}`,
    });
    await db.ops.unsafeGraph.createNode({
      id: `agent-b-${suffix}`,
      namespace,
      type: "memory_item",
      name: "Agent B memory",
      content: "B",
      embedding,
      data: {
        memorySpaceId: "shared-space",
        createdByAgentId: "agent-b",
      },
      sourceType: "long_term_memory",
      sourceId: `checkpoint-b-${suffix}`,
    });
    await db.ops.unsafeGraph.createNode({
      id: `agent-b-replacement-${suffix}`,
      namespace,
      type: "memory_item",
      name: "Agent B replacement",
      content: "B2",
      embedding,
      data: {
        memorySpaceId: "shared-space",
        createdByAgentId: "agent-b",
      },
      sourceType: "long_term_memory",
      sourceId: `checkpoint-b2-${suffix}`,
    });
    await db.ops.unsafeGraph.createEdge({
      sourceNodeId: `agent-b-replacement-${suffix}`,
      targetNodeId: `agent-b-${suffix}`,
      type: GRAPH_EDGE.SUPERSEDES,
    });

    const results = await db.ops.unsafeGraph.searchNodes({
      embedding,
      namespaces: [namespace],
      nodeTypes: ["memory_item"],
      dataFilters: {
        createdByAgentId: "agent-b",
      },
      dataFilterAny: {
        memorySpaceId: ["shared-space"],
      },
      excludeWithIncomingEdgeTypes: [GRAPH_EDGE.SUPERSEDES],
      minSimilarity: 0.2,
      limit: 1,
    });

    assertEquals(results.map((result) => result.node.id), [
      `agent-b-replacement-${suffix}`,
    ]);
  },
});

Deno.test({
  name: "memory-space migration preserves legacy access and provenance",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const suffix = crypto.randomUUID();
    const namespace = `legacy-memory-space-${suffix}`;
    const thread = await db.ops.mutate.threads.create(undefined, {
      namespace,
      name: "Legacy memory space",
      participants: ["user", "agent"],
      status: "active",
      mode: "immediate",
    });
    const threadId = String(thread.id);
    const space = await db.ops.unsafeGraph.createNode({
      id: `space-${suffix}`,
      namespace,
      type: "memory_space",
      name: "Legacy thread memory",
      data: {
        kind: "thread",
        ownerNodeId: threadId,
        threadId,
      },
      sourceType: "thread",
      sourceId: threadId,
    });
    await db.ops.unsafeGraph.createEdge({
      id: `ownership-${suffix}`,
      sourceNodeId: threadId,
      targetNodeId: String(space.id),
      type: GRAPH_EDGE.OWNS_MEMORY_SPACE,
    });
    const checkpoint = await db.ops.unsafeGraph.createNode({
      id: `checkpoint-${suffix}`,
      namespace,
      type: "long_term_memory",
      name: "Legacy checkpoint",
      data: { threadId, agentId: "agent" },
      sourceType: "thread",
      sourceId: threadId,
    });
    const item = await db.ops.unsafeGraph.createNode({
      id: `item-${suffix}`,
      namespace,
      type: "memory_item",
      name: "Legacy item",
      data: {
        memorySpaceId: String(space.id),
        checkpointId: String(checkpoint.id),
      },
      sourceType: "long_term_memory",
      sourceId: String(checkpoint.id),
    });

    for (const migration of MEMORY_SPACE_ACCESS_DATA_MIGRATIONS) {
      await db.query(migration);
    }

    const migratedSpace = await db.ops.unsafeGraph.getNodeById(
      String(space.id),
    );
    assertEquals(migratedSpace?.data, {
      kind: "thread",
      ownerNodeId: threadId,
      threadId,
      scopeType: "thread",
      scopeId: threadId,
    });
    const migratedItem = await db.ops.unsafeGraph.getNodeById(String(item.id));
    assertEquals(
      (migratedItem?.data as Record<string, unknown>).originThreadId,
      threadId,
    );
    const access = await db.ops.unsafeGraph.getEdgesForNode(
      threadId,
      "out",
      [GRAPH_EDGE.USES_MEMORY_SPACE],
    );
    assertEquals(
      access.map((edge) => ({
        targetNodeId: edge.targetNodeId,
        data: edge.data,
      })),
      [{
        targetNodeId: String(space.id),
        data: { access: "read_write", defaultWrite: true },
      }],
    );
  },
});

Deno.test({
  name:
    "agent-memory migration derives legacy item ownership from its checkpoint",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const suffix = crypto.randomUUID();
    const namespace = `legacy-memory-owner-${suffix}`;
    const checkpointId = `checkpoint-${suffix}`;
    const itemId = `item-${suffix}`;

    await db.ops.unsafeGraph.createNode({
      id: checkpointId,
      namespace,
      type: "long_term_memory",
      name: "Legacy checkpoint",
      data: { agentId: "legacy-agent" },
      sourceType: "thread",
      sourceId: `thread-${suffix}`,
    });
    await db.ops.unsafeGraph.createNode({
      id: itemId,
      namespace,
      type: "memory_item",
      name: "Legacy memory item",
      data: {
        memorySpaceId: `space-${suffix}`,
        checkpointId,
      },
      sourceType: "long_term_memory",
      sourceId: checkpointId,
    });

    await db.query(AGENT_MEMORY_OWNERSHIP_MIGRATIONS[0]);

    const item = await db.ops.unsafeGraph.getNodeById(itemId);
    assertEquals(
      (item?.data as Record<string, unknown>).createdByAgentId,
      "legacy-agent",
    );
  },
});
