import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "@/database/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";
import brain from "./brain.ts";

function vector(first: number, second = 0): number[] {
  return [first, second, ...Array.from({ length: 1534 }, () => 0)];
}

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

Deno.test("admin brain supports semantic and hybrid search with match reasons", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-brain-semantic";
  const semanticId = crypto.randomUUID();
  const keywordId = crypto.randomUUID();

  await db.ops.unsafeGraph.createNode({
    id: semanticId,
    namespace,
    type: "brain_node",
    name: "Usage credit policy",
    content: "Charge credits for tool and model usage.",
    embedding: vector(1),
    data: { layer: "knowledge", status: "active", kind: "decision" },
  });
  await db.ops.unsafeGraph.createNode({
    id: keywordId,
    namespace,
    type: "brain_node",
    name: "OAuth launch note",
    content: "Credentials need review before launch.",
    embedding: vector(0, 1),
    data: { layer: "working", status: "active", kind: "risk" },
  });

  const copilotz = {
    ops: db.ops,
    embeddings: {
      embed: () =>
        Promise.resolve({
          embeddings: [vector(1)],
          model: "mock",
          dimensions: 1536,
        }),
    },
  };
  const semantic = await brain({
    query: {
      namespace,
      search: "pricing",
      searchMode: "semantic",
      minSimilarity: "0.5",
    },
  }, copilotz as any);
  const semanticData = semantic.data as any;

  assertEquals(semanticData.nodes.map((node: any) => node.id), [semanticId]);
  assertEquals(semanticData.matches[semanticId].similarity, 1);
  assertEquals(semanticData.semantic.available, true);

  const hybrid = await brain({
    query: {
      namespace,
      search: "oauth",
      searchMode: "hybrid",
      minSimilarity: "0.5",
    },
  }, copilotz as any);
  const hybridData = hybrid.data as any;
  const hybridIds = hybridData.nodes.map((node: any) => node.id).sort();

  assertEquals(hybridIds, [keywordId, semanticId].sort());
  assertEquals(hybridData.matches[keywordId].keyword, true);
  assertEquals(hybridData.matches[semanticId].similarity, 1);
});

Deno.test("admin brain returns focus related and similar nodes", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-brain-focus";
  const focusId = crypto.randomUUID();
  const relatedId = crypto.randomUUID();
  const similarId = crypto.randomUUID();

  await db.ops.unsafeGraph.createNode({
    id: focusId,
    namespace,
    type: "brain_node",
    name: "Tenant credentials",
    content: "Store non-login credentials in tenant schema.",
    embedding: vector(1),
    data: { layer: "knowledge", status: "active", kind: "decision" },
  });
  await db.ops.unsafeGraph.createNode({
    id: relatedId,
    namespace,
    type: "brain_node",
    name: "Tenant policy",
    content: "Policy controls tenant admin capabilities.",
    data: { layer: "knowledge", status: "active", kind: "fact" },
  });
  await db.ops.unsafeGraph.createNode({
    id: similarId,
    namespace,
    type: "brain_node",
    name: "Tenant API keys",
    content: "API keys belong to tenant-owned credentials.",
    embedding: vector(0.98, 0.02),
    data: { layer: "knowledge", status: "active", kind: "decision" },
  });
  await db.ops.unsafeGraph.createEdge({
    sourceNodeId: focusId,
    targetNodeId: relatedId,
    type: GRAPH_EDGE.SUPPORTS,
  });

  const result = await brain({
    query: {
      namespace,
      focusNodeId: focusId,
      includeRelated: "true",
      includeSimilar: "true",
      minSimilarity: "0.5",
    },
  }, { ops: db.ops } as any);
  const data = result.data as any;

  assertEquals(data.related.length, 1);
  assertEquals(data.related[0].node.id, relatedId);
  assertEquals(data.related[0].direction, "out");
  assertEquals(data.similar.length, 1);
  assertEquals(data.similar[0].node.id, similarId);
  assertEquals(Boolean(data.matches[relatedId].relationDistance), true);
  assertEquals(typeof data.matches[similarId].similarity, "number");
});

Deno.test("admin brain reports semantic unavailable without failing", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-brain-no-embedding";

  await db.ops.unsafeGraph.createNode({
    id: crypto.randomUUID(),
    namespace,
    type: "brain_node",
    name: "Fallback",
    content: "Semantic search is unavailable.",
    data: { layer: "knowledge", status: "active", kind: "fact" },
  });

  const result = await brain({
    query: { namespace, search: "fallback", searchMode: "semantic" },
  }, {
    ops: db.ops,
    embeddings: {
      embed: () => Promise.reject(new Error("No embedding config")),
    },
  } as any);
  const data = result.data as any;

  assertEquals(data.nodes.length, 0);
  assertEquals(data.semantic.available, false);
  assertEquals(data.semantic.error, "No embedding config");
});
