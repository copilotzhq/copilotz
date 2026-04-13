import { chat } from "./index.ts";
import { __resetPricingCatalogCacheForTests } from "./pricing.ts";
import type { ChatRequest, ProviderConfig } from "./types.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ||
        `Assertion failed.\nExpected: ${JSON.stringify(expected)}\nActual: ${
          JSON.stringify(actual)
        }`,
    );
  }
}

async function assertRejects(
  fn: () => Promise<unknown>,
  validate?: (error: unknown) => void,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    validate?.(error);
    return;
  }

  throw new Error("Expected promise to reject");
}

function createSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

Deno.test("chat falls back to the next provider on retryable primary failure", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seenUrls.push(url);

    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response("primary failed", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.includes("api.openai.com")) {
      return new Response(
        createSSEStream([
          'data: {"choices":[{"delta":{"content":"fallback ok"}}]}\n',
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n',
          "data: [DONE]\n",
          "\n",
        ]),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const request: ChatRequest = {
      messages: [{ role: "user", content: "Oi" }],
    };
    const config: ProviderConfig = {
      provider: "gemini",
      model: "gemini-3.1-flash-lite-preview",
      apiKey: "gemini-key",
      estimateCost: false,
      fallbacks: [
        {
          provider: "openai",
          model: "gpt-5-mini",
          apiKey: "openai-key",
        },
      ],
    };

    const response = await chat(request, config, {});

    assertEquals(response.answer, "fallback ok");
    assertEquals(response.provider, "openai");
    assertEquals(response.model, "gpt-5-mini");
    assertEquals(
      seenUrls.some((url) => url.includes("generativelanguage.googleapis.com")),
      true,
    );
    assertEquals(
      seenUrls.some((url) => url.includes("api.openai.com")),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("chat does not fall back on primary auth failures", async () => {
  const originalFetch = globalThis.fetch;
  let openaiCalled = false;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response("unauthorized", {
        status: 401,
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.includes("api.openai.com")) {
      openaiCalled = true;
      return new Response("should not be called", {
        status: 200,
      });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const request: ChatRequest = {
      messages: [{ role: "user", content: "Oi" }],
    };
    const config: ProviderConfig = {
      provider: "gemini",
      model: "gemini-3.1-flash-lite-preview",
      apiKey: "gemini-key",
      estimateCost: false,
      fallbacks: [
        {
          provider: "openai",
          model: "gpt-5-mini",
          apiKey: "openai-key",
        },
      ],
    };

    await assertRejects(
      () => chat(request, config, {}),
      (error) => {
        const requestError = error as { status?: number };
        assertEquals(requestError.status, 401);
      },
    );
    assertEquals(openaiCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("chat extracts custom tags and hides them from streamed output", async () => {
  const originalFetch = globalThis.fetch;
  const streamedChunks: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (!url.includes("api.openai.com")) {
      throw new Error(`Unexpected fetch url: ${url}`);
    }

    return new Response(
      createSSEStream([
        'data: {"choices":[{"delta":{"content":"Working with the draft.<route_to>writer"}}]}\n',
        'data: {"choices":[{"delta":{"content":"</route_to>"}}]}\n',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n',
        "data: [DONE]\n",
        "\n",
      ]),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
  }) as typeof fetch;

  try {
    const request: ChatRequest = {
      messages: [{ role: "user", content: "Route this" }],
      extractTags: ["route_to"],
    };
    const config: ProviderConfig = {
      provider: "openai",
      model: "gpt-5-mini",
      apiKey: "openai-key",
      estimateCost: false,
    };

    const response = await chat(
      request,
      config,
      {},
      (chunk) => streamedChunks.push(chunk),
    );

    assertEquals(response.answer, "Working with the draft.");
    assertEquals(response.extractedTags, { route_to: ["writer"] });
    assertEquals(streamedChunks.join(""), "Working with the draft.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("chat enriches responses with estimated cost when pricing is available", async () => {
  __resetPricingCatalogCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("openrouter.ai/api/v1/models")) {
      return new Response(JSON.stringify({
        data: [{
          id: "openai/gpt-5-mini",
          pricing: {
            prompt: "0.000001",
            completion: "0.000002",
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("api.openai.com")) {
      return new Response(
        createSSEStream([
          'data: {"choices":[{"delta":{"content":"priced ok"}}]}\n',
          'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n',
          "data: [DONE]\n",
          "\n",
        ]),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const response = await chat(
      {
        messages: [{ role: "user", content: "Oi" }],
      },
      {
        provider: "openai",
        model: "gpt-5-mini",
        apiKey: "openai-key",
      },
      {},
    );

    assertEquals(response.answer, "priced ok");
    assertEquals(response.cost, {
      source: "openrouter",
      currency: "USD",
      pricingModelId: "openai/gpt-5-mini",
      inputCostUsd: 0.0001,
      outputCostUsd: 0.00004,
      totalCostUsd: 0.00014,
    });
  } finally {
    globalThis.fetch = originalFetch;
    __resetPricingCatalogCacheForTests();
  }
});

Deno.test("chat ignores pricing lookup failures without affecting the response", async () => {
  __resetPricingCatalogCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("openrouter.ai/api/v1/models")) {
      return new Response("unavailable", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.includes("api.openai.com")) {
      return new Response(
        createSSEStream([
          'data: {"choices":[{"delta":{"content":"still ok"}}]}\n',
          'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n',
          "data: [DONE]\n",
          "\n",
        ]),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const response = await chat(
      {
        messages: [{ role: "user", content: "Oi" }],
      },
      {
        provider: "openai",
        model: "gpt-5-mini",
        apiKey: "openai-key",
      },
      {},
    );

    assertEquals(response.answer, "still ok");
    assertEquals(response.cost, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    __resetPricingCatalogCacheForTests();
  }
});
