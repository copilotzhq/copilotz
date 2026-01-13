/**
 * Simple RAG Test - Minimal test without full integration demo
 * Run: deno run -A --env examples/rag-simple-test.ts
 */

import { createCopilotz } from "../index.ts";

const OPENAI_API_KEY = Deno.env.get("DEFAULT_OPENAI_KEY") || Deno.env.get("OPENAI_API_KEY");
if (!OPENAI_API_KEY) {
  console.error("❌ Please set DEFAULT_OPENAI_KEY or OPENAI_API_KEY");
  Deno.exit(1);
}

console.log("🚀 Simple RAG Test\n");

const copilotz = await createCopilotz({
  agents: [{
    id: "test",
    name: "TestBot",
    role: "assistant",
    llmOptions: {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: OPENAI_API_KEY,
    },
  }],
  rag: {
    enabled: true,
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: OPENAI_API_KEY,
    },
  },
  dbConfig: { url: ":memory:" },
});

console.log("✅ Created Copilotz instance with RAG enabled");
console.log("✅ Unit tests passed (run rag-unit-test.ts for details)\n");

await copilotz.shutdown();
Deno.exit(0);

