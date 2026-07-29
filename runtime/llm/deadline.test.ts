import { assertEquals, assertRejects } from "@std/assert";
import { chat, LLMProviderError } from "@/runtime/llm/index.ts";
import type { ProviderRegistry } from "@/runtime/llm/types.ts";

const encoder = new TextEncoder();

function reasoningForever(): Response {
  let interval: number | undefined;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        interval = setInterval(() => {
          controller.enqueue(
            encoder.encode(`data: {"reasoning":"working"}\n\n`),
          );
        }, 2) as unknown as number;
      },
      cancel() {
        if (interval !== undefined) clearInterval(interval);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function answerResponse(answer: string): Response {
  return new Response(
    `data: ${JSON.stringify({ content: answer })}\n\n` +
      `data: ${JSON.stringify({ finishReason: "stop" })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

const registry: ProviderRegistry = {
  anthropic: () => ({
    endpoint: "https://example.test/llm",
    headers: () => ({}),
    body: () => ({}),
    extractContent: (data: Record<string, unknown>) => {
      if (typeof data.reasoning === "string") {
        return [{ text: data.reasoning, isReasoning: true }];
      }
      return typeof data.content === "string" ? [{ text: data.content }] : null;
    },
    isStreamActivity: () => true,
    extractFinishReason: (data: Record<string, unknown>) =>
      data.finishReason === "stop" ? "stop" : null,
  }),
};

Deno.test("absolute attempt timeout falls back despite continuous reasoning", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(
      calls === 1 ? reasoningForever() : answerResponse("fallback answer"),
    );
  };

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "hello" }] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
        attemptTimeoutMs: 25,
        totalTimeoutMs: 250,
        firstTokenTimeoutMs: 1_000,
        streamIdleTimeoutMs: 1_000,
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      undefined,
      registry,
    );

    assertEquals(calls, 2);
    assertEquals(response.model, "fallback");
    assertEquals(response.answer, "fallback answer");
    assertEquals(response.usageAttempts?.[0]?.recoveryAction, "fallback");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("logical chat timeout stops continuous reasoning", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(reasoningForever());

  try {
    const error = await assertRejects(
      () =>
        chat(
          { messages: [{ role: "user", content: "hello" }] },
          {
            provider: "anthropic",
            model: "primary",
            apiKey: "test",
            estimateCost: false,
            attemptTimeoutMs: 1_000,
            totalTimeoutMs: 30,
            firstTokenTimeoutMs: 1_000,
            streamIdleTimeoutMs: 1_000,
          },
          {},
          undefined,
          registry,
        ),
      LLMProviderError,
    );
    assertEquals(error.reason, "timeout");
    assertEquals(error.usageAttempts.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
