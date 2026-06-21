/**
 * End-to-end persistence check.
 *
 * This example runs through createCopilotz().run(), consumes the stream,
 * waits for result.done, then verifies the user/assistant messages and
 * llm_usage row were persisted in the graph database.
 *
 * It stubs only the outbound OpenAI HTTP stream, so it does not need an API key
 * or network access.
 *
 * Run with:
 *   deno run -A examples/end-to-end-persistence.ts
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

  return fetchCalls === 1
    ? buildSseResponse("Persisted assistant message.", {
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
    })
    : buildSseResponse("Second persisted assistant message.", {
      promptTokens: 25,
      completionTokens: 5,
      totalTokens: 30,
    });
}) as typeof fetch;

const copilotz = await createCopilotz({
  namespace: "examples-e2e",
  agentsFile: false,
  agents: [
    {
      id: "assistant",
      name: "Assistant",
      role: "assistant",
      instructions: "You are a concise assistant.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o-mini",
        baseUrl: "https://mock.openai.test/v1",
        openaiApi: "chat_completions",
        estimateCost: false,
        firstTokenTimeoutMs: 0,
        streamIdleTimeoutMs: 0,
      },
    },
  ],
  security: {
    resolveLLMRuntimeConfig: async () => ({ apiKey: "test-key" }),
  },
  dbConfig: { url: ":memory:" },
});

try {
  const runAndCollect = async (
    content: string,
    thread?: { id: string },
  ): Promise<{ threadId: string; streamed: string; eventTypes: string[] }> => {
    const result = await copilotz.run({
      content,
      sender: { type: "user", id: "user-1", name: "User" },
      target: "assistant",
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

  const firstRun = await runAndCollect("Persist this message.");
  const secondRun = await runAndCollect("And persist a second turn.", {
    id: firstRun.threadId,
  });

  assertEquals(
    secondRun.threadId,
    firstRun.threadId,
    "Expected second turn to use the same thread",
  );
  assertEquals(fetchCalls, 2, "Expected one provider request per turn");
  assertEquals(
    firstRun.streamed,
    "Persisted assistant message.",
    "Expected first streamed assistant output",
  );
  assertEquals(
    secondRun.streamed,
    "Second persisted assistant message.",
    "Expected second streamed assistant output",
  );
  assert(
    firstRun.eventTypes.includes("LLM_RESULT") &&
      secondRun.eventTypes.includes("LLM_RESULT"),
    "Expected an LLM_RESULT event in both streams",
  );
  assertEquals(requestBodies.length, 2, "Expected two request bodies");
  assertEquals(
    requestBodies[0].model,
    "gpt-4o-mini",
    "Expected configured model in first request body",
  );
  assertEquals(
    requestBodies[1].model,
    "gpt-4o-mini",
    "Expected configured model in second request body",
  );

  const secondRequestJson = JSON.stringify(requestBodies[1]);
  assert(
    secondRequestJson.includes("Persist this message."),
    "Expected second provider request to include first user turn",
  );
  assert(
    secondRequestJson.includes("Persisted assistant message."),
    "Expected second provider request to include first assistant turn",
  );

  const messages = await copilotz.ops.getMessageHistoryFromGraph(
    firstRun.threadId,
  );
  assertEquals(
    messages.length,
    4,
    "Expected two user and two assistant messages",
  );
  assertEquals(
    messages[0].content,
    "Persist this message.",
    "Expected persisted first user message",
  );
  assertEquals(
    messages[1].content,
    "Persisted assistant message.",
    "Expected persisted first assistant message",
  );
  assertEquals(
    messages[2].content,
    "And persist a second turn.",
    "Expected persisted second user message",
  );
  assertEquals(
    messages[3].content,
    "Second persisted assistant message.",
    "Expected persisted second assistant message",
  );
  assertEquals(
    messages[1].senderType,
    "agent",
    "Expected first assistant message sender type",
  );
  assertEquals(
    messages[3].senderType,
    "agent",
    "Expected second assistant message sender type",
  );

  const firstAssistantMetadata = (messages[1].metadata ?? {}) as Record<
    string,
    unknown
  >;
  const secondAssistantMetadata = (messages[3].metadata ?? {}) as Record<
    string,
    unknown
  >;
  assert(
    typeof firstAssistantMetadata.usageNodeId === "string",
    "Expected first assistant message metadata to reference llm_usage",
  );
  assert(
    typeof secondAssistantMetadata.usageNodeId === "string",
    "Expected second assistant message metadata to reference llm_usage",
  );

  const usageRows = await copilotz.db.query<{
    id: string;
    data: Record<string, unknown>;
  }>(
    `SELECT "id", "data"
     FROM "nodes"
     WHERE "source_type" = 'thread'
       AND "source_id" = $1
       AND "type" = 'llm_usage'
     ORDER BY "created_at" ASC`,
    [firstRun.threadId],
  );

  assertEquals(usageRows.rows.length, 2, "Expected two llm_usage nodes");
  assertEquals(
    usageRows.rows[0].id,
    firstAssistantMetadata.usageNodeId,
    "Expected first assistant metadata to point at first llm_usage",
  );
  assertEquals(
    usageRows.rows[1].id,
    secondAssistantMetadata.usageNodeId,
    "Expected second assistant metadata to point at second llm_usage",
  );
  assertEquals(
    usageRows.rows[0].data.totalTokens,
    14,
    "Expected first provider-reported total tokens",
  );
  assertEquals(
    usageRows.rows[1].data.totalTokens,
    30,
    "Expected second provider-reported total tokens",
  );

  console.log("End-to-end multi-turn persistence example passed.");
  console.log(`Thread: ${firstRun.threadId}`);
  console.log(`Messages persisted: ${messages.length}`);
  console.log(`LLM usage rows persisted: ${usageRows.rows.length}`);
} finally {
  globalThis.fetch = originalFetch;
  await copilotz.shutdown();
}
