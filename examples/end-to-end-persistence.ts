/**
 * End-to-end persistence check.
 *
 * This example runs through createCopilotz().run(), consumes the stream,
 * waits for result.done, then verifies the user/assistant messages and
 * canonical llm_attempt rows were persisted with usage and debug snapshots.
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

function buildBrokenSseResponse(): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: { reasoning_content: "Need to continue safely." },
                }],
              })
            }\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `data: ${
              JSON.stringify({
                choices: [{ delta: { content: "Broken partial" } }],
              })
            }\n\n`,
          ),
        );
        setTimeout(
          () => controller.error(new Error("simulated stream break")),
          0,
        );
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
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
    return buildSseResponse("Persisted assistant message.", {
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
    });
  }
  if (fetchCalls === 2) {
    return buildSseResponse("Second persisted assistant message.", {
      promptTokens: 25,
      completionTokens: 5,
      totalTokens: 30,
    });
  }
  if (fetchCalls === 3) {
    return buildBrokenSseResponse();
  }
  return buildSseResponse(" continued after break.", {
    promptTokens: 40,
    completionTokens: 4,
    totalTokens: 44,
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
  const thirdRun = await runAndCollect("Break once, then continue.", {
    id: firstRun.threadId,
  });

  assertEquals(
    secondRun.threadId,
    firstRun.threadId,
    "Expected second turn to use the same thread",
  );
  assertEquals(
    thirdRun.threadId,
    firstRun.threadId,
    "Expected third turn to use the same thread",
  );
  assertEquals(
    fetchCalls,
    4,
    "Expected third turn to use a continuation request after the stream break",
  );
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
  assertEquals(
    thirdRun.streamed,
    "Broken partial continued after break.",
    "Expected third streamed assistant output to include continuation",
  );
  assert(
    firstRun.eventTypes.includes("LLM_RESULT") &&
      secondRun.eventTypes.includes("LLM_RESULT") &&
      thirdRun.eventTypes.includes("LLM_RESULT"),
    "Expected an LLM_RESULT event in every stream",
  );
  assertEquals(requestBodies.length, 4, "Expected four request bodies");
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
  assertEquals(
    requestBodies[3].model,
    "gpt-4o-mini",
    "Expected configured model in continuation request body",
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
  const continuationRequestJson = JSON.stringify(requestBodies[3]);
  assert(
    continuationRequestJson.includes("Need to continue safely."),
    "Expected continuation request to include failed attempt reasoning",
  );
  assert(
    continuationRequestJson.includes("Broken partial"),
    "Expected continuation request to include failed attempt visible content",
  );

  const messages = await copilotz.ops.getMessageHistoryFromGraph(
    firstRun.threadId,
  );
  assertEquals(
    messages.length,
    6,
    "Expected three user and three assistant messages",
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
    messages[4].content,
    "Break once, then continue.",
    "Expected persisted third user message",
  );
  assertEquals(
    messages[5].content,
    "Broken partial continued after break.",
    "Expected persisted continued assistant message",
  );
  assertEquals(
    messages[5].reasoning,
    "Need to continue safely.",
    "Expected persisted continued assistant reasoning from failed attempt",
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
  assertEquals(
    messages[5].senderType,
    "agent",
    "Expected third assistant message sender type",
  );

  const firstAssistantMetadata = (messages[1].metadata ?? {}) as Record<
    string,
    unknown
  >;
  const secondAssistantMetadata = (messages[3].metadata ?? {}) as Record<
    string,
    unknown
  >;
  const thirdAssistantMetadata = (messages[5].metadata ?? {}) as Record<
    string,
    unknown
  >;
  assert(
    typeof firstAssistantMetadata.usageNodeId === "string",
    "Expected first assistant message metadata to reference llm_usage",
  );
  assert(
    typeof firstAssistantMetadata.llmAttemptId === "string",
    "Expected first assistant message metadata to reference llm_attempt",
  );
  assert(
    typeof secondAssistantMetadata.usageNodeId === "string",
    "Expected second assistant message metadata to reference llm_usage",
  );
  assert(
    typeof secondAssistantMetadata.llmAttemptId === "string",
    "Expected second assistant message metadata to reference llm_attempt",
  );
  assert(
    typeof thirdAssistantMetadata.usageNodeId === "string",
    "Expected third assistant message metadata to reference llm_usage",
  );
  assert(
    typeof thirdAssistantMetadata.llmAttemptId === "string",
    "Expected third assistant message metadata to reference llm_attempt",
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

  assertEquals(
    attemptRows.rows.length,
    4,
    "Expected four canonical llm_attempt nodes",
  );
  assertEquals(
    attemptRows.rows[0].id,
    firstAssistantMetadata.llmAttemptId,
    "Expected first assistant metadata to point at first llm_attempt",
  );
  assertEquals(
    attemptRows.rows[1].id,
    secondAssistantMetadata.llmAttemptId,
    "Expected second assistant metadata to point at second llm_attempt",
  );
  assertEquals(
    attemptRows.rows[3].id,
    thirdAssistantMetadata.llmAttemptId,
    "Expected continued assistant metadata to point at final continuation llm_attempt",
  );
  assertEquals(
    attemptRows.rows[0].data.status,
    "completed",
    "Expected first llm_attempt to complete",
  );
  assertEquals(
    (attemptRows.rows[1].data.usage as Record<string, unknown> | undefined)
      ?.totalTokens,
    30,
    "Expected second llm_attempt to track provider-reported tokens",
  );
  const firstAttemptDebug = attemptRows.rows[0].data.debug as Record<
    string,
    unknown
  >;
  assert(
    Array.isArray(firstAttemptDebug.inputMessages),
    "Expected first llm_attempt debug snapshot to include input messages",
  );
  assertEquals(
    (firstAttemptDebug.rawOutput as Record<string, unknown>).content,
    "Persisted assistant message.",
    "Expected first llm_attempt debug snapshot to include raw output",
  );
  assertEquals(
    (firstAttemptDebug.parsedOutput as Record<string, unknown>).answer,
    "Persisted assistant message.",
    "Expected first llm_attempt debug snapshot to include parsed output",
  );
  assertEquals(
    attemptRows.rows[2].data.status,
    "failed",
    "Expected broken stream attempt to be tracked as failed",
  );
  assertEquals(
    attemptRows.rows[2].data.partialAnswer,
    "Broken partial",
    "Expected failed llm_attempt to persist visible partial output",
  );
  assertEquals(
    attemptRows.rows[2].data.partialReasoning,
    "Need to continue safely.",
    "Expected failed llm_attempt to persist partial reasoning",
  );
  assertEquals(
    (attemptRows.rows[3].data.usage as Record<string, unknown> | undefined)
      ?.totalTokens,
    44,
    "Expected continuation llm_attempt to track final provider usage",
  );
  const continuationDebug = attemptRows.rows[3].data.debug as Record<
    string,
    unknown
  >;
  assert(
    JSON.stringify(continuationDebug.inputMessages).includes(
      "Need to continue safely.",
    ),
    "Expected continuation llm_attempt debug input to include prior reasoning",
  );
  assertEquals(
    (continuationDebug.parsedOutput as Record<string, unknown>).answer,
    "Broken partial continued after break.",
    "Expected continuation llm_attempt debug snapshot to include parsed continuation",
  );

  console.log("End-to-end multi-turn persistence example passed.");
  console.log(`Thread: ${firstRun.threadId}`);
  console.log(`Messages persisted: ${messages.length}`);
  console.log(`LLM attempts persisted: ${attemptRows.rows.length}`);
} finally {
  globalThis.fetch = originalFetch;
  await copilotz.shutdown();
}
