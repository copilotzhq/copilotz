/**
 * RAG Demo - Tests the RAG implementation
 * 
 * This example demonstrates:
 * 1. Creating a Copilotz instance with RAG enabled
 * 2. Ingesting documents (text content)
 * 3. Searching the knowledge base via tool
 * 4. Auto-injection mode
 * 
 * Prerequisites:
 * - Set OPENAI_API_KEY environment variable
 * 
 * Run: deno run -A examples/rag-demo.ts
 */

import { createCopilotz } from "../index.ts";
import type { AgentConfig } from "../index.ts";

// Check for API key
const OPENAI_API_KEY = Deno.env.get("DEFAULT_OPENAI_KEY") || Deno.env.get("OPENAI_API_KEY");
if (!OPENAI_API_KEY) {
  console.error("❌ Please set DEFAULT_OPENAI_KEY or OPENAI_API_KEY environment variable");
  Deno.exit(1);
}

console.log("🚀 RAG Demo Starting...\n");

// ========================================
// Agent Configurations
// ========================================

// Tool-based RAG agent (explicitly calls search_knowledge)
const toolAgent: AgentConfig = {
  id: "tool-agent",
  name: "ToolBot",
  role: "assistant",
  instructions: `You are a helpful assistant with access to a knowledge base.
Use search_knowledge to find relevant information before answering questions.
When you find relevant information, cite the source.
If you can't find information, say so honestly.`,
  allowedTools: ["search_knowledge", "ingest_document", "list_namespaces"],
  ragOptions: {
    mode: "tool",
    namespaces: ["demo"],
    ingestNamespace: "demo",
  },
  llmOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: OPENAI_API_KEY,
  },
};

// Auto-inject RAG agent (context injected automatically)
const autoAgent: AgentConfig = {
  id: "auto-agent",
  name: "AutoBot",
  role: "assistant",
  instructions: `You are a helpful FAQ assistant.
Answer questions based on the provided knowledge base context.
If the context doesn't contain relevant information, say so.`,
  ragOptions: {
    mode: "auto",
    namespaces: ["demo"],
    autoInjectLimit: 3,
  },
  llmOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: OPENAI_API_KEY,
  },
};

// ========================================
// Sample Documents to Ingest
// ========================================

const sampleDocuments = [
  {
    title: "Company Return Policy",
    content: `
# Return Policy

Our company offers a 30-day return policy for all products.

## Eligibility
- Items must be unused and in original packaging
- Receipt or proof of purchase is required
- Sale items are final sale and cannot be returned

## Process
1. Contact customer support to initiate a return
2. Receive a return authorization number
3. Ship the item back using the provided label
4. Refund processed within 5-7 business days

## Refund Methods
- Original payment method (credit card, PayPal)
- Store credit (10% bonus if chosen)
- Exchange for different item
    `,
  },
  {
    title: "Shipping Information",
    content: `
# Shipping Guide

## Domestic Shipping
- Standard: 5-7 business days ($5.99)
- Express: 2-3 business days ($12.99)
- Next Day: 1 business day ($24.99)

## Free Shipping
Orders over $50 qualify for free standard shipping.

## International Shipping
We ship to over 100 countries. International shipping takes 10-15 business days.
Additional customs fees may apply.

## Tracking
All orders include tracking. Check your email for tracking number after shipment.
    `,
  },
  {
    title: "Product Warranty",
    content: `
# Warranty Information

All products come with a 1-year manufacturer warranty.

## Coverage
- Manufacturing defects
- Faulty materials
- Electrical issues (for electronics)

## Not Covered
- Physical damage from drops or accidents
- Water damage
- Normal wear and tear
- Modifications or unauthorized repairs

## Extended Warranty
Purchase extended warranty for 2 additional years of coverage at 15% of product price.
    `,
  },
];

// ========================================
// Test Runner
// ========================================

