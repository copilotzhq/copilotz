/**
 * RAG Unit Test - Tests RAG components directly (no LLM calls)
 * 
 * This test verifies:
 * 1. Database operations (documents, chunks)
 * 2. Embedding generation
 * 3. Vector search
 * 4. Chunking utilities
 * 
 * Prerequisites:
 * - Set OPENAI_API_KEY environment variable
 * 
 * Run: deno run -A examples/rag-unit-test.ts
 */

import { createDatabase } from "../database/index.ts";
import { embed } from "../connectors/embeddings/index.ts";
import { chunkText } from "../utils/chunker.ts";
import type { EmbeddingConfig } from "../interfaces/index.ts";

// Check for API key
const OPENAI_API_KEY = Deno.env.get("DEFAULT_OPENAI_KEY") || Deno.env.get("OPENAI_API_KEY");
if (!OPENAI_API_KEY) {
  console.error("❌ Please set DEFAULT_OPENAI_KEY or OPENAI_API_KEY environment variable");
  Deno.exit(1);
}

const embeddingConfig: EmbeddingConfig = {
  provider: "openai",
  model: "text-embedding-3-small",
  apiKey: OPENAI_API_KEY,
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log("🧪 RAG Unit Tests\n");
  
  // ========================================
  // Test 1: Chunking
  // ========================================
  console.log("📝 Test 1: Text Chunking\n");
  
  const testText = `
# Introduction

This is the first paragraph with some content.

This is the second paragraph with different content.

## Section Two

Here is another section with more detailed information.
This continues on multiple lines.

And this is a final paragraph.
  `.trim();
  
  const chunks = chunkText(testText, {
    strategy: "paragraph",
    chunkSize: 100,
    chunkOverlap: 20,
  });
  
  assert(chunks.length > 0, `Created ${chunks.length} chunks from text`);
  assert(chunks.every(c => c.content.length > 0), "All chunks have content");
  assert(chunks.every(c => typeof c.metadata.tokenCount === "number"), "All chunks have token counts");
  console.log();
  
  // ========================================
  // Test 2: Embeddings
  // ========================================
  console.log("🔮 Test 2: Embedding Generation\n");
  
  const testTexts = [
    "What is the return policy?",
    "How do I get a refund?",
    "Where is my order?",
  ];
  
  const embeddingResult = await embed(testTexts, embeddingConfig);
  
  assert(embeddingResult.embeddings.length === 3, `Generated ${embeddingResult.embeddings.length} embeddings`);
  assert(embeddingResult.embeddings[0]!.length === 1536, `Embedding dimension is 1536`);
  assert(embeddingResult.model === "text-embedding-3-small", `Model is text-embedding-3-small`);
  console.log();
  
  // ========================================
  // Test 3: Database Operations
  // ========================================
  console.log("💾 Test 3: Database Operations\n");
  
  const dbPath = `${Deno.cwd()}/rag-unit-test.db`;
  
  // Clean up previous test database if exists
  try {
    await Deno.remove(dbPath, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  
  const db = await createDatabase({
    url: `file://${dbPath}`,
  });
  
  const ops = db.ops;
  
  // Test document creation
  const doc = await ops.createDocument({
    id: crypto.randomUUID(),
    namespace: "test",
    sourceType: "text",
    title: "Test Document",
    contentHash: "abc123",
    status: "pending",
    metadata: { test: true },
  }) as { id: string; namespace: string; status: string };
  
  assert(doc.id.length > 0, `Created document with ID: ${doc.id.substring(0, 8)}...`);
  assert(doc.namespace === "test", "Document has correct namespace");
  
  // Test duplicate detection (hash, namespace)
  const existingDoc = await ops.getDocumentByHash("abc123", "test");
  assert(existingDoc?.id === doc.id, "Found document by content hash");
  
  // Test chunk creation with embedding
  const testEmbedding = embeddingResult.embeddings[0]!;
  
  const createdChunks = await ops.createChunks([
    {
      id: crypto.randomUUID(),
      documentId: doc.id,
      namespace: "test",
      chunkIndex: 0,
      content: "What is our return policy? We offer 30-day returns.",
      tokenCount: 12,
      embedding: testEmbedding,
      startPosition: 0,
      endPosition: 50,
    },
    {
      id: crypto.randomUUID(),
      documentId: doc.id,
      namespace: "test",
      chunkIndex: 1,
      content: "Shipping takes 5-7 business days for standard delivery.",
      tokenCount: 10,
      embedding: embeddingResult.embeddings[1]!,
      startPosition: 51,
      endPosition: 100,
    },
  ]);
  
  assert(createdChunks.length === 2, `Created ${createdChunks.length} chunks`);
  
  // Update document status (id, status, errorMessage?, chunkCount?)
  await ops.updateDocumentStatus(doc.id, "indexed", undefined, 2);
  
  // Test vector search
  const searchEmbedding = await embed(["return policy refund"], embeddingConfig);
  
  const searchResults = await ops.searchChunks({
    namespaces: ["test"],
    embedding: searchEmbedding.embeddings[0]!,
    limit: 5,
    threshold: 0.3,
  });
  
  assert(searchResults.length > 0, `Found ${searchResults.length} search results`);
  assert(searchResults[0]!.similarity > 0, `Top result has similarity: ${searchResults[0]!.similarity.toFixed(3)}`);
  assert(searchResults[0]!.content.includes("return"), "Top result contains 'return'");
  
  // Test namespace stats
  const allStats = await ops.getNamespaceStats();
  const stats = allStats.find(s => s.namespace === "test");
  assert(stats !== undefined, "Found stats for 'test' namespace");
  assert(stats!.documentCount === 1, `Namespace has ${stats!.documentCount} document`);
  assert(stats!.chunkCount === 2, `Namespace has ${stats!.chunkCount} chunks`);
  
  // Test document deletion (cascades to chunks via foreign key)
  await ops.deleteDocument(doc.id);
  
  // Verify document is deleted
  const deletedDoc = await ops.getDocumentById(doc.id);
  assert(deletedDoc === undefined, "Document was deleted");
  
  // Verify chunks are cascade deleted (via namespace stats)
  const afterDeleteStats = await ops.getNamespaceStats();
  const testNsAfter = afterDeleteStats.find(s => s.namespace === "test");
  assert(!testNsAfter || testNsAfter.documentCount === 0, "Chunks were cascade deleted");
  
  console.log();
  
  // ========================================
  // Test 4: Similarity Scores
  // ========================================
  console.log("📊 Test 4: Similarity Verification\n");
  
  // Create embeddings for similar and dissimilar texts
  const similarityTest = await embed([
    "How do I return a product?",     // Query
    "Return policy and refund process", // Similar
    "Weather forecast for tomorrow",    // Dissimilar
  ], embeddingConfig);
  
  const query = similarityTest.embeddings[0]!;
  const similar = similarityTest.embeddings[1]!;
  const dissimilar = similarityTest.embeddings[2]!;
  
  // Calculate cosine similarity
  function cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
  
  const similarScore = cosineSimilarity(query, similar);
  const dissimilarScore = cosineSimilarity(query, dissimilar);
  
  console.log(`  Similar text score: ${similarScore.toFixed(4)}`);
  console.log(`  Dissimilar text score: ${dissimilarScore.toFixed(4)}`);
  
  assert(similarScore > dissimilarScore, "Similar text has higher score than dissimilar");
  assert(similarScore > 0.4, `Similar text score is reasonably high (> 0.4): ${similarScore.toFixed(2)}`);
  assert(dissimilarScore < 0.3, `Dissimilar text score is low (< 0.3): ${dissimilarScore.toFixed(2)}`);
  
  console.log();
  
  // ========================================
  // Summary
  // ========================================
  console.log("═".repeat(40));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  
  const exitCode = failed > 0 ? 1 : 0;
  
  if (failed > 0) {
    console.log("❌ Some tests failed!");
  } else {
    console.log("✅ All tests passed!");
  }
  
  // Cleanup database files
  try {
    await Deno.remove(dbPath, { recursive: true });
    console.log(`🧹 Cleaned up test database`);
  } catch {
    // Ignore
  }
  
  // Exit explicitly to close database connections
  Deno.exit(exitCode);
}

runTests().catch((err) => {
  console.error(err);
  Deno.exit(1);
});

