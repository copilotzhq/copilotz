import { chat } from "./index.ts";
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
