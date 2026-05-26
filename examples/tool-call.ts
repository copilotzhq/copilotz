/**
 * Tool Call Example — Demonstrating the standardized ToolInvocation contract.
 *
 * This example shows how tool calls are now represented in event payloads
 * following the standardization to the flattened ToolInvocation interface.
 *
 * Run with:
 *   OPENAI_KEY=<key> deno run -A --env examples/tool-call.ts
 */
import process from "node:process";
import { createCopilotz } from "../index.ts";
import type { ToolInvocation } from "../runtime/llm/types.ts";

// 1. Read the API key
const API_KEY = Deno.env.get("OPENAI_KEY") || Deno.env.get("OPENAI_API_KEY") ||
  Deno.env.get("DEFAULT_OPENAI_KEY") || Deno.env.get("LLM_API_KEY") ||
  Deno.env.get("API_KEY");
if (!API_KEY) {
  console.error(
    "❌  OPENAI_KEY is not set.\n   Run with: deno run -A --env examples/tool-call.ts",
  );
  Deno.exit(1);
}

// 2. Create Copilotz instance
const copilotz = await createCopilotz({
  namespace: "examples",
  resources: {
    imports: ["tools.get_current_time"],
  },
  agents: [
    {
      id: "timekeeper",
      name: "TimeKeeper",
      role: "assistant",
      instructions:
        "You are a helpful assistant that can tell the current time using tools. Always use the get_current_time tool when asked for the time. Keep your response very brief.",
      llmOptions: {
        provider: "openai",
        model: "gpt-5.4",
        openaiApi: "responses",
        apiKey: API_KEY,
      },
      allowedTools: ["get_current_time"],
    },
  ],
});

console.log("👤 User: What time is it right now?\n");

// 3. Run and consume events from the iterator
const result = await copilotz.run({
  content: "What time is it right now?",
  sender: { type: "user", name: "User" },
  target: "timekeeper",
}, {
  stream: true,
});

process.stdout.write("🤖 Assistant: ");
let isThinking = false;
let sawAssistantOutput = false;
let sawToolCall = false;
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

  // Inspect TOOL_CALL events to verify the ToolInvocation structure
  if (event.type === "TOOL_CALL") {
    sawToolCall = true;
    const toolCall = (event.payload as { toolCall: ToolInvocation }).toolCall;

    console.log("\n\x1b[33m[TOOL_CALL Event Payload]\x1b[0m");
    console.log(`Interface: ToolInvocation`);
    console.log(`ID:        ${toolCall.id}`);
    console.log(`Tool ID:   ${toolCall.tool.id}`);
    console.log(`Tool Name: ${toolCall.tool.name || "(none)"}`);
    console.log(
      `Arguments: ${
        typeof toolCall.args === "string"
          ? toolCall.args
          : JSON.stringify(toolCall.args)
      }`,
    );
    console.log("--------------------------\n");
  }

  // Inspect tool result messages
  if (event.type === "NEW_MESSAGE") {
    const payload = event.payload as {
      sender?: { type: string };
      metadata?: { toolCalls?: ToolInvocation[] };
    };
    if (payload.sender?.type === "tool") {
      console.log("\x1b[32m[TOOL_RESULT (via NEW_MESSAGE metadata)]\x1b[0m");
      const meta = payload.metadata?.toolCalls?.[0];
      if (meta) {
        console.log(`Status:    ${meta.status}`);
        console.log(`Output:    ${JSON.stringify(meta.output)}`);
        console.log("--------------------------\n");
      }
    }
  }

  // Stream tokens to terminal
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

try {
  await result.done;
  if (llmFailure) {
    throw new Error(llmFailure);
  }
  if (!sawToolCall) {
    throw new Error("No tool call event was emitted.");
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

await copilotz.shutdown();
