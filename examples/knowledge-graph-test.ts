/**
 * Knowledge Graph Unit Test
 * 
 * Tests the unified nodes/edges schema and graph operations.
 */

import { createDatabase } from "../database/index.ts";

const DEFAULT_OPENAI_KEY = Deno.env.get("DEFAULT_OPENAI_KEY") || Deno.env.get("OPENAI_API_KEY");

async function getEmbedding(text: string): Promise<number[]> {
  if (!DEFAULT_OPENAI_KEY) {
    throw new Error("OPENAI_API_KEY or DEFAULT_OPENAI_KEY required");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DEFAULT_OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });

  const data = await response.json();
  return data.data[0].embedding;
}

async function runTests() {
  console.log("\n🧪 Knowledge Graph Unit Tests\n");
  console.log("════════════════════════════════════════\n");

  const db = await createDatabase({ url: "file://./kg-test.db" });
  const { ops } = db;

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, message: string) => {
    if (condition) {
      console.log(`  ✅ ${message}`);
      passed++;
    } else {
      console.log(`  ❌ ${message}`);
      failed++;
    }
  };

  try {
    // ========================================
    // Test 1: Create Nodes
    // ========================================
    console.log("📊 Test 1: Node CRUD Operations\n");

    // Create an entity node
    const entityNode = await ops.createNode({
      namespace: "test-thread-1",
      type: "entity",
      name: "PostgreSQL",
      content: "PostgreSQL is a powerful open-source relational database.",
      data: { category: "database", version: "16" },
      sourceType: "message",
      sourceId: "msg-001",
    });

    assert(!!entityNode.id, "Entity node created with ID");
    assert(entityNode.namespace === "test-thread-1", "Node has correct namespace");
    assert(entityNode.type === "entity", "Node has correct type");
    assert(entityNode.name === "PostgreSQL", "Node has correct name");

    // Create a chunk node with embedding
    console.log("\n  Generating embedding...");
    const embedding = await getEmbedding("Vector databases enable semantic search");
    
    const chunkNode = await ops.createNode({
      namespace: "test-thread-1",
      type: "chunk",
      name: "doc-1:chunk-0",
      content: "Vector databases enable semantic search by comparing embedding vectors.",
      embedding,
      data: { documentId: "doc-1", chunkIndex: 0 },
      sourceType: "document",
      sourceId: "doc-001",
    });

    assert(!!chunkNode.id, "Chunk node created with embedding");

    // Create more nodes for relationship testing
    const decisionNode = await ops.createNode({
      namespace: "test-thread-1",
      type: "decision",
      name: "Use pgvector",
      content: "Decided to use pgvector for vector similarity search.",
      data: { confidence: "high" },
      sourceType: "message",
      sourceId: "msg-002",
    });

    assert(!!decisionNode.id, "Decision node created");

    // ========================================
    // Test 2: Create Edges
    // ========================================
    console.log("\n📊 Test 2: Edge CRUD Operations\n");

    // Create relationship: entity -> decision (INFLUENCED)
    const edge1 = await ops.createEdge({
      sourceNodeId: entityNode.id as string,
      targetNodeId: decisionNode.id as string,
      type: "INFLUENCED",
      data: { reason: "PostgreSQL supports pgvector extension" },
      weight: 0.9,
    });

    assert(!!edge1.id, "Edge created between entity and decision");
    assert(edge1.type === "INFLUENCED", "Edge has correct type");

    // Create relationship: decision -> chunk (MENTIONED_IN)
    const edge2 = await ops.createEdge({
      sourceNodeId: decisionNode.id as string,
      targetNodeId: chunkNode.id as string,
      type: "RELATES_TO",
      weight: 0.8,
    });

    assert(!!edge2.id, "Second edge created");

    // Get edges for a node
    const outEdges = await ops.getEdgesForNode(entityNode.id as string, "out");
    assert(outEdges.length === 1, "Found 1 outgoing edge from entity");

    const allEdges = await ops.getEdgesForNode(decisionNode.id as string, "both");
    assert(allEdges.length === 2, "Decision node has 2 edges (in + out)");

    // ========================================
    // Test 3: Vector Search
    // ========================================
    console.log("\n📊 Test 3: Vector Search\n");

    // Create another chunk with different content
    const embedding2 = await getEmbedding("Relational databases use SQL for queries");
    await ops.createNode({
      namespace: "test-thread-1",
      type: "chunk",
      name: "doc-1:chunk-1",
      content: "Relational databases like PostgreSQL use SQL for queries.",
      embedding: embedding2,
      data: { documentId: "doc-1", chunkIndex: 1 },
      sourceType: "document",
      sourceId: "doc-001",
    });

    // Search for semantic content
    const searchEmbedding = await getEmbedding("How do vector databases work?");
    const searchResults = await ops.searchNodes({
      embedding: searchEmbedding,
      namespaces: ["test-thread-1"],
      nodeTypes: ["chunk"],
      limit: 5,
      minSimilarity: 0.3,
    });

    assert(searchResults.length > 0, `Found ${searchResults.length} nodes via vector search`);
    assert(searchResults[0].similarity! > 0.3, `Top result similarity: ${searchResults[0].similarity?.toFixed(3)}`);

    // ========================================
    // Test 4: Graph Traversal
    // ========================================
    console.log("\n📊 Test 4: Graph Traversal\n");

    const traversalResult = await ops.traverseGraph(entityNode.id as string, undefined, 2);
    
    assert(traversalResult.nodes.length >= 2, `Traversed to ${traversalResult.nodes.length} nodes`);
    assert(traversalResult.edges.length >= 1, `Found ${traversalResult.edges.length} edges in traversal`);

    // Find related nodes
    const relatedNodes = await ops.findRelatedNodes(entityNode.id as string, 2);
    assert(relatedNodes.length >= 1, `Found ${relatedNodes.length} related nodes`);

    // ========================================
    // Test 5: Get Nodes by Namespace
    // ========================================
    console.log("\n📊 Test 5: Namespace Queries\n");

    const allNodes = await ops.getNodesByNamespace("test-thread-1");
    assert(allNodes.length >= 4, `Found ${allNodes.length} nodes in namespace`);

    const entityNodes = await ops.getNodesByNamespace("test-thread-1", "entity");
    assert(entityNodes.length === 1, "Found 1 entity node");

    const chunkNodes = await ops.getNodesByNamespace("test-thread-1", "chunk");
    assert(chunkNodes.length === 2, "Found 2 chunk nodes");

    // ========================================
    // Test 6: Update Node
    // ========================================
    console.log("\n📊 Test 6: Update Operations\n");

    const updatedNode = await ops.updateNode(entityNode.id as string, {
      data: { category: "database", version: "17", updated: true },
    });

    assert(!!updatedNode, "Node updated successfully");
    const nodeData = updatedNode?.data as Record<string, unknown>;
    assert(nodeData?.version === "17", "Node data updated correctly");

    // ========================================
    // Test 7: Delete Operations
    // ========================================
    console.log("\n📊 Test 7: Delete Operations\n");

    // Delete an edge
    await ops.deleteEdge(edge2.id as string);
    const remainingEdges = await ops.getEdgesForNode(decisionNode.id as string, "both");
    assert(remainingEdges.length === 1, "Edge deleted, 1 remaining");

    // Delete a node (edges should cascade)
    const nodeToDelete = await ops.createNode({
      namespace: "test-thread-1",
      type: "temp",
      name: "Temporary Node",
    });
    await ops.deleteNode(nodeToDelete.id as string);
    const deletedNode = await ops.getNodeById(nodeToDelete.id as string);
    assert(!deletedNode, "Node deleted successfully");

    // ========================================
    // Results
    // ========================================
    console.log("\n════════════════════════════════════════");
    console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

    if (failed === 0) {
      console.log("✅ All tests passed!\n");
    } else {
      console.log("❌ Some tests failed\n");
    }

  } catch (error) {
    console.error("Test error:", error);
    failed++;
  } finally {
    // Cleanup
    console.log("🧹 Cleaning up test database...");
    await db.close();
    try {
      await Deno.remove("./kg-test.db", { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
    console.log("Done.\n");
    Deno.exit(failed > 0 ? 1 : 0);
  }
}

runTests();

