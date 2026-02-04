/**
 * Example: Multi-Agent Conversation
 * 
 * Tests:
 * - @mentions routing between agents
 * - Persistent targets (subsequent messages go to same target)
 * - Agent persistent memory (update_my_memory tool)
 * - Agent-to-agent collaboration towards a goal
 * 
 * Run with: deno run -A --env example-multi-agent.ts
 */

import { createCopilotz } from "./index.ts";

const OPENAI_API_KEY = Deno.env.get("DEFAULT_OPENAI_KEY");
if (!OPENAI_API_KEY) {
  console.error("❌ Error: DEFAULT_OPENAI_KEY environment variable is required");
  Deno.exit(1);
}

// Check for collaboration-only mode
const COLLAB_ONLY = Deno.args.includes("--collab-only");

async function main() {
  console.log("🚀 Multi-Agent Conversation Example\n");

  const copilotz = await createCopilotz({
    agents: [
      {
        id: "researcher",
        name: "Researcher",
        role: "assistant",
        instructions: `You are a research assistant. You find and verify information.
When you learn something important about the user, use update_my_memory to remember it.
Keep responses brief (1-2 sentences).
When collaborating with Writer, @mention them to hand off.`,
        llmOptions: { provider: "openai", model: "gpt-4o-mini", apiKey: OPENAI_API_KEY },
        allowedTools: ["update_my_memory"],
        allowedAgents: ["writer"],
      },
      {
        id: "writer",
        name: "Writer",
        role: "assistant", 
        instructions: `You are a creative writer. You craft clear, engaging content.
Keep responses brief (1-2 sentences).
When collaborating with Researcher, @mention them to hand off.`,
        llmOptions: { provider: "openai", model: "gpt-4o-mini", apiKey: OPENAI_API_KEY },
        allowedAgents: ["researcher"],
      },
    ],
    multiAgent: {
      maxAgentTurns: 10,
      includeTargetContext: true,
    },
    stream: true,
  });

  const threadId = "multi-agent-test";

  // Helper to send a message and stream the response
  async function chat(message: string) {
    console.log(`\n👤 User: ${message}`);
    console.log("─".repeat(40));

    const result = await copilotz.run(
      {
        content: message,
        sender: { type: "user", name: "Alex" },
        thread: { externalId: threadId },
      },
      async (event) => {
        if (event.type === "TOOL_CALL") {
          const payload = event.payload as { call?: { name?: string } };
          if (payload.call?.name) {
            console.log(`  🔧 [${payload.call.name}]`);
          }
        }
      },
    );

    let currentAgent = "";
    for await (const event of result.events) {
      if (event.type === "TOKEN") {
        const payload = event.payload as { token?: string; agentName?: string };
        if (payload.agentName && payload.agentName !== currentAgent) {
          if (currentAgent) console.log("\n");
          currentAgent = payload.agentName;
          process.stdout.write(`🤖 ${currentAgent}: `);
        }
        if (payload.token) {
          await Deno.stdout.write(new TextEncoder().encode(payload.token));
        }
      }
    }
    console.log("\n");
    await result.done;
  }

  if (!COLLAB_ONLY) {
    // Test 1: @mention routes to specific agent
    console.log("═══ Test 1: @mention routing ═══");
    await chat("@Researcher, what's the capital of France?");

    // Test 2: Persistent target - no @mention needed
    console.log("═══ Test 2: Persistent target ═══");
    await chat("What about Germany?"); // Should still go to Researcher

    // Test 3: Change target with new @mention
    console.log("═══ Test 3: Change target ═══");
    await chat("@Writer, write a haiku about Paris");

    // Test 4: Agent memory - Researcher should remember
    console.log("═══ Test 4: Agent memory ═══");
    await chat("@Researcher, I'm really interested in European capitals. Remember that for me.");
    
    // Test 5: Verify memory persists
    console.log("═══ Test 5: Memory retrieval ═══");
    await chat("What do you know about my interests?");
  }

  // Test 6: Tool call flow test
  // Researcher has update_my_memory tool - test that tool results are processed
  console.log("═══ Test 6: Tool call flow ═══");
  await chat("@Researcher, use your update_my_memory tool to store that my favorite city is Tokyo. Then confirm what you stored.");

  // Test 7: Agent-to-agent collaboration
  // Agents should @mention each other to work together on a task
  console.log("═══ Test 7: Agent collaboration ═══");
  await chat(`@Researcher and @Writer, work together to create a short travel guide for Rome. 
Researcher: find 2 key facts. Writer: turn them into engaging prose. 
Take turns, @mention each other, and when done, address me (@Alex) with the final result.`);

  await copilotz.shutdown();
  console.log("✨ Done!");
}

main().catch(console.error);
