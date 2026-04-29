/**
 * Hello World — Simplest possible Copilotz example.
 *
 * Demonstrates:
 * - Creating an assistant with the MiniMax-M2.7 model
 * - Sending a message via copilotz.run()
 * - Waiting for the full response via the events async iterator
 *
 * Run with:
 *   API_KEY=<your-minimax-key> deno run -A --env examples/hello-world.ts
 */

import { createCopilotz } from "../index.ts";

// ---------------------------------------------------------------------------
// 1. Read the MiniMax API key from the environment
// ---------------------------------------------------------------------------
const API_KEY = Deno.env.get("API_KEY") || Deno.env.get("MINIMAX_KEY");
if (!API_KEY) {
  console.error(
    "❌  API_KEY is not set.\n   Run with: API_KEY=<key> deno run -A --env examples/hello-world.ts",
  );
  Deno.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Create a Copilotz instance with a single assistant
// ---------------------------------------------------------------------------
const copilotz = await createCopilotz({
  resources: {
    imports: ["skills", "agents.copilotz"],
    preset: ["core", "code"],
  },
  agent: {
    llmOptions: {
      provider: "openai",
      model: "gpt-5.4",
    //   outputReasoning: false,
    },
  },
  security: {
    resolveLLMRuntimeConfig: async ({ provider, agent, config }) => {
      switch (provider) {
        case "minimax":
          return {
            apiKey: API_KEY,
          };
        default:
          return {
            apiKey: Deno.env.get("LLM_API_KEY"),
          };
      }
    },
  },
  // PGLite in-memory database — no external DB needed
  dbConfig: { url: ":memory:" },
});

const session = await copilotz.start({
  "content": "Hey",
  "sender": { type: "user", name: "user" },
  thread: {
    externalId: crypto.randomUUID(),
  },
  
});

await session.closed;
await copilotz.shutdown();
