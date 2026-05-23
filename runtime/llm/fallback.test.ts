import {
  assertEquals,
  assertInstanceOf,
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

Deno.test("chat attempts fallback for unclassified provider errors and logs a warning", async () => {
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
      String(warnings[0][0]).includes(
        "Attempting fallback after provider error",
      ),
      true,
    );
    assertEquals((warnings[0][1] as Record<string, unknown>).reason, "unknown");
    assertEquals(
      (warnings[0][1] as Record<string, unknown>).fallbackModel,
      "fallback",
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("chat logs a warning when classified provider errors fall back", async () => {
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
        new Response("rate limited", {
          status: 429,
          statusText: "Too Many Requests",
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
      String(warnings[0][0]).includes(
        "Attempting fallback after provider error",
      ),
      true,
    );
    assertEquals(
      (warnings[0][1] as Record<string, unknown>).reason,
      "rate_limit",
    );
    assertEquals(
      (warnings[0][1] as Record<string, unknown>).fallbackModel,
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
      (warnings[0][1] as Record<string, unknown>).fallbackModel,
      "fallback",
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});
