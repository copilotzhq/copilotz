import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "@/database/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";
import brain from "./brain.ts";

Deno.test("admin brain returns scoped nodes, semantic edges, clusters, and stats", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-brain";
  const otherNamespace = "tenant-other-brain";
  const knowledgeId = crypto.randomUUID();
  const workingId = crypto.randomUUID();
  const hiddenId = crypto.randomUUID();

  await db.ops.unsafeGraph.createNode({
    id: knowledgeId,
    namespace,
    type: "brain_node",
    name: "Pricing decision",
    content: "Use usage credits for billing.",
    data: {
      memorySpaceId: "space-main",
      checkpointId: "checkpoint-main",
      createdByAgentId: "agent-north",
      originThreadId: "thread-main",
      layer: "knowledge",
      status: "active",
      kind: "decision",
      confidence: 0.91,
      sourceMessageIds: ["message-1"],
    },
    sourceType: "long_term_memory",
    sourceId: "checkpoint-main",
  });
  await db.ops.unsafeGraph.createNode({
    id: workingId,
    namespace,
    type: "brain_node",
    name: "Current state",
    content: "Billing model is being explored.",
    data: {
      memorySpaceId: "space-main",
      checkpointId: "checkpoint-main",
      createdByAgentId: "agent-north",
      originThreadId: "thread-main",
      layer: "working",
      status: "active",
      kind: "current_state",
      sourceField: "state.currentState",
      sourceMessageIds: ["message-2"],
    },
    sourceType: "long_term_memory",
    sourceId: "checkpoint-main",
  });
  await db.ops.unsafeGraph.createNode({
    id: hiddenId,
    namespace: otherNamespace,
    type: "brain_node",
    name: "Hidden",
    content: "Other tenant.",
    data: { layer: "knowledge", status: "active", kind: "fact" },
  });
  await db.ops.unsafeGraph.createEdge({
    sourceNodeId: knowledgeId,
    targetNodeId: workingId,
    type: GRAPH_EDGE.RELATED_TO,
  });

  const result = await brain({
    query: { namespace, agentId: "agent-north" },
  }, { ops: db.ops } as any);
  const data = result.data as any;

  assertEquals(result.status, 200);
  assertEquals(
    data.nodes.map((node: any) => node.id).sort(),
    [knowledgeId, workingId].sort(),
  );
  assertEquals(
    data.nodes.every((node: any) => node.namespace === namespace),
    true,
  );
  assertEquals(data.edges.length, 1);
  assertEquals(data.edges[0].type, GRAPH_EDGE.RELATED_TO);
  assertEquals(data.stats.total, 2);
  assertEquals(data.stats.byLayer, { knowledge: 1, working: 1 });
  assertEquals(data.stats.byKind.decision, 1);
  assertEquals(data.stats.byKind.current_state, 1);
  assertEquals(data.clusters.length, 2);
  assertEquals(
    data.nodes.every((node: any) =>
      typeof node.x === "number" && typeof node.y === "number"
    ),
    true,
  );
});

Deno.test("admin brain applies search and layer filters", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-brain-search";

  await db.ops.unsafeGraph.createNode({
    id: crypto.randomUUID(),
    namespace,
    type: "brain_node",
    name: "Launch blocker",
    content: "OAuth credentials are missing.",
    data: { layer: "working", status: "active", kind: "risk" },
  });
  await db.ops.unsafeGraph.createNode({
    id: crypto.randomUUID(),
    namespace,
    type: "brain_node",
    name: "Launch decision",
    content: "Ship billing after policy review.",
    data: { layer: "knowledge", status: "active", kind: "decision" },
  });

  const result = await brain({
    query: { namespace, layer: "working", search: "oauth" },
  }, { ops: db.ops } as any);
  const data = result.data as any;

  assertEquals(data.nodes.length, 1);
  assertEquals(data.nodes[0].name, "Launch blocker");
  assertEquals(data.stats.byLayer, { working: 1 });
});
