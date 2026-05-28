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
        { provider: "anthropic", model: "claude-test", apiKey: "test" },
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
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ event: "progress" })}\n\n`,
              ),
            );
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
        firstTokenTimeoutMs: 5,
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

Deno.test("chat recovers mid-stream by falling back with partial content as context", async () => {
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
        streamIdleTimeoutMs: 5,
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      (chunk) => streamedChunks.push(chunk),
      registry,
    );

    assertEquals(response.answer, "hello world");
    assertEquals(streamedChunks.join(""), "hello world");
    assertEquals(response.model, "fallback");
    assertEquals(calls, 2);
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

Deno.test("chat retries same model once on finishReason=length then falls back", async () => {
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
          { choices: [{ delta: { content: "Hello" } }] },
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
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      (chunk) => streamed.push(chunk),
      registry,
    );

    // call 1: primary (length) → call 2: retry same (length) → call 3: fallback (stop)
    assertEquals(calls, 3);
    assertEquals(response.answer, "HelloHello world");
    assertEquals(response.model, "fallback");
    assertEquals(warnings.length, 2);
    assertEquals(
      (warnings[0][1] as Record<string, unknown>).reason,
      "length",
    );
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
      { provider: "anthropic", model: "primary", apiKey: "test" },
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

Deno.test("chat falls back to next provider on finishReason=error", async () => {
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
        fallbacks: [{ provider: "anthropic", model: "fallback" }],
      },
      {},
      (chunk) => streamed.push(chunk),
      registry,
    );

    assertEquals(calls, 2);
    assertEquals(response.answer, "partial completed");
    assertEquals(response.model, "fallback");
    assertEquals(streamed.join(""), "partial completed");
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
      { provider: "anthropic", model: "primary", apiKey: "test" },
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
