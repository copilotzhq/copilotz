/**
 * Entity Extraction Test
 * Tests the entity extraction pipeline
 */

import { createDatabase } from "../database/index.ts";
import { embed } from "../connectors/embeddings/index.ts";
import { generateId } from "../database/schemas/index.ts";
import { resolveNamespace } from "../interfaces/index.ts";

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
    toContain: (expected: unknown) => {
      if (Array.isArray(actual)) {
        if (!actual.includes(expected)) {
          throw new Error(`Expected array to contain "${expected}"`);
        }
      } else if (typeof actual === "string") {
        if (!actual.includes(expected as string)) {
          throw new Error(`Expected "${actual}" to contain "${expected}"`);
        }
      } else {
        throw new Error(`Expected string or array, got ${typeof actual}`);
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
  console.log("\n🧪 Entity Extraction Tests\n");

  // Create test database
  const db = await createDatabase({
    url: "file://./entity-test.db",
  });
  const ops = db.ops;

  const embeddingConfig = {
    provider: "openai" as const,
    model: "text-embedding-3-small",
    apiKey: DEFAULT_OPENAI_KEY,
    dimensions: 1536,
  };

  // Test 1: Namespace resolution
  await test("Resolve thread namespace", () => {
    const ns = resolveNamespace("thread", { threadId: "thread-123" });
    expect(ns).toBe("thread:thread-123");
  })();

  await test("Resolve agent namespace", () => {
    const ns = resolveNamespace("agent", { agentId: "agent-456" });
    expect(ns).toBe("agent:agent-456");
  })();

  await test("Resolve global namespace", () => {
    const ns = resolveNamespace("global", {});
    expect(ns).toBe("global");
  })();

  await test("Resolve namespace with prefix", () => {
    const ns = resolveNamespace("agent", { agentId: "bot-1" }, "myapp");
    expect(ns).toBe("myapp:agent:bot-1");
  })();

  // Test 2: Create entity nodes manually
  const entityNamespace = "test:entities";
  
  await test("Create entity node", async () => {
    const entityText = "OpenAI: A leading AI research company";
    const embeddingResult = await embed([entityText], embeddingConfig);
    
    const node = await ops.createNode({
      namespace: entityNamespace,
      type: "concept",
      name: "OpenAI",
      content: "A leading AI research company",
      embedding: embeddingResult.embeddings[0],
      data: {
        aliases: ["OpenAI"],
        mentionCount: 1,
      },
      sourceType: "extraction",
      sourceId: "msg-001",
    });
    
    expect(node.id).toBeDefined();
    expect(node.type).toBe("concept");
    expect(node.name).toBe("OpenAI");
  })();

  // Test 3: Search for similar entity
  await test("Find similar entity by embedding", async () => {
    const queryText = "OpenAI company";
    const embeddingResult = await embed([queryText], embeddingConfig);
    
    const results = await ops.searchNodes({
      embedding: embeddingResult.embeddings[0],
      namespaces: [entityNamespace],
      nodeTypes: ["concept"],
      limit: 5,
      minSimilarity: 0.7,
    });
    
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node.name).toBe("OpenAI");
    console.log(`   Similarity: ${results[0].similarity?.toFixed(3)}`);
  })();

  // Test 4: Create second similar entity
  await test("Create similar entity for dedup test", async () => {
    const entityText = "Open AI: Artificial intelligence research lab";
    const embeddingResult = await embed([entityText], embeddingConfig);
    
    const node = await ops.createNode({
      namespace: entityNamespace,
      type: "concept",
      name: "Open AI",
      content: "Artificial intelligence research lab",
      embedding: embeddingResult.embeddings[0],
      data: {
        aliases: ["Open AI"],
        mentionCount: 1,
      },
      sourceType: "extraction",
      sourceId: "msg-002",
    });
    
    expect(node.id).toBeDefined();
  })();

  // Test 5: Verify high similarity between variants
  await test("Similar entities have high similarity score", async () => {
    const queryText = "OpenAI";
    const embeddingResult = await embed([queryText], embeddingConfig);
    
    const results = await ops.searchNodes({
      embedding: embeddingResult.embeddings[0],
      namespaces: [entityNamespace],
      nodeTypes: ["concept"],
      limit: 5,
      minSimilarity: 0.5,
    });
    
    expect(results.length).toBe(2);
    // Both should have high similarity
    expect(results[0].similarity ?? 0).toBeGreaterThan(0.7);
    expect(results[1].similarity ?? 0).toBeGreaterThan(0.5);
    console.log(`   First: ${results[0].node.name} (${results[0].similarity?.toFixed(3)})`);
    console.log(`   Second: ${results[1].node.name} (${results[1].similarity?.toFixed(3)})`);
  })();

  // Test 6: Create MENTIONS edge
  await test("Create MENTIONS edge", async () => {
    // Create a message node first
    const messageNode = await ops.createNode({
      namespace: "thread-test",
      type: "message",
      name: "user:2024-01-15",
      content: "Let's use OpenAI for our project",
      data: { senderId: "user-1" },
      sourceType: "thread",
      sourceId: "thread-test",
    });

    // Get the OpenAI entity
    const entityNodes = await ops.getNodesByNamespace(entityNamespace, "concept");
    const openAIEntity = entityNodes.find(n => n.name === "OpenAI");
    expect(openAIEntity).toBeDefined();

    // Create MENTIONS edge
    const edge = await ops.createEdge({
      sourceNodeId: messageNode.id as string,
      targetNodeId: openAIEntity!.id as string,
      type: "MENTIONS",
      data: { extractedName: "OpenAI" },
    });

    expect(edge.id).toBeDefined();
    expect(edge.type).toBe("MENTIONS");
  })();

  // Test 7: Update entity with alias
  await test("Update entity with new alias", async () => {
    const entityNodes = await ops.getNodesByNamespace(entityNamespace, "concept");
    const openAIEntity = entityNodes.find(n => n.name === "OpenAI");
    expect(openAIEntity).toBeDefined();

    const data = openAIEntity!.data as Record<string, unknown>;
    const aliases = (data.aliases as string[]) ?? [];
    
    await ops.updateNode(openAIEntity!.id as string, {
      data: {
        ...data,
        aliases: [...aliases, "OpenAI Inc"],
        mentionCount: ((data.mentionCount as number) ?? 0) + 1,
      },
    });

    // Verify update
    const updated = await ops.getNodeById(openAIEntity!.id as string);
    const updatedData = updated?.data as Record<string, unknown>;
    const updatedAliases = updatedData?.aliases as string[];
    
    expect(updatedAliases.length).toBe(2);
    expect(updatedAliases).toContain("OpenAI Inc");
  })();

  // Test 8: Find entity by traversing MENTIONS edge
  await test("Find entities mentioned by message", async () => {
    const messageNodes = await ops.getNodesByNamespace("thread-test", "message");
    expect(messageNodes.length).toBeGreaterThan(0);
    
    const message = messageNodes[0];
    const edges = await ops.getEdgesForNode(message.id as string, "out", ["MENTIONS"]);
    
    expect(edges.length).toBe(1);
    expect(edges[0].type).toBe("MENTIONS");
    
    // Get the mentioned entity
    const entityNode = await ops.getNodeById(edges[0].targetNodeId);
    expect(entityNode?.name).toBe("OpenAI");
  })();

  // Test 9: Create RELATED_TO edge between similar entities
  await test("Create RELATED_TO edge for similar but different entities", async () => {
    const entityNodes = await ops.getNodesByNamespace(entityNamespace, "concept");
    const openAI = entityNodes.find(n => n.name === "OpenAI");
    const openAIVariant = entityNodes.find(n => n.name === "Open AI");
    
    expect(openAI).toBeDefined();
    expect(openAIVariant).toBeDefined();

    const edge = await ops.createEdge({
      sourceNodeId: openAIVariant!.id as string,
      targetNodeId: openAI!.id as string,
      type: "RELATED_TO",
      data: { similarity: 0.92 },
    });

    expect(edge.type).toBe("RELATED_TO");
  })();

  // Test 10: Traverse related entities
  await test("Traverse related entities", async () => {
    const entityNodes = await ops.getNodesByNamespace(entityNamespace, "concept");
    const openAI = entityNodes.find(n => n.name === "OpenAI");
    
    const relatedNodes = await ops.findRelatedNodes(openAI!.id as string, 1);
    
    // Should find the "Open AI" variant
    expect(relatedNodes.length).toBeGreaterThan(0);
    console.log(`   Found ${relatedNodes.length} related nodes`);
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

