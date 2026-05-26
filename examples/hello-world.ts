/**
 * Hello World — Simplest possible Copilotz example.
 *
 * Demonstrates:
 * - Creating an assistant with OpenAI GPT-5 through the Responses API
 * - Sending a message via copilotz.run()
 * - Waiting for the full response via the events async iterator
 *
 * Run with:
 *   OPENAI_KEY=<your-openai-key> deno run -A --env examples/hello-world.ts
 */

import { createCopilotz } from "../index.ts";

// ---------------------------------------------------------------------------
// 1. Read the OpenAI API key from the environment
// ---------------------------------------------------------------------------
const API_KEY = Deno.env.get("OPENAI_KEY") || Deno.env.get("OPENAI_API_KEY") ||
  Deno.env.get("DEFAULT_OPENAI_KEY") || Deno.env.get("LLM_API_KEY") ||
  Deno.env.get("API_KEY");
if (!API_KEY) {
  console.error(
    "❌  OPENAI_KEY is not set.\n   Run with: OPENAI_KEY=<key> deno run -A --env examples/hello-world.ts",
  );
  Deno.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Create a Copilotz instance with a single assistant
// ---------------------------------------------------------------------------
const copilotz = await createCopilotz({
  namespace: "examples",
  agents: [
    {
      id: "assistant",
      name: "Assistant",
      role: "assistant",
      instructions: "You are a helpful, concise assistant.",
      llmOptions: {
        provider: "openai",
        model: "gpt-5.4",
        openaiApi: "responses",
      },
    },
  ],
  security: {
    resolveLLMRuntimeConfig: async ({ provider, agent, config }) => {
      switch (provider) {
        case "openai":
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

// ---------------------------------------------------------------------------
// 3. Send a message and collect the response via the events iterator
// ---------------------------------------------------------------------------
console.log("👤 User: What is the capital of France?\n");
console.log("🤖 Assistant: ");

const result = await copilotz.run({
  content: "What is the capital of France?",
  sender: { type: "user", name: "User" },
  target: "assistant",
}, {
  stream: true,
});

// Iterate over streaming events and print each token as it arrives
let isThinking = false;
let sawAssistantOutput = false;
let llmFailure: string | null = null;

for await (const event of result.events) {
  if (event.type === "LLM_RESULT") {
    const payload = event.payload as {
      status?: string;
      answer?: string | null;
      error?: { message?: string | null } | null;
    };
    if (payload.status === "failed") {
      llmFailure = payload.error?.message ?? payload.answer ??
        "LLM call failed";
    }
  }

  if (event.type === "TOKEN") {
    const payload = event.payload as { token?: string; isReasoning?: boolean };
    const token = payload.token ?? "";
    const isReasoning = !!payload.isReasoning;
    if (token.length > 0 && !isReasoning) {
      sawAssistantOutput = true;
    }

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
try {
  await result.done;
  if (llmFailure) {
    throw new Error(llmFailure);
  }
  if (!sawAssistantOutput) {
    throw new Error("No assistant output was streamed.");
  }
  console.log("\n\n✅ Done!");
} catch (error) {
  console.error(
    "\n\n❌ Run failed. Check your model credentials and network connectivity.",
  );
  throw error;
}

// ---------------------------------------------------------------------------
// 4. Clean up
// ---------------------------------------------------------------------------
await copilotz.shutdown();
