/**
 * End-to-end tool-call persistence check.
 *
 * This example runs a tool loop with a mocked OpenAI-compatible stream. It
 * verifies live TOOL_CALL/TOOL_RESULT projections, persisted message history,
 * durable tool_execution nodes, and canonical llm_attempt nodes.
 *
 * Run with:
 *   deno run -A examples/tool-call-e2e.ts
 */

import { createCopilotz } from "../index.ts";
import type { Tool } from "../types/index.ts";

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

function buildSseResponse(content: string, usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}): Response {
  const events = [
    {
      choices: [{ delta: { content }, finish_reason: null }],
    },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    },
  ];

  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("") + "data: [DONE]\n\n";

  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
const requestBodies: Array<Record<string, unknown>> = [];

globalThis.fetch = (async (input, init) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.href
    : input.url;
  assert(
    url === "https://mock.openai.test/v1/chat/completions",
    `Unexpected fetch URL: ${url}`,
  );

  fetchCalls += 1;
  if (typeof init?.body === "string") {
    requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
  }

  if (fetchCalls === 1) {
    return buildSseResponse(
      '<tool_calls>\n{"name":"example_time","arguments":{"timezone":"UTC"}}\n</tool_calls>',
      {
        promptTokens: 18,
        completionTokens: 6,
        totalTokens: 24,
      },
    );
  }

  return buildSseResponse("The current example time is 12:34 UTC.", {
    promptTokens: 32,
    completionTokens: 8,
    totalTokens: 40,
  });
}) as typeof fetch;

const exampleTimeTool: Tool = {
  id: "example_time",
  key: "example_time",
  name: "Example Time",
  description: "Returns a deterministic example time for E2E tests.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      timezone: { type: "string" },
    },
    required: ["timezone"],
  },
  execute: ({ timezone }: { timezone?: string }) => ({
    timezone: timezone ?? "UTC",
    iso: "2026-06-22T12:34:00.000Z",
  }),
};

const copilotz = await createCopilotz({
  namespace: "examples-tool-e2e",
  agentsFile: false,
  agents: [
    {
      id: "timekeeper",
      name: "Timekeeper",
      role: "assistant",
      instructions:
        "Use the example_time tool when asked for time, then answer briefly.",
      allowedTools: ["example_time"],
      llmOptions: {
        provider: "openai",
        model: "gpt-4o-mini",
        baseUrl: "https://mock.openai.test/v1",
        openaiApi: "chat_completions",
        estimateCost: false,
      },
    },
  ],
  tools: [exampleTimeTool],
  security: {
    resolveLLMRuntimeConfig: async () => ({ apiKey: "test-key" }),
  },
  dbConfig: { url: ":memory:" },
});

try {
  const result = await copilotz.run({
    content: "What time is it right now?",
    sender: { type: "user", id: "user-1", name: "User" },
    target: "timekeeper",
  }, {
    stream: true,
  });

  const streamed: string[] = [];
  let sawToolCall = false;
  let sawToolResult = false;
  let liveToolExecutionId: string | null = null;

  for await (const event of result.events) {
    if (event.type === "TOKEN") {
      const payload = event.payload as {
        token?: string;
        isReasoning?: boolean;
      };
      if (payload.token && !payload.isReasoning) {
        streamed.push(payload.token);
      }
    }

    if (event.type === "TOOL_CALL") {
      sawToolCall = true;
    }

    if (event.type === "TOOL_RESULT") {
      sawToolResult = true;
      const metadata = event.metadata && typeof event.metadata === "object"
        ? event.metadata as Record<string, unknown>
        : {};
      if (typeof metadata.toolExecutionId === "string") {
        liveToolExecutionId = metadata.toolExecutionId;
      }
    }
  }

  await result.done;

  assertEquals(fetchCalls, 2, "Expected tool call turn and final answer turn");
  assert(sawToolCall, "Expected live TOOL_CALL projection");
  assert(sawToolResult, "Expected live TOOL_RESULT projection");
  assertEquals(
    streamed.join(""),
    "The current example time is 12:34 UTC.",
    "Expected final visible answer to stream",
  );

  const messages = await copilotz.ops.getMessageHistoryFromGraph(
    result.threadId,
  );
  const toolCallMessage = messages.find((message) =>
    Array.isArray(message.toolCalls) && message.toolCalls.length > 0
  );
  assert(toolCallMessage, "Expected an agent message with tool calls");

  const toolResultMessage = messages.find((message) =>
    message.senderType === "tool"
  );
  assert(toolResultMessage, "Expected persisted tool result message");
  const toolResultMetadata = (toolResultMessage.metadata ?? {}) as Record<
    string,
    unknown
  >;
  assert(
    typeof toolResultMetadata.toolExecutionId === "string",
    "Expected persisted tool result metadata to reference tool_execution",
  );
  assertEquals(
    toolResultMetadata.toolExecutionId,
    liveToolExecutionId,
    "Expected live and persisted tool_execution ids to match",
  );

  const finalAnswer = messages.find((message) =>
    message.senderType === "agent" &&
    String(message.content ?? "").includes("12:34 UTC")
  );
  assert(finalAnswer, "Expected final answer message in history");

  const toolExecutionRows = await copilotz.db.query<{
    id: string;
    data: Record<string, unknown>;
  }>(
    `SELECT "id", "data"
     FROM "nodes"
     WHERE "data"->>'threadId' = $1
       AND "type" = 'tool_execution'
     ORDER BY "created_at" ASC`,
    [result.threadId],
  );
  assertEquals(
    toolExecutionRows.rows.length,
    1,
    "Expected one durable tool_execution node",
  );
  assertEquals(
    toolExecutionRows.rows[0].id,
    liveToolExecutionId,
    "Expected live toolExecutionId to point at durable node",
  );
  assertEquals(
    toolExecutionRows.rows[0].data.status,
    "completed",
    "Expected tool_execution to complete",
  );
  assertEquals(
    (toolExecutionRows.rows[0].data.output as Record<string, unknown>).iso,
    "2026-06-22T12:34:00.000Z",
    "Expected durable tool_execution output",
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
    [result.threadId],
  );
  assertEquals(
    attemptRows.rows.length,
    2,
    "Expected one llm_attempt for tool call and one for final answer",
  );
  assertEquals(
    attemptRows.rows.every((row) => row.data.status === "completed"),
    true,
    "Expected all llm_attempt nodes to complete",
  );
  assertEquals(
    (attemptRows.rows[1].data.usage as Record<string, unknown>).totalTokens,
    40,
    "Expected final answer attempt usage",
  );

  const secondRequestJson = JSON.stringify(requestBodies[1]);
  assert(
    secondRequestJson.includes("2026-06-22T12:34:00.000Z"),
    "Expected final provider request to include tool result output",
  );

  console.log("End-to-end tool-call example passed.");
  console.log(`Thread: ${result.threadId}`);
  console.log(`Messages persisted: ${messages.length}`);
  console.log(`Tool executions persisted: ${toolExecutionRows.rows.length}`);
  console.log(`LLM attempts persisted: ${attemptRows.rows.length}`);
} finally {
  globalThis.fetch = originalFetch;
  await copilotz.shutdown();
}
