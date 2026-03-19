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
const API_KEY = Deno.env.get("API_KEY");
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
  agents: [
    {
      id: "assistant",
      name: "Assistant",
      role: "assistant",
      instructions: "You are a helpful, concise assistant.",
      llmOptions: {
        provider: "minimax",
        model: "MiniMax-M2.7",
        apiKey: API_KEY,
        outputReasoning: false,
      },
    },
  ],
  // PGLite in-memory database — no external DB needed
  dbConfig: { url: ":memory:" },
  // Enable streaming so we can receive TOKEN events
  stream: true,
});

// ---------------------------------------------------------------------------
// 3. Send a message and collect the response via the events iterator
// ---------------------------------------------------------------------------
console.log("👤 User: What is the capital of France?\n");
console.log("🤖 Assistant: ");

const result = await copilotz.run({
  content: "What is the capital of France?",
  sender: { type: "user", name: "User" },
});

// Iterate over streaming events and print each token as it arrives
let isThinking = false;

for await (const event of result.events) {
  if (event.type === "TOKEN") {
    const payload = event.payload as { token?: string, isReasoning?: boolean };
    const token = payload.token ?? "";
    const isReasoning = !!payload.isReasoning;

    if (isReasoning && !isThinking) {
      await Deno.stdout.write(new TextEncoder().encode("💭 "));
      isThinking = true;
    } else if (!isReasoning && isThinking) {
      await Deno.stdout.write(new TextEncoder().encode("\n\n"));
      isThinking = false;
    }

    await Deno.stdout.write(new TextEncoder().encode(token));
  }
}

// Wait for all background processing to finish
await result.done;

console.log("\n\n✅ Done!");

// ---------------------------------------------------------------------------
// 4. Clean up
// ---------------------------------------------------------------------------
await copilotz.shutdown();
