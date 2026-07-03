import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { chat, LLMProviderError } from "@/runtime/llm/index.ts";
import type { ProviderRegistry } from "@/runtime/llm/types.ts";

const registry: ProviderRegistry = {
  anthropic: () => ({
    endpoint: "https://example.test/anthropic",
    headers: () => ({}),
    body: () => ({}),
    extractContent: (data: any) => {
      const content = data?.choices?.[0]?.delta?.content;
      return typeof content === "string" && content.length > 0
        ? [{ text: content }]
        : null;
    },
    extractFinishReason: (data: any) =>
      data?.choices?.[0]?.finish_reason ?? null,
  }),
};

Deno.test("chat wraps provider rate limits as structured LLMProviderError when no fallback is configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response("rate limited", {
        status: 429,
        statusText: "Too Many Requests",
      }),
    );

  try {
    let thrown: unknown;
    try {
      await chat(
        { messages: [{ role: "user", content: "hello" }] },
        {
          provider: "anthropic",
          model: "claude-test",
          apiKey: "test",
          estimateCost: false,
        },
        {},
        undefined,
        registry,
      );
    } catch (error) {
      thrown = error;
    }

    assertInstanceOf(thrown, LLMProviderError);
    assertEquals(thrown.reason, "rate_limit");
    assertEquals(thrown.provider, "anthropic");
    assertEquals(thrown.model, "claude-test");
    assertEquals(thrown.status, 429);
    assertEquals(thrown.fallbackAttempted, false);
    assertEquals(thrown.attempts.length, 1);
    assertEquals(thrown.attempts[0].reason, "rate_limit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("chat attempts fallback for any provider error when fallbacks are configured", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  let calls = 0;

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) throw "provider melted oddly";
    return Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          })
        }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
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
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      undefined,
      registry,
    );

    assertEquals(response.answer, "ok");
    assertEquals(response.model, "fallback");
    assertEquals(calls, 2);
    assertEquals(warnings.length, 1);
    assertEquals(
      String(warnings[0][0]).includes("Attempting recovery"),
      true,
    );
    assertEquals((warnings[0][1] as Record<string, unknown>).reason, "unknown");
    assertEquals(
      (warnings[0][1] as Record<string, unknown>).nextModel,
      "fallback",
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat materializes messages separately for each provider attempt", async () => {
  const originalFetch = globalThis.fetch;
  const seenContents: string[] = [];
  let calls = 0;

  const registry: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/anthropic",
      headers: () => ({}),
      body: (messages) => {
        seenContents.push(String(messages[0]?.content ?? ""));
        return {};
      },
      extractContent: () => null,
    }),
    openai: () => ({
      endpoint: "https://example.test/openai",
      headers: () => ({}),
      body: (messages) => {
        seenContents.push(String(messages[0]?.content ?? ""));
        return {};
      },
      extractContent: (data: any) => {
        const content = data?.choices?.[0]?.delta?.content;
        return typeof content === "string" && content.length > 0
          ? [{ text: content }]
          : null;
      },
    }),
  };

  globalThis.fetch = (url) => {
    calls += 1;
    if (String(url).includes("/anthropic")) {
      return Promise.resolve(
        new Response("bad anthropic request", {
          status: 400,
          statusText: "Bad Request",
        }),
      );
    }
    return Promise.resolve(
      sse([
        { choices: [{ delta: { content: "ok" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
  };

  try {
    const response = await chat(
      {
        messages: [{ role: "user", content: "hello" }],
        materializeMessages: (messages, config) =>
          messages.map((message) => ({
            ...message,
            content: `${message.content} via ${config.provider}`,
          })),
      },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
        fallbacks: [{ provider: "openai", model: "fallback" }],
      },
      {},
      undefined,
      registry,
    );

    assertEquals(response.answer, "ok");
    assertEquals(response.provider, "openai");
    assertEquals(calls, 2);
    assertEquals(seenContents, ["hello via anthropic", "hello via openai"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("chat falls back for auth failures and logs a warning", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  let calls = 0;

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        new Response("forbidden", {
          status: 403,
          statusText: "Forbidden",
        }),
      );
    }
    return Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          })
        }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
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
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      undefined,
      registry,
    );

    assertEquals(response.answer, "ok");
    assertEquals(response.model, "fallback");
    assertEquals(calls, 2);
    assertEquals(warnings.length, 1);
    assertEquals(
      (warnings[0][1] as Record<string, unknown>).reason,
      "auth_error",
    );
    assertEquals(
      (warnings[0][1] as Record<string, unknown>).nextModel,
      "fallback",
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat resolves provider-specific fallback api keys when provider changes", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const registry: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/anthropic",
      headers: (config) => ({ "x-api-key": config.apiKey ?? "" }),
      body: () => ({}),
      extractContent: () => null,
    }),
    openai: () => ({
      endpoint: "https://example.test/openai",
      headers: (config) => ({ Authorization: `Bearer ${config.apiKey}` }),
      body: () => ({}),
      extractContent: (data: any) => {
        const content = data?.choices?.[0]?.delta?.content;
        return typeof content === "string" && content.length > 0
          ? [{ text: content }]
          : null;
      },
    }),
  };

  globalThis.fetch = (url, init?: RequestInit) => {
    const requestInit = init as { headers?: HeadersInit } | undefined;
    const headers = new Headers(requestInit?.headers);
    calls.push({
      url: String(url),
      authorization: headers.get("authorization") ??
        headers.get("x-api-key"),
    });

    if (String(url).includes("/anthropic")) {
      return Promise.resolve(
        new Response("bad anthropic request", {
          status: 400,
          statusText: "Bad Request",
        }),
      );
    }

    if (headers.get("authorization") !== "Bearer openai-secret") {
      return Promise.resolve(
        new Response("wrong key", {
          status: 401,
          statusText: "Unauthorized",
        }),
      );
    }

    return Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          })
        }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "hello" }] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "anthropic-secret",
        estimateCost: false,
        fallbacks: [{ provider: "openai", model: "fallback" }],
      },
      { OPENAI_API_KEY: "openai-secret" },
      undefined,
      registry,
    );

    assertEquals(response.answer, "ok");
    assertEquals(response.provider, "openai");
    assertEquals(response.model, "fallback");
    assertEquals(calls.length, 2);
    assertEquals(calls[0].authorization, "anthropic-secret");
    assertEquals(calls[1].authorization, "Bearer openai-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("chat falls back when first extracted token times out", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (_url, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      const signal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener(
                "abort",
                () => {
                  controller.error(new DOMException("Aborted", "AbortError"));
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    }

    return Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          })
        }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
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
        firstTokenTimeoutMs: 5,
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      undefined,
      registry,
    );

    assertEquals(response.answer, "ok");
    assertEquals(response.model, "fallback");
    assertEquals(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("chat treats provider stream activity as progress before extracted text", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let calls = 0;
  const registry: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/activity",
      headers: () => ({}),
      body: () => ({}),
      isStreamActivity: (data: any) => data?.event === "progress",
      extractContent: (data: any) =>
        typeof data?.content === "string" && data.content.length > 0
          ? [{ text: data.content }]
          : null,
    }),
  };

  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // Activity event resets the first-token timer, keeping it alive
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ event: "progress" })}\n\n`,
              ),
            );
            // Content arrives within the (reset) first-token window
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ content: "ok" })}\n\n`,
                ),
              );
              controller.close();
            }, 20);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
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
        firstTokenTimeoutMs: 30,
        streamIdleTimeoutMs: 50,
      },
      {},
      undefined,
      registry,
    );

    assertEquals(response.answer, "ok");
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("chat enforces idle timeout even when fetch abort does not break the reader", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let cancelled = false;

  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${
                  JSON.stringify({ choices: [{ delta: { content: "hi" } }] })
                }\n\n`,
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );

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
            streamIdleTimeoutMs: 5,
          },
          {},
          undefined,
          registry,
        ),
      LLMProviderError,
    );

    assertEquals(error.reason, "timeout");
    assertEquals(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("chat continues after mid-stream timeout using visible context", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const streamedChunks: string[] = [];
  let calls = 0;

  globalThis.fetch = (_url, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      const signal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${
                    JSON.stringify({
                      choices: [{
                        delta: { content: "hello " },
                        finish_reason: null,
                      }],
                    })
                  }\n\n`,
                ),
              );
              signal?.addEventListener(
                "abort",
                () => {
                  controller.error(new DOMException("Aborted", "AbortError"));
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    }

    return Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: "world" }, finish_reason: "stop" }],
          })
        }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
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
        streamIdleTimeoutMs: 5,
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      (chunk) => streamedChunks.push(chunk),
      registry,
    );

    assertEquals(response.answer, "hello world");
    assertEquals(response.finishReason, "stop");
    assertEquals(streamedChunks.join(""), "hello world");
    assertEquals(response.model, "primary");
    assertEquals(calls, 2);
    assertEquals(response.usageAttempts?.length, 2);
    assertEquals(response.usageAttempts?.[0]?.visibleOutputStarted, true);
    assertEquals(response.usageAttempts?.[0]?.usage.statusReason, "timeout");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("chat continues after provider stream error using visible and reasoning context", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const streamedChunks: string[] = [];
  const seenMessages: Array<Array<{ role?: string; content?: unknown }>> = [];
  let calls = 0;
  const reasoningRegistry: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/anthropic",
      headers: () => ({}),
      body: (messages) => {
        seenMessages.push(
          messages as Array<{ role?: string; content?: unknown }>,
        );
        return {};
      },
      extractContent: (data: any) => {
        const delta = data?.choices?.[0]?.delta;
        const parts: Array<{ text: string; isReasoning?: boolean }> = [];
        if (typeof delta?.reasoning === "string") {
          parts.push({ text: delta.reasoning, isReasoning: true });
        }
        if (typeof delta?.content === "string") {
          parts.push({ text: delta.content });
        }
        return parts.length > 0 ? parts : null;
      },
      extractFinishReason: (data: any) =>
        data?.choices?.[0]?.finish_reason ?? null,
    }),
  };

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${
                    JSON.stringify({
                      choices: [{
                        delta: { reasoning: "Need a careful wrap." },
                      }],
                    })
                  }\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${
                    JSON.stringify({
                      choices: [{ delta: { content: "partial answer" } }],
                    })
                  }\n\n`,
                ),
              );
              setTimeout(() => controller.error(new Error("network lost")), 0);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    }

    return Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            choices: [{
              delta: { content: " continued." },
              finish_reason: "stop",
            }],
          })
        }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
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
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      (chunk, options) => {
        if (!options?.isReasoning) streamedChunks.push(chunk);
      },
      reasoningRegistry,
    );

    assertEquals(calls, 2);
    assertEquals(response.answer, "partial answer continued.");
    assertEquals(response.reasoning, "Need a careful wrap.");
    assertEquals(response.finishReason, "stop");
    assertEquals(response.model, "primary");
    assertEquals(response.usageAttempts?.length, 2);
    assertEquals(response.usageAttempts?.[0]?.visibleOutputStarted, true);
    assertEquals(response.usageAttempts?.[0]?.usage.statusReason, "network");
    assertEquals(streamedChunks.join(""), "partial answer continued.");

    const retryMessages = seenMessages[1] ?? [];
    const retryAssistant = retryMessages.find((message) =>
      message.role === "assistant" &&
      String(message.content ?? "").includes("partial answer")
    );
    const retryUser = retryMessages.find((message) =>
      message.role === "user" &&
      String(message.content ?? "").includes(
        "Continue exactly where you left off",
      )
    );
    assertEquals(
      retryAssistant?.content,
      "<think>\nNeed a careful wrap.\n</think>\n\npartial answer",
    );
    assertEquals(Boolean(retryUser), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// finishReason-based recovery
// ---------------------------------------------------------------------------

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(
    "",
  );
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

Deno.test("chat retries same model once on finishReason=length then returns visible partial", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  const streamed: string[] = [];
  let calls = 0;

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  globalThis.fetch = () => {
    calls += 1;
    if (calls <= 2) {
      // Primary: truncated both times
      return Promise.resolve(
        sse([
          {
            choices: [{
              delta: { content: calls === 1 ? "Hello " : "again" },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "length" }] },
        ]),
      );
    }
    // Fallback: completes
    return Promise.resolve(
      sse([
        { choices: [{ delta: { content: " world" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
  };

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "Say hello" }] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      (chunk) => streamed.push(chunk),
      registry,
    );

    // call 1: primary (length) -> call 2: retry same (length), then stop
    // because visible text has already reached the user.
    assertEquals(calls, 2);
    assertEquals(response.answer, "Hello again");
    assertEquals(response.model, "primary");
    assertEquals(response.finishReason, "length");
    assertEquals(streamed.join(""), "Hello again");
    assertEquals(warnings.length, 1);
    assertEquals(
      (warnings[0][1] as Record<string, unknown>).reason,
      "length",
    );
    assertEquals(response.usage?.statusReason, "length");
    assertEquals(response.usageAttempts?.length, 2);
    assertEquals(response.usageAttempts?.[0]?.visibleOutputStarted, true);
    assertEquals(response.usageAttempts?.[1]?.visibleOutputStarted, true);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat recovers from finishReason=length with same model when continuation completes", async () => {
  const originalFetch = globalThis.fetch;
  const streamed: string[] = [];
  let calls = 0;

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        sse([
          { choices: [{ delta: { content: "part one" } }] },
          { choices: [{ delta: {}, finish_reason: "length" }] },
        ]),
      );
    }
    return Promise.resolve(
      sse([
        { choices: [{ delta: { content: " part two" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
  };

  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "hello" }] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
      },
      {},
      (chunk) => streamed.push(chunk),
      registry,
    );

    assertEquals(calls, 2);
    assertEquals(response.answer, "part one part two");
    assertEquals(response.model, "primary");
    assertEquals(response.finishReason, "stop");
    assertEquals(streamed.join(""), "part one part two");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat falls back to next provider on finishReason=content_filter", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        sse([
          { choices: [{ delta: { content: "" } }] },
          { choices: [{ delta: {}, finish_reason: "content_filter" }] },
        ]),
      );
    }
    return Promise.resolve(
      sse([
        { choices: [{ delta: { content: "safe response" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
  };

  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "hello" }] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      undefined,
      registry,
    );

    assertEquals(calls, 2);
    assertEquals(response.answer, "safe response");
    assertEquals(response.model, "fallback");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat returns visible partial on finishReason=content_filter without fallback", async () => {
  const originalFetch = globalThis.fetch;
  const streamed: string[] = [];
  let calls = 0;

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        sse([
          { choices: [{ delta: { content: "partial answer" } }] },
          { choices: [{ delta: {}, finish_reason: "content_filter" }] },
        ]),
      );
    }
    return Promise.resolve(
      sse([
        { choices: [{ delta: { content: "fallback answer" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
  };

  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "hello" }] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      (chunk) => streamed.push(chunk),
      registry,
    );

    assertEquals(calls, 1);
    assertEquals(response.answer, "partial answer");
    assertEquals(response.model, "primary");
    assertEquals(response.finishReason, "content_filter");
    assertEquals(response.usage?.status, "aborted");
    assertEquals(response.usage?.statusReason, "content_filter");
    assertEquals(response.usageAttempts?.length, 1);
    assertEquals(response.usageAttempts?.[0]?.visibleOutputStarted, true);
    assertEquals(streamed.join(""), "partial answer");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat returns visible partial on finishReason=error without fallback", async () => {
  const originalFetch = globalThis.fetch;
  const streamed: string[] = [];
  let calls = 0;

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        sse([
          { choices: [{ delta: { content: "partial " } }] },
          { choices: [{ delta: {}, finish_reason: "error" }] },
        ]),
      );
    }
    return Promise.resolve(
      sse([
        { choices: [{ delta: { content: "completed" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
  };

  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "hello" }] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      (chunk) => streamed.push(chunk),
      registry,
    );

    assertEquals(calls, 1);
    assertEquals(response.answer, "partial");
    assertEquals(response.model, "primary");
    assertEquals(response.finishReason, "error");
    assertEquals(response.usage?.status, "aborted");
    assertEquals(response.usage?.statusReason, "error");
    assertEquals(response.usageAttempts?.length, 1);
    assertEquals(response.usageAttempts?.[0]?.visibleOutputStarted, true);
    assertEquals(streamed.join(""), "partial ");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// Empty-response recovery
// ---------------------------------------------------------------------------

Deno.test("chat retries then falls back when model produces empty response", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  let calls = 0;

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  globalThis.fetch = () => {
    calls += 1;
    if (calls <= 2) {
      // Primary: streams nothing useful, finishes with stop
      return Promise.resolve(
        sse([
          { choices: [{ delta: { content: " " } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      );
    }
    // Fallback: actual answer
    return Promise.resolve(
      sse([
        { choices: [{ delta: { content: "real answer" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
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
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      undefined,
      registry,
    );

    // call 1: primary (empty) → call 2: retry same (empty) → call 3: fallback
    assertEquals(calls, 3);
    assertEquals(response.answer, "real answer");
    assertEquals(response.model, "fallback");
    assertEquals(warnings.length, 2);
    assertEquals(
      (warnings[0][1] as Record<string, unknown>).reason,
      "empty_response",
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat recovers from empty response on same model retry", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;

  console.warn = () => {};

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      // Empty first attempt
      return Promise.resolve(
        sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]),
      );
    }
    // Retry succeeds
    return Promise.resolve(
      sse([
        { choices: [{ delta: { content: "got it" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
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
      },
      {},
      undefined,
      registry,
    );

    assertEquals(calls, 2);
    assertEquals(response.answer, "got it");
    assertEquals(response.model, "primary");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat does NOT retry when empty response is intentional (no_response)", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;

  console.warn = () => {};

  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(
      sse([
        { choices: [{ delta: { content: "<no_response/>" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
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
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      undefined,
      registry,
    );

    assertEquals(calls, 1);
    assertEquals(response.answer, "");
    assertEquals(response.model, "primary");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat strips visible reasoning markup without retrying after streamed text", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  let calls = 0;
  let streamed = "";

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        sse([
          {
            choices: [{
              delta: {
                content: "Visible <thought>tag reasoning</thought>answer",
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      );
    }
    return Promise.resolve(
      sse([
        {
          choices: [{
            delta: {
              content: "Clean answer",
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
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
      },
      {},
      (chunk) => {
        streamed += chunk;
      },
      registry,
    );

    assertEquals(calls, 1);
    assertEquals(response.answer, "Visible answer");
    assertEquals(response.usage?.statusReason, "visible_reasoning_markup");
    assertEquals(response.usageAttempts?.length, 1);
    assertEquals(response.usageAttempts?.[0]?.visibleOutputStarted, true);
    assertEquals(streamed.includes("<thought>"), false);
    assertEquals(streamed.includes("tag reasoning"), false);
    assertEquals(
      warnings.some((w) =>
        (w[1] as Record<string, unknown>)?.reason ===
          "visible_reasoning_markup"
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat strips visible reasoning markup after exhausted recovery", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let streamed = "";

  console.warn = () => {};

  globalThis.fetch = () =>
    Promise.resolve(
      sse([
        {
          choices: [{
            delta: {
              content: "Visible answer.\n\n<think>private reasoning",
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "hello" }] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
      },
      {},
      (chunk) => {
        streamed += chunk;
      },
      registry,
    );

    assertEquals(response.answer, "Visible answer.");
    assertEquals(response.reasoning, undefined);
    assertEquals(streamed.includes("<think>"), false);
    assertEquals(streamed.includes("private reasoning"), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat preserves provider-native reasoning deltas", async () => {
  const originalFetch = globalThis.fetch;
  const reasoningRegistry: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/anthropic",
      headers: () => ({}),
      body: () => ({}),
      extractContent: (data: any) => {
        const content = data?.choices?.[0]?.delta?.content;
        const reasoning = data?.choices?.[0]?.delta?.reasoning;
        const parts = [];
        if (typeof reasoning === "string" && reasoning.length > 0) {
          parts.push({ text: reasoning, isReasoning: true });
        }
        if (typeof content === "string" && content.length > 0) {
          parts.push({ text: content });
        }
        return parts.length > 0 ? parts : null;
      },
      extractFinishReason: (data: any) =>
        data?.choices?.[0]?.finish_reason ?? null,
    }),
  };

  globalThis.fetch = () =>
    Promise.resolve(
      sse([
        { choices: [{ delta: { reasoning: "provider reasoning" } }] },
        { choices: [{ delta: { content: "Answer" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "hello" }] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
      },
      {},
      undefined,
      reasoningRegistry,
    );

    assertEquals(response.answer, "Answer");
    assertEquals(response.reasoning, "provider reasoning");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("chat retries when response contains only thinking markup", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;

  console.warn = () => {};

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        sse([
          {
            choices: [{
              delta: {
                content: "<think>thinking only</think>",
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      );
    }
    return Promise.resolve(
      sse([
        { choices: [{ delta: { content: "visible now" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
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
      },
      {},
      undefined,
      registry,
    );

    assertEquals(calls, 2);
    assertEquals(response.answer, "visible now");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// Malformed tool-call recovery
// ---------------------------------------------------------------------------

const searchTool = {
  type: "function" as const,
  function: {
    name: "search",
    description: "search",
    inputTypes: "export interface SearchInput { query?: string; }\n",
  },
};

Deno.test("chat quarantines and retries a tagless orphaned tool-result tail", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const seenMessages: Array<Array<{ role?: string; content?: unknown }>> = [];
  const streamed: string[] = [];
  let calls = 0;

  console.warn = () => {};
  const orphanRegistry: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/anthropic",
      headers: () => ({}),
      body: (messages) => {
        seenMessages.push(
          messages as Array<{ role?: string; content?: unknown }>,
        );
        return {};
      },
      extractContent: (data: any) => {
        const content = data?.choices?.[0]?.delta?.content;
        return typeof content === "string" && content.length > 0
          ? [{ text: content }]
          : null;
      },
      extractFinishReason: (data: any) =>
        data?.choices?.[0]?.finish_reason ?? null,
    }),
  };
  const leak =
    '"}]}],"success":true,"stoppedEarly":false,"sessionSummary":{"status":"idle"},"tool_call_id":"verify_live_preview","status":"completed"}';

  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(
      calls === 1
        ? sse([
          { choices: [{ delta: { content: leak } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ])
        : sse([
          { choices: [{ delta: { content: "Recovered answer." } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
    );
  };

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "verify it" }] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
      },
      {},
      (chunk, options) => {
        if (!options?.isReasoning) streamed.push(chunk);
      },
      orphanRegistry,
    );

    assertEquals(calls, 2);
    assertEquals(response.answer, "Recovered answer.");
    assertEquals(streamed.join(""), "Recovered answer.");
    assertEquals(
      response.usageAttempts?.[0]?.usage.statusReason,
      "orphaned_tool_result",
    );
    assertEquals(
      seenMessages[1]?.some((message) =>
        message.role === "user" &&
        String(message.content ?? "").includes(
          "imitated a tool-result payload",
        )
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat retries same model when output degenerates into repetition", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const seenMessages: Array<Array<{ role?: string; content?: unknown }>> = [];
  let calls = 0;

  console.warn = () => {};

  const repetitionRegistry: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/anthropic",
      headers: () => ({}),
      body: (messages) => {
        seenMessages.push(
          messages as Array<{ role?: string; content?: unknown }>,
        );
        return {};
      },
      extractContent: (data: any) => {
        const content = data?.choices?.[0]?.delta?.content;
        return typeof content === "string" && content.length > 0
          ? [{ text: content }]
          : null;
      },
      extractFinishReason: (data: any) =>
        data?.choices?.[0]?.finish_reason ?? null,
    }),
  };

  const repeated = "the task is blocked because ownership cannot be verified "
    .repeat(14);

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        sse([
          { choices: [{ delta: { content: "I updated the board. " } }] },
          { choices: [{ delta: { content: repeated } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      );
    }

    return Promise.resolve(
      sse([
        {
          choices: [{
            delta: { content: "The blocked cards are now marked." },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
  };

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "update board" }] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
      },
      {},
      undefined,
      repetitionRegistry,
    );

    assertEquals(calls, 2);
    assertEquals(
      response.answer,
      "I updated the board. The blocked cards are now marked.",
    );
    assertEquals(response.usageAttempts?.length, 2);
    assertEquals(
      response.usageAttempts?.[0]?.usage.statusReason,
      "degenerate_repetition",
    );
    assertEquals(response.usageAttempts?.[1]?.usage.statusReason, undefined);

    const retryMessages = seenMessages[1] ?? [];
    const retryAssistant = retryMessages.find((message) =>
      message.role === "assistant" &&
      String(message.content ?? "").includes("I updated the board.")
    );
    const retryUser = retryMessages.find((message) =>
      message.role === "user" &&
      String(message.content ?? "").includes("degenerated into repeated text")
    );

    assertEquals(retryAssistant?.content, "I updated the board.");
    assertEquals(Boolean(retryUser), true);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat reuses malformed-tool prefix and allowed reasoning in retry context", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const seenMessages: Array<Array<{ role?: string; content?: unknown }>> = [];
  const streamed: string[] = [];
  let calls = 0;

  console.warn = () => {};

  const reasoningRegistry: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/anthropic",
      headers: () => ({}),
      body: (messages) => {
        seenMessages.push(
          messages as Array<{ role?: string; content?: unknown }>,
        );
        return {};
      },
      extractContent: (data: any) => {
        const delta = data?.choices?.[0]?.delta;
        const parts: Array<{ text: string; isReasoning?: boolean }> = [];
        if (typeof delta?.reasoning === "string") {
          parts.push({ text: delta.reasoning, isReasoning: true });
        }
        if (typeof delta?.content === "string") {
          parts.push({ text: delta.content });
        }
        return parts.length > 0 ? parts : null;
      },
      extractFinishReason: (data: any) =>
        data?.choices?.[0]?.finish_reason ?? null,
    }),
  };

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        sse([
          { choices: [{ delta: { reasoning: "Need to search." } }] },
          { choices: [{ delta: { content: "Let me check." } }] },
          {
            choices: [{
              delta: {
                content:
                  '<invoke name="search"><parameter name="q">hello</parameter></invoke>',
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      );
    }

    return Promise.resolve(
      sse([
        {
          choices: [{
            delta: {
              content:
                '<tool_calls>\n{"name":"search","arguments":{"q":"hello"}}\n</tool_calls>',
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
  };

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "hi" }], tools: [searchTool] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
      },
      {},
      (chunk, options) => {
        if (!options?.isReasoning) streamed.push(chunk);
      },
      reasoningRegistry,
    );

    assertEquals(calls, 2);
    assertEquals(response.answer, "Let me check.");
    assertEquals(response.toolCalls?.length, 1);
    assertEquals(streamed.join(""), "Let me check.");

    const retryMessages = seenMessages[1] ?? [];
    const retryAssistant = retryMessages.find((message) =>
      message.role === "assistant" &&
      String(message.content ?? "").includes("Let me check.")
    );
    const retryUser = retryMessages.find((message) =>
      message.role === "user" &&
      String(message.content ?? "").includes(
        "emit only the corrected <tool_calls> block",
      )
    );
    assertEquals(retryAssistant?.role, "assistant");
    assertEquals(
      retryAssistant?.content,
      "<think>\nNeed to search.\n</think>\n\nLet me check.",
    );

    const recoveryCue = String(retryUser?.content ?? "");
    assertEquals(recoveryCue.includes("<recovery_cue>"), true);
    assertEquals(
      recoveryCue.includes("emit only the corrected <tool_calls> block"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat omits malformed-tool retry reasoning when reasoning history is disabled", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const seenMessages: Array<Array<{ role?: string; content?: unknown }>> = [];
  let calls = 0;

  console.warn = () => {};

  const reasoningRegistry: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/anthropic",
      headers: () => ({}),
      body: (messages) => {
        seenMessages.push(
          messages as Array<{ role?: string; content?: unknown }>,
        );
        return {};
      },
      extractContent: (data: any) => {
        const delta = data?.choices?.[0]?.delta;
        const parts: Array<{ text: string; isReasoning?: boolean }> = [];
        if (typeof delta?.reasoning === "string") {
          parts.push({ text: delta.reasoning, isReasoning: true });
        }
        if (typeof delta?.content === "string") {
          parts.push({ text: delta.content });
        }
        return parts.length > 0 ? parts : null;
      },
      extractFinishReason: (data: any) =>
        data?.choices?.[0]?.finish_reason ?? null,
    }),
  };

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        sse([
          { choices: [{ delta: { reasoning: "Need to search." } }] },
          { choices: [{ delta: { content: "Let me check." } }] },
          {
            choices: [{
              delta: {
                content:
                  '<invoke name="search"><parameter name="q">hello</parameter></invoke>',
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      );
    }

    return Promise.resolve(
      sse([
        {
          choices: [{
            delta: {
              content:
                '<tool_calls>\n{"name":"search","arguments":{"q":"hello"}}\n</tool_calls>',
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
  };

  try {
    const response = await chat(
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [searchTool],
        reasoningHistory: { include: "none" },
      },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
      },
      {},
      undefined,
      reasoningRegistry,
    );

    assertEquals(calls, 2);
    assertEquals(response.answer, "Let me check.");
    assertEquals(response.toolCalls?.length, 1);
    const retryAssistant = (seenMessages[1] ?? []).find((message) =>
      message.role === "assistant" &&
      String(message.content ?? "").includes("Let me check.")
    );
    assertEquals(retryAssistant?.content, "Let me check.");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat retries non-canonical <invoke>/<parameter> tool dialect", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  let calls = 0;

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        sse([
          {
            choices: [{
              delta: {
                content:
                  '<minimax:tool_call><invoke name="search"><parameter name="q">hello</parameter></invoke></minimax:tool_call>',
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      );
    }
    return Promise.resolve(
      sse([
        {
          choices: [{
            delta: {
              content:
                '<tool_calls>\n{"name":"search","arguments":{"q":"hello"}}\n</tool_calls>',
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
  };

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "hi" }], tools: [searchTool] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
      },
      {},
      undefined,
      registry,
    );

    assertEquals(calls, 2);
    assertEquals(response.toolCalls?.length, 1);
    assertEquals(response.toolCalls?.[0].tool.id, "search");
    assertEquals(JSON.parse(response.toolCalls?.[0].args as string), {
      q: "hello",
    });
    assertEquals(response.answer.includes("<invoke"), false);
    assertEquals(
      warnings.some((w) =>
        (w[1] as Record<string, unknown>)?.reason === "malformed_tool_call"
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat retries on a malformed tool call then recovers the canonical format", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  let calls = 0;

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      // Native dialect with unparseable args (no <parameter> tags).
      return Promise.resolve(
        sse([
          {
            choices: [{
              delta: {
                content:
                  '<minimax:tool_call><invoke name="search"><actions><item>x</item></actions></invoke></minimax:tool_call>',
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      );
    }
    return Promise.resolve(
      sse([
        {
          choices: [{
            delta: {
              content:
                '<tool_calls>\n{"name":"search","arguments":{"q":"x"}}\n</tool_calls>',
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
  };

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "hi" }], tools: [searchTool] },
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
      },
      {},
      undefined,
      registry,
    );

    assertEquals(calls, 2);
    assertEquals(response.toolCalls?.length, 1);
    assertEquals(response.toolCalls?.[0].tool.id, "search");
    assertEquals(
      warnings.some((w) =>
        (w[1] as Record<string, unknown>)?.reason === "malformed_tool_call"
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat does NOT retry when empty response has tool calls", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;

  console.warn = () => {};

  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(
      sse([
        {
          choices: [{
            delta: {
              content:
                '<tool_calls>\n{"name":"search","arguments":{"q":"test"}}\n</tool_calls>',
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
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
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      undefined,
      registry,
    );

    assertEquals(calls, 1);
    assertEquals(response.answer, "");
    assertEquals(response.toolCalls!.length, 1);
    assertEquals(response.model, "primary");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});
