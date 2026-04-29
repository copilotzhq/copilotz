/**
 * Skunk Works — Multi-agent development team example.
 *
 * A 4-person compass team (Lead/Spark/Forge/Lens) that collaborates
 * on any task. West (Lead) is the default entry point and synthesizer.
 *
 * Run with:
 *   OPENAI_KEY=<key> deno run -A --env-file=.env lib/copilotz/examples/skunk-works.ts
 */

import { createCopilotz } from "../index.ts";

const OPENAI_KEY = Deno.env.get("OPENAI_KEY") ||
  Deno.env.get("OPENAI_API_KEY");
if (!OPENAI_KEY) {
  console.error(
    "❌  OPENAI_KEY is not set.\n   Run with: OPENAI_KEY=<key> deno run -A lib/copilotz/examples/skunk-works.ts",
  );
  Deno.exit(1);
}

const copilotz = await createCopilotz({
  resources: {
    preset: ["skunk-works"],
  },
  multiAgent: {
    enabled: true,
    maxAgentTurns: 10,
    includeTargetContext: true,
  },
  agent: {
    llmOptions: {
      provider: "minimax",
      model: "MiniMax-M2.7",
      limitEstimatedInputTokens: 100000,
      maxTokens: 10000,
    },
  },
  rag: {
    enabled: true,
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    },
    chunking: {
      strategy: "fixed",
      chunkSize: 512,
      chunkOverlap: 50,
    },
  },
  security: {
    resolveLLMRuntimeConfig: async ({ provider }) => {
      switch (provider) {
        case "minimax":
          return {
            apiKey: Deno.env.get("MINIMAX_KEY"),
          };
        case "openai":
          return {
            apiKey: Deno.env.get("OPENAI_API_KEY"),
          };
        default:
          return {
            apiKey: Deno.env.get("LLM_API_KEY"),
          };
      }
    },
  },
  dbConfig: { url: "file://./data/copilotz.db" },
});

const session = copilotz.start({
  thread: {
    externalId: crypto.randomUUID(),
  },
  content:
    "Hi team. I'd like you to tackle the Tihany conjecture from Erdős's open problems. It states that for every integer k ≥ 2, there exists a set A of natural numbers such that every sufficiently large integer can be represented as the sum of exactly k elements from A, and this representation is unique. Work together to explore whether this is true, what's known, and whether a proof strategy seems viable.",
  sender: { type: "user", name: "User" },
});

await session.closed;
await copilotz.shutdown();
