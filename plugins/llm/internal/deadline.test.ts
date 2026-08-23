import { assertEquals, assertRejects } from "@std/assert";
import { LLMProviderError } from "./errors.ts";
import { chat } from "./orchestrator.ts";
import type { ProviderRegistry } from "./types.ts";

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

Deno.test("absolute attempt timeout continues from continuous reasoning", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(
      calls === 1 ? reasoningForever() : answerResponse("continued answer"),
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
    assertEquals(response.model, "primary");
    assertEquals(response.answer, "continued answer");
    assertEquals(response.reasoning?.includes("working"), true);
    assertEquals(response.usageAttempts?.[0]?.recoveryAction, "retry_same");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("same-model transport fallback preserves continuation", async () => {
  const originalFetch = globalThis.fetch;
  const seenMessages: unknown[][] = [];
  let calls = 0;
  const continuationRegistry: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/llm",
      headers: () => ({}),
      body: (messages) => {
        seenMessages.push(messages);
        return {};
      },
      extractContent: (data: Record<string, unknown>) => {
        if (typeof data.reasoning === "string") {
          return [{ text: data.reasoning, isReasoning: true }];
        }
        return typeof data.content === "string"
          ? [{ text: data.content }]
          : null;
      },
      isStreamActivity: () => true,
      extractFinishReason: (data: Record<string, unknown>) =>
        data.finishReason === "stop" ? "stop" : null,
    }),
  };
  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(
      calls <= 2 ? reasoningForever() : answerResponse("done"),
    );
  };

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "hello" }] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "connected",
        estimateCost: false,
        attemptTimeoutMs: 25,
        totalTimeoutMs: 250,
        firstTokenTimeoutMs: 1_000,
        streamIdleTimeoutMs: 1_000,
        fallbacks: [{
          provider: "anthropic",
          model: "primary",
          apiKey: "service",
          baseUrl: "https://alternate.example.test/llm",
        }],
      },
      {},
      undefined,
      continuationRegistry,
    );

    assertEquals(calls, 3);
    assertEquals(response.answer, "done");
    assertEquals(
      response.usageAttempts?.map((attempt) => attempt.recoveryAction),
      ["retry_same", "fallback", "accept"],
    );
    const fallbackPrompt = JSON.stringify(seenMessages[2]);
    assertEquals(fallbackPrompt.includes("<think>"), true);
    assertEquals(fallbackPrompt.includes("working"), true);
    assertEquals(fallbackPrompt.includes("<recovery_cue>"), true);
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
