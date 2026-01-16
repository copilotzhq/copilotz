/**
 * Chunk-as-Node Test
 * Tests that RAG ingestion creates chunk nodes in the graph
 */

import { createDatabase } from "../database/index.ts";
import { embed } from "../connectors/embeddings/index.ts";
import { chunkText } from "../utils/chunker.ts";
import { generateId } from "../database/schemas/index.ts";

const DEFAULT_OPENAI_KEY = Deno.env.get("DEFAULT_OPENAI_KEY") || "";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => Promise<void> | void) {
  return async () => {
    try {
      await fn();
      results.push({ name, passed: true });
      console.log(`✅ ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name, passed: false, error: message });
      console.log(`❌ ${name}: ${message}`);
    }
  };
}

function expect<T>(actual: T) {
  return {
    toBe: (expected: T) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toBeGreaterThan: (expected: number) => {
      if (typeof actual !== "number" || actual <= expected) {
        throw new Error(`Expected ${actual} to be greater than ${expected}`);
      }
    },
    toBeDefined: () => {
      if (actual === undefined || actual === null) {
        throw new Error(`Expected value to be defined, got ${actual}`);
      }
    },
    toHaveLength: (expected: number) => {
      if (!Array.isArray(actual) || actual.length !== expected) {
        throw new Error(
          `Expected array of length ${expected}, got ${Array.isArray(actual) ? actual.length : "non-array"}`
        );
      }
    },
    toBeGreaterThanOrEqual: (expected: number) => {
      if (typeof actual !== "number" || actual < expected) {
        throw new Error(`Expected ${actual} to be >= ${expected}`);
      }
    },
  };
}

async function runTests() {
  console.log("\n🧪 Chunk-as-Node Tests\n");

  // Create test database
  const db = await createDatabase({
    url: "file://./chunk-node-test.db",
  });
  const ops = db.ops;

  const embeddingConfig = {
    provider: "openai" as const,
    model: "text-embedding-3-small",
    apiKey: DEFAULT_OPENAI_KEY,
    dimensions: 1536,
  };

  const namespace = "test-chunks";
  const documentId = generateId();

  // Sample document content - repeated to ensure enough tokens for multiple chunks
  const documentContent = `
Introduction to Machine Learning

Machine learning is a subset of artificial intelligence that focuses on 
building systems that learn from data. Unlike traditional programming where 
rules are explicitly coded, machine learning algorithms identify patterns 
in data and make decisions with minimal human intervention.

Types of Machine Learning

Supervised Learning: The algorithm learns from labeled training data. 
Examples include classification and regression tasks. Common algorithms 
include linear regression, decision trees, and neural networks.

Unsupervised Learning: The algorithm finds patterns in unlabeled data. 
Clustering and dimensionality reduction are typical tasks. K-means and 
PCA are popular techniques in this category.

Reinforcement Learning: The algorithm learns through trial and error, 
receiving rewards or penalties for actions. This approach is used in 
robotics, game playing, and autonomous systems.

Applications of Machine Learning

Machine learning powers many modern applications including image recognition, 
natural language processing, recommendation systems, fraud detection, and 
medical diagnosis. The field continues to advance rapidly with new 
architectures and techniques emerging regularly.

Deep Learning and Neural Networks

Deep learning is a subset of machine learning that uses neural networks 
with many layers. These networks can learn complex patterns from large 
amounts of data. Convolutional neural networks (CNNs) are used for 
image processing, while recurrent neural networks (RNNs) and transformers 
are used for sequential data and natural language processing.

The Future of AI

Artificial intelligence continues to evolve with breakthroughs in 
multimodal learning, reasoning, and general AI capabilities. Large 
language models and foundation models are pushing the boundaries of 
what machines can understand and generate.
  `.trim();

  // Test 1: Chunk content
  await test("Chunk document content", async () => {
    const chunks = chunkText(documentContent, {
      chunkSize: 50,
      chunkOverlap: 10,
      strategy: "fixed",
    });
    expect(chunks.length).toBeGreaterThan(3);
    console.log(`   Generated ${chunks.length} chunks`);
  })();

  // Test 2: Create document record
  await test("Create document record", async () => {
    const doc = await ops.createDocument({
      id: documentId,
      namespace,
      sourceType: "text",
      sourceUri: "test://ml-intro",
      title: "Introduction to Machine Learning",
      mimeType: "text/plain",
      contentHash: "test-hash-" + generateId(),
      status: "processing",
      metadata: {},
    });
    expect(doc.id).toBeDefined();
  })();

  // Test 3: Create chunk nodes with embeddings
  await test("Create chunk nodes with embeddings", async () => {
    const chunks = chunkText(documentContent, {
      chunkSize: 50,
      chunkOverlap: 10,
      strategy: "fixed",
    });

    // Generate embeddings
    const texts = chunks.map((c) => c.content);
    const embeddingResponse = await embed(texts, embeddingConfig);

    // Create nodes for each chunk
    const chunkNodes: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddingResponse.embeddings[i];

      const node = await ops.createNode({
        namespace,
        type: "chunk",
        name: `${documentId}:${i}`,
        content: chunk.content,
        embedding,
        data: {
          documentId,
          chunkIndex: i,
          tokenCount: chunk.metadata.tokenCount,
          startPosition: chunk.metadata.startPosition,
          endPosition: chunk.metadata.endPosition,
          title: "Introduction to Machine Learning",
        },
        sourceType: "document",
        sourceId: documentId,
      });

      chunkNodes.push(node.id as string);
    }

    expect(chunkNodes.length).toBe(chunks.length);
    console.log(`   Created ${chunkNodes.length} chunk nodes`);

    // Create NEXT_CHUNK edges
    for (let i = 0; i < chunkNodes.length - 1; i++) {
      await ops.createEdge({
        sourceNodeId: chunkNodes[i],
        targetNodeId: chunkNodes[i + 1],
        type: "NEXT_CHUNK",
      });
    }
    console.log(`   Created ${chunkNodes.length - 1} NEXT_CHUNK edges`);
  })();

  // Test 4: Search chunks from graph by similarity
  await test("Search chunk nodes by similarity", async () => {
    const query = "What are the different types of machine learning?";
    const queryEmbedding = await embed([query], embeddingConfig);

    const results = await ops.searchChunksFromGraph({
      embedding: queryEmbedding.embeddings[0],
      namespaces: [namespace],
      limit: 3,
      threshold: 0.3,
    });

    expect(results.length).toBeGreaterThan(0);
    console.log(`   Found ${results.length} relevant chunks`);
    console.log(`   Top result similarity: ${results[0].similarity.toFixed(3)}`);
    console.log(`   Top content preview: "${results[0].content.slice(0, 60)}..."`);
  })();

  // Test 5: Verify chunks have correct metadata
  await test("Chunk nodes have correct metadata", async () => {
    const nodes = await ops.getNodesByNamespace(namespace, "chunk");
    expect(nodes.length).toBeGreaterThan(0);

    const firstNode = nodes[0];
    const data = firstNode.data as Record<string, unknown>;

    expect(data.documentId).toBe(documentId);
    expect(typeof data.chunkIndex).toBe(typeof 0);
    expect(firstNode.sourceType).toBe("document");
    expect(firstNode.sourceId).toBe(documentId);
  })();

  // Test 6: Traverse chunk sequence via NEXT_CHUNK edges
  await test("Traverse chunk sequence via edges", async () => {
    const nodes = await ops.getNodesByNamespace(namespace, "chunk");
    const sortedNodes = [...nodes].sort((a, b) => {
      const aIdx = ((a.data as Record<string, unknown>).chunkIndex ?? 0) as number;
      const bIdx = ((b.data as Record<string, unknown>).chunkIndex ?? 0) as number;
      return aIdx - bIdx;
    });

    const firstChunk = sortedNodes[0];
    const edges = await ops.getEdgesForNode(firstChunk.id);
    const outgoingEdges = edges.filter(
      (e) => e.sourceNodeId === firstChunk.id && e.type === "NEXT_CHUNK"
    );

    expect(outgoingEdges.length).toBe(1);

    // Verify it points to chunk index 1
    const targetNode = await ops.getNodeById(outgoingEdges[0].targetNodeId);
    const targetData = targetNode?.data as Record<string, unknown>;
    expect(targetData.chunkIndex).toBe(1);
    console.log(`   First chunk correctly linked to second chunk`);
  })();

  // Test 7: Search returns document metadata
  await test("Search results include document metadata", async () => {
    const query = "reinforcement learning";
    const queryEmbedding = await embed([query], embeddingConfig);

    const results = await ops.searchChunksFromGraph({
      embedding: queryEmbedding.embeddings[0],
      namespaces: [namespace],
      limit: 1,
      threshold: 0.3,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].document?.id).toBe(documentId);
    console.log(`   Document ID in result: ${results[0].document?.id}`);
  })();

  // Test 8: Delete nodes by source
  await test("Delete chunk nodes by document source", async () => {
    await ops.deleteNodesBySource("document", documentId);

    const remainingNodes = await ops.getNodesByNamespace(namespace, "chunk");
    expect(remainingNodes.length).toBe(0);
    console.log(`   All chunk nodes deleted`);
  })();

  // Summary
  console.log("\n" + "=".repeat(50));
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.log("Failed tests:");
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`  ❌ ${r.name}: ${r.error}`);
    });
  }

  // Cleanup
  await db.close();
  Deno.exit(failed > 0 ? 1 : 0);
}

runTests().catch(console.error);

