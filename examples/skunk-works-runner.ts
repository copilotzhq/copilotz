/**
 * Non-interactive runner for the skunk-works preset.
 * Sends a task, prints the full multi-agent conversation, then allows follow-up turns.
 *
 * Run with:
 *   deno run -A --env-file=lib/copilotz/.env lib/copilotz/examples/skunk-works-runner.ts
 */

import { createCopilotz } from "../index.ts";
import type { StreamEvent } from "../runtime/index.ts";

const OPENAI_KEY = Deno.env.get("OPENAI_KEY") || Deno.env.get("OPENAI_API_KEY");
if (!OPENAI_KEY) {
  console.error("❌  OPENAI_KEY is not set.");
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
      provider: "openai",
      model: "gpt-4o",
    },
  },
  security: {
    resolveLLMRuntimeConfig: async () => ({ apiKey: OPENAI_KEY }),
  },
  dbConfig: { url: ":memory:" },
});

const threadExternalId = crypto.randomUUID();
let threadId = "";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

function c(text: string, code: string) {
  return `${code}${text}${RESET}`;
}

async function sendMessage(content: string, turn: number) {
  console.log(`\n${c("═".repeat(70), DIM)}`);
  console.log(`${c(`USER (turn ${turn})`, BOLD + CYAN)}: ${content}`);
  console.log(c("─".repeat(70), DIM));

  const handle = await copilotz.run({
    content,
    sender: { type: "user", name: "User" },
    thread: { externalId: threadExternalId },
  }, { stream: true, ackMode: "onComplete" });

  threadId = handle.threadId;

  let currentAgent = "";
  let inReasoning = false;
  let sawVisible = false;

  for await (const raw of handle.events) {
    const event = raw as StreamEvent & {
      type: string;
      payload: Record<string, unknown>;
    };

    if (event.type === "LLM_CALL") {
      const agent = event.payload?.agent as { name?: string } | undefined;
      const name = agent?.name ?? "?";
      if (name !== currentAgent) {
        if (sawVisible) console.log("");
        currentAgent = name;
        sawVisible = false;
        inReasoning = false;
        console.log(`\n${c(`[${name}]`, BOLD + GREEN)} thinking...`);
      }
      continue;
    }

    if (event.type === "TOKEN") {
      const p = event.payload as {
        token?: string;
        isComplete?: boolean;
        isReasoning?: boolean;
        agent?: { name?: string };
      };
      const agentName = p.agent?.name ?? "?";
      const token = p.token ?? "";
      const isReasoning = Boolean(p.isReasoning);
      const isComplete = Boolean(p.isComplete);

      if (agentName !== currentAgent) {
        if (sawVisible) console.log("");
        currentAgent = agentName;
        sawVisible = false;
        inReasoning = false;
        process.stdout.write(`\n${c(`[${agentName}]`, BOLD + GREEN)} `);
      }

      if (isComplete) {
        if (sawVisible) process.stdout.write("\n");
        inReasoning = false;
        sawVisible = false;
        continue;
      }

      if (isReasoning && !inReasoning) {
        process.stdout.write(c("thinking> ", DIM));
        inReasoning = true;
      } else if (!isReasoning && inReasoning) {
        process.stdout.write(`\n${c("answer> ", CYAN)}`);
        inReasoning = false;
      } else if (!isReasoning && !sawVisible) {
        process.stdout.write(c("answer> ", CYAN));
      }

      if (!isReasoning) sawVisible = true;
      process.stdout.write(token);
      continue;
    }

    if (event.type === "TOOL_CALL") {
      const tc = (event.payload as { toolCall?: { tool?: { name?: string }; args?: unknown } })?.toolCall;
      const toolName = tc?.tool?.name ?? "tool";
      const args = JSON.stringify(tc?.args ?? {}).slice(0, 120);
      console.log(`\n  ${c("tool>", YELLOW)} ${toolName} ${c(args, DIM)}`);
      continue;
    }

    if (event.type === "NEW_MESSAGE") {
      const p = event.payload as { sender?: { name?: string; type?: string }; content?: string; target?: string };
      if (p.sender?.type !== "user") {
        const agentLabel = p.sender?.name ?? "agent";
        const target = p.target ? ` → ${p.target}` : "";
        console.log(`\n${c(`[${agentLabel}${target}]`, BOLD + MAGENTA)} ${p.content ?? ""}`);
      }
      continue;
    }
  }

  await handle.done;
  console.log(`\n${c("─".repeat(70), DIM)}`);
}

// Turn 1: Initial task
await sendMessage(
  "Hi team. I'd like you to tackle the Tihany conjecture from Erdős's open problems. " +
  "It states that for every integer k ≥ 2, there exists a set A of natural numbers such that " +
  "every sufficiently large integer n can be represented as the sum of exactly k elements from A, " +
  "and this representation is unique. " +
  "Work together to explore: is this known to be true? What approaches exist? What's the biggest obstacle to a proof?",
  1,
);

// Turn 2: User follow-up
await sendMessage(
  "Interesting. Lens, can you be specific about what you see as the critical failure mode " +
  "in any additive basis proof strategy here? And Spark, do you think there's an analogy " +
  "from the Sidon sets literature that could help?",
  2,
);

// Turn 3: Wrap-up prompt
await sendMessage(
  "Lead, can you synthesize what the team has said and give me a clear verdict: " +
  "is this an open problem worth pursuing computationally, or is it strictly in abstract combinatorics territory?",
  3,
);

await copilotz.shutdown();
console.log(`\n${c("Session complete. Thread: " + threadExternalId, DIM)}\n`);
