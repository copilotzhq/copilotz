/**
 * Real-provider multi-turn, multi-agent smoke test.
 *
 * This intentionally uses the configured OpenAI API instead of a mocked stream.
 * It keeps the prompts small but verifies:
 * - a multi-agent route happens in a single thread
 * - a second user turn reuses the same thread
 * - both agents persist visible messages
 * - canonical llm_attempt nodes are written
 *
 * Run with:
 *   OPENAI_KEY=<your-openai-key> deno run -A --env examples/multi-agent-e2e.ts
 *
 * Optional:
 *   MULTI_AGENT_E2E_MODEL=gpt-4o-mini
 */

import { createCopilotz } from "../index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${expected}, got ${actual}`);
  }
}

const API_KEY = Deno.env.get("OPENAI_KEY") || Deno.env.get("OPENAI_API_KEY") ||
  Deno.env.get("DEFAULT_OPENAI_KEY") || Deno.env.get("LLM_API_KEY") ||
  Deno.env.get("API_KEY");
if (!API_KEY) {
  console.error(
    "OPENAI_KEY is not set. Run with: OPENAI_KEY=<key> deno run -A --env examples/multi-agent-e2e.ts",
  );
  Deno.exit(1);
}

const MODEL = Deno.env.get("MULTI_AGENT_E2E_MODEL") || "gpt-4o-mini";
const namespace = `examples-multi-agent-${crypto.randomUUID()}`;

const copilotz = await createCopilotz({
  namespace,
  agentsFile: false,
  agents: [
    {
      id: "planner",
      name: "Planner",
      role: "planning coordinator",
      instructions: [
        "You are Planner in a two-agent smoke test.",
        "For each new user request, first write one short sentence beginning PLANNER_DRAFT:",
        "Then hand the next turn to Reviewer by including exactly <route_to>reviewer</route_to>.",
        "If the immediately previous agent message starts with REVIEWER_FEEDBACK:, write one short sentence beginning PLANNER_FINAL: and do not include any route tag.",
        "Never route to yourself.",
      ].join("\n"),
      allowedAgents: ["reviewer"],
      allowedTools: null,
      llmOptions: {
        provider: "openai",
        model: MODEL,
        openaiApi: "responses",
        maxTokens: 220,
        temperature: 0.2,
        estimateCost: false,
      },
    },
    {
      id: "reviewer",
      name: "Reviewer",
      role: "risk reviewer",
      instructions: [
        "You are Reviewer in a two-agent smoke test.",
        "Reply with exactly one short sentence beginning REVIEWER_FEEDBACK:",
        "Then hand control back to Planner by including exactly <route_to>planner</route_to>.",
        "Never route to yourself.",
      ].join("\n"),
      allowedAgents: ["planner"],
      allowedTools: null,
      llmOptions: {
        provider: "openai",
        model: MODEL,
        openaiApi: "responses",
        maxTokens: 180,
        temperature: 0.2,
        estimateCost: false,
      },
    },
  ],
  multiAgent: {
    enabled: true,
    maxAgentTurns: 6,
    includeTargetContext: true,
  },
  security: {
    resolveLLMRuntimeConfig: async () => ({ apiKey: API_KEY }),
  },
  dbConfig: { url: ":memory:" },
});

type RunSummary = {
  threadId: string;
  streamed: string;
  eventTypes: string[];
};

const runAndCollect = async (
  content: string,
  thread?: { id: string },
): Promise<RunSummary> => {
  const result = await copilotz.run({
    content,
    sender: { type: "user", id: "multi-user", name: "Multi User" },
    target: "planner",
    ...(thread ? { thread } : {}),
  }, {
    stream: true,
  });

  const streamed: string[] = [];
  const eventTypes: string[] = [];

  for await (const event of result.events) {
    eventTypes.push(event.type);
    if (event.type === "TOKEN") {
      const payload = event.payload as {
        token?: string;
        isReasoning?: boolean;
      };
      if (payload.token && !payload.isReasoning) {
        streamed.push(payload.token);
      }
    }
  }

  await result.done;
  return {
    threadId: result.threadId,
    streamed: streamed.join(""),
    eventTypes,
  };
};

try {
  const firstRun = await runAndCollect(
    "Plan a tiny release checklist for a new export button. Keep it brief.",
  );
  const secondRun = await runAndCollect(
    "Using the same context, add one testing reminder to that checklist.",
    { id: firstRun.threadId },
  );

  assertEquals(
    secondRun.threadId,
    firstRun.threadId,
    "Expected second user turn to reuse the same thread",
  );
  assert(
    firstRun.eventTypes.includes("LLM_RESULT") &&
      secondRun.eventTypes.includes("LLM_RESULT"),
    "Expected LLM_RESULT events in both turns",
  );

  const messages = await copilotz.ops.getMessageHistoryFromGraph(
    firstRun.threadId,
  );
  const agentMessages = messages.filter((message) =>
    message.senderType === "agent"
  );
  const plannerMessages = agentMessages.filter((message) =>
    message.senderId === "planner" ||
    String(message.metadata?.senderExternalId ?? "") === "planner"
  );
  const reviewerMessages = agentMessages.filter((message) =>
    message.senderId === "reviewer" ||
    String(message.metadata?.senderExternalId ?? "") === "reviewer"
  );

  assertEquals(
    messages.filter((message) => message.senderType === "user").length,
    2,
    "Expected two persisted user turns",
  );
  assert(
    plannerMessages.length >= 2,
    "Expected Planner to persist at least two messages",
  );
  assert(
    reviewerMessages.length >= 2,
    "Expected Reviewer to persist at least two messages",
  );
  assert(
    agentMessages.some((message) =>
      String(message.content ?? "").includes("PLANNER_DRAFT:")
    ),
    "Expected Planner draft marker in history",
  );
  assert(
    agentMessages.some((message) =>
      String(message.content ?? "").includes("REVIEWER_FEEDBACK:")
    ),
    "Expected Reviewer feedback marker in history",
  );

  const attemptRows = await copilotz.db.query<{
    id: string;
    data: Record<string, unknown>;
  }>(
    `SELECT "id", "data"
     FROM "nodes"
     WHERE "data"->>'threadId' = $1
       AND "type" = 'llm_attempt'
     ORDER BY "created_at" ASC`,
    [firstRun.threadId],
  );
  assert(
    attemptRows.rows.length >= 4,
    "Expected canonical llm_attempt nodes for both agents across both turns",
  );
  assertEquals(
    attemptRows.rows.every((row) => row.data.status === "completed"),
    true,
    "Expected all llm_attempt nodes to complete",
  );

  console.log("Real multi-turn multi-agent example passed.");
  console.log(`Model: ${MODEL}`);
  console.log(`Thread: ${firstRun.threadId}`);
  console.log(`Messages persisted: ${messages.length}`);
  console.log(`Agent messages persisted: ${agentMessages.length}`);
  console.log(`Planner messages: ${plannerMessages.length}`);
  console.log(`Reviewer messages: ${reviewerMessages.length}`);
  console.log(`LLM attempts persisted: ${attemptRows.rows.length}`);
} finally {
  await copilotz.shutdown();
}
