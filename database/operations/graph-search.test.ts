import { assertEquals } from "@std/assert";
import { createDatabase } from "@/database/index.ts";
import { AGENT_MEMORY_OWNERSHIP_MIGRATIONS } from "@/database/migrations/migration_0013_agent_memory_ownership.ts";

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

    const results = await db.ops.unsafeGraph.searchNodes({
      embedding,
      namespaces: [namespace],
      nodeTypes: ["memory_item"],
      dataFilters: {
        memorySpaceId: "shared-space",
        createdByAgentId: "agent-b",
      },
      minSimilarity: 0.2,
      limit: 1,
    });

    assertEquals(results.map((result) => result.node.id), [
      `agent-b-${suffix}`,
    ]);
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