async function runTest() {
  const dbPath = `${Deno.cwd()}/rag-demo.db`;
  
  console.log("📦 Creating Copilotz instance with RAG...\n");
  
  const copilotz = await createCopilotz({
    agents: [toolAgent, autoAgent],
    dbConfig: { url: `file://${dbPath}` },
    stream: true,
    rag: {
      enabled: true,
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: OPENAI_API_KEY,
      },
      chunking: {
        strategy: "paragraph",
        chunkSize: 256,
        chunkOverlap: 50,
      },
      retrieval: {
        defaultLimit: 5,
        similarityThreshold: 0.5,
      },
      defaultNamespace: "demo",
    },
  });

  // ----------------------------------------
  // Test 1: Ingest Documents via Direct API
  // ----------------------------------------
  console.log("📝 Test 1: Ingesting sample documents...\n");
  
  for (const doc of sampleDocuments) {
    console.log(`  Ingesting: ${doc.title}...`);
    
    // For direct testing, we'll use the run method with ingest_document tool
    const result = await copilotz.run({
      content: `Please ingest this document titled "${doc.title}" into the demo namespace:\n\n${doc.content}`,
      sender: { type: "user", name: "Admin" },
      thread: { externalId: "rag-demo-ingest", participants: ["ToolBot"] },
    });

    // Collect responses from the events stream
    for await (const event of result.events) {
      if (event.type === "NEW_MESSAGE") {
        const payload = event.payload as { sender?: { type?: string }; content?: unknown };
        if (payload.sender?.type === "agent" && typeof payload.content === "string" && payload.content.length > 0) {
          console.log(`  ✅ ${payload.content.substring(0, 100)}...`);
        }
      }
    }
  }
  
  console.log("\n  Waiting for async ingestion to complete...");
  await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for async processing

  console.log("  📊 Documents ingested successfully!\n");

  // ----------------------------------------
  // Test 2: Search via Tool (ToolBot)
  // ----------------------------------------
  console.log("🔍 Test 2: Searching knowledge base via tool...\n");
  
  const searchQuestions = [
    "What is the return policy?",
    "How long does shipping take?",
    "Is water damage covered by warranty?",
  ];
  
  for (const question of searchQuestions) {
    console.log(`  Q: ${question}`);
    
    const result = await copilotz.run({
      content: question,
      sender: { type: "user", name: "User" },
      thread: { externalId: "rag-demo-search", participants: ["ToolBot"] },
    });

    let response = "";
    for await (const event of result.events) {
      if (event.type === "NEW_MESSAGE") {
        const payload = event.payload as { sender?: { type?: string }; content?: unknown };
        if (payload.sender?.type === "agent" && typeof payload.content === "string") {
          response += payload.content;
        }
      }
    }
    console.log(`  A: ${response.substring(0, 200)}...\n`);
  }

  // ----------------------------------------
  // Test 3: Auto-Injection Mode (AutoBot)
  // ----------------------------------------
  console.log("🤖 Test 3: Auto-injection mode...\n");
  
  const autoQuestion = "Can I return a sale item?";
  console.log(`  Q: ${autoQuestion}`);
  
  const autoResult = await copilotz.run({
    content: autoQuestion,
    sender: { type: "user", name: "User" },
    thread: { externalId: "rag-demo-auto", participants: ["AutoBot"] },
  });

  let autoResponse = "";
  for await (const event of autoResult.events) {
    if (event.type === "NEW_MESSAGE") {
      const payload = event.payload as { sender?: { type?: string }; content?: unknown };
      if (payload.sender?.type === "agent" && typeof payload.content === "string") {
        autoResponse += payload.content;
      }
    }
  }
  console.log(`  A: ${autoResponse}\n`);

  // ----------------------------------------
  // Test 4: List Namespaces
  // ----------------------------------------
  console.log("📂 Test 4: Listing namespaces...\n");
  
  const nsResult = await copilotz.run({
    content: "List all namespaces in the knowledge base",
    sender: { type: "user", name: "Admin" },
    thread: { externalId: "rag-demo-ns", participants: ["ToolBot"] },
  });

  for await (const event of nsResult.events) {
    if (event.type === "NEW_MESSAGE") {
      const payload = event.payload as { sender?: { type?: string }; content?: unknown };
      if (payload.sender?.type === "agent" && typeof payload.content === "string" && payload.content.length > 0) {
        console.log(`  ${payload.content}\n`);
      }
    }
  }

  // ----------------------------------------
  // Cleanup
  // ----------------------------------------
  console.log("🧹 Shutting down...\n");
  await copilotz.shutdown();
  
  console.log("✅ RAG Demo Complete!");
  console.log(`   Database saved at: ${dbPath}`);
}

// Run the test
runTest().catch(console.error);

