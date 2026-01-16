/**
 * Message as Node Test
 * 
 * Tests the dual-write pattern where messages are stored
 * in both the messages table AND as nodes in the graph.
 */

import { createDatabase } from "../database/index.ts";

async function runTests() {
  console.log("\n🧪 Message as Node Tests\n");
  console.log("════════════════════════════════════════\n");

  const db = await createDatabase({ url: "file://./msg-node-test.db" });
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
    // Setup: Create a thread
    // ========================================
    console.log("📊 Setup: Create Thread\n");

    const thread = await ops.findOrCreateThread(undefined, {
      name: "Test Thread",
      mode: "immediate",
      status: "active",
      participants: ["user-1", "agent-1"],
    });

    assert(!!thread.id, `Thread created: ${thread.id}`);

    // ========================================
    // Test 1: Create Message (dual-write)
    // ========================================
    console.log("\n📊 Test 1: Create Message (Dual Write)\n");

    const message1 = await ops.createMessage({
      threadId: thread.id as string,
      senderId: "user-1",
      senderType: "user",
      content: "Hello, this is the first message!",
      metadata: { test: true },
    });

    assert(!!message1.id, "Message created in messages table");
    assert(message1.content === "Hello, this is the first message!", "Message content correct");

    // Check if message was also created as a node
    const messageNodes = await ops.getNodesByNamespace(thread.id as string, "message");
    assert(messageNodes.length === 1, "Message node created in graph");
    
    const messageNode = messageNodes[0];
    assert(messageNode.type === "message", "Node type is 'message'");
    assert(messageNode.content === "Hello, this is the first message!", "Node content matches");
    
    const nodeData = messageNode.data as Record<string, unknown>;
    assert(nodeData.senderId === "user-1", "Node has correct senderId");
    assert(nodeData.senderType === "user", "Node has correct senderType");

    // ========================================
    // Test 2: Create Second Message with REPLIED_BY edge
    // ========================================
    console.log("\n📊 Test 2: Sequential Messages with Edges\n");

    const message2 = await ops.createMessage({
      threadId: thread.id as string,
      senderId: "agent-1",
      senderType: "agent",
      content: "Hello! I received your message.",
    });

    assert(!!message2.id, "Second message created");

    // Check for REPLIED_BY edge
    const edges = await ops.getEdgesForNode(messageNodes[0].id as string, "out");
    const repliedByEdge = edges.find(e => e.type === "REPLIED_BY");
    
    assert(!!repliedByEdge, "REPLIED_BY edge created");
    assert(repliedByEdge?.targetNodeId !== messageNodes[0].id, "Edge points to different node");

    // ========================================
    // Test 3: Create Third Message
    // ========================================
    console.log("\n📊 Test 3: Third Message in Chain\n");

    const message3 = await ops.createMessage({
      threadId: thread.id as string,
      senderId: "user-1",
      senderType: "user",
      content: "Thanks for the response!",
    });

    assert(!!message3.id, "Third message created");

    // Check total nodes
    const allMessageNodes = await ops.getNodesByNamespace(thread.id as string, "message");
    assert(allMessageNodes.length === 3, `Created 3 message nodes (got ${allMessageNodes.length})`);

    // ========================================
    // Test 4: Get Message History from Graph
    // ========================================
    console.log("\n📊 Test 4: Get Message History from Graph\n");

    const historyFromGraph = await ops.getMessageHistoryFromGraph(thread.id as string);
    
    assert(historyFromGraph.length === 3, `History has 3 messages (got ${historyFromGraph.length})`);
    assert(historyFromGraph[0].content === "Hello, this is the first message!", "First message correct");
    assert(historyFromGraph[1].content === "Hello! I received your message.", "Second message correct");
    assert(historyFromGraph[2].content === "Thanks for the response!", "Third message correct");

    // Check message properties are preserved
    assert(historyFromGraph[0].senderId === "user-1", "SenderId preserved");
    assert(historyFromGraph[0].senderType === "user", "SenderType preserved");

    // ========================================
    // Test 5: Graph Traversal of Conversation
    // ========================================
    console.log("\n📊 Test 5: Graph Traversal of Conversation\n");

    // Start from first message, traverse REPLIED_BY edges
    const firstNodeId = allMessageNodes.find(n => 
      (n.data as Record<string, unknown>).messageId === message1.id
    )?.id as string;

    const traversal = await ops.traverseGraph(firstNodeId, ["REPLIED_BY"], 3);
    
    assert(traversal.nodes.length === 3, `Traversed to all 3 messages (got ${traversal.nodes.length})`);
    assert(traversal.edges.length === 2, `Found 2 REPLIED_BY edges (got ${traversal.edges.length})`);

    // ========================================
    // Test 6: Compare with Legacy Message History
    // ========================================
    console.log("\n📊 Test 6: Compare with Legacy Message History\n");

    const legacyHistory = await ops.getMessageHistory(thread.id as string, "user-1", 50);
    
    assert(legacyHistory.length === 3, `Legacy history has 3 messages (got ${legacyHistory.length})`);
    
    // Both should have same content
    for (let i = 0; i < 3; i++) {
      const graphMsg = historyFromGraph[i];
      const legacyMsg = legacyHistory[i];
      assert(
        graphMsg.content === legacyMsg.content,
        `Message ${i + 1} content matches between graph and legacy`
      );
    }

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
      await Deno.remove("./msg-node-test.db", { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
    console.log("Done.\n");
    Deno.exit(failed > 0 ? 1 : 0);
  }
}

runTests();

