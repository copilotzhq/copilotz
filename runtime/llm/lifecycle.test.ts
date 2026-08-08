import { assertEquals, assertRejects } from "@std/assert";

import { chat } from "./index.ts";
import type { ProviderRegistry } from "./types.ts";

const registry: ProviderRegistry = {
  openai: () => ({
    endpoint: "https://example.test/openai",
    headers: () => ({}),
    body: () => ({}),
    extractContent: (data: unknown) => {
      const value = data as {
        choices?: Array<{ delta?: { content?: unknown } }>;
      };
      const content = value.choices?.[0]?.delta?.content;
      return typeof content === "string" ? [{ text: content }] : null;
    },
    extractFinishReason: () => "stop",
  }),
};

function providerResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

Deno.test("strict attempt lifecycle makes durable callback failures fatal before provider work", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = () => {
    fetched = true;
    return Promise.resolve(providerResponse());
  };
  try {
    await assertRejects(
      () =>
        chat(
          {
            messages: [{ role: "user", content: "hello" }],
            strictAttemptLifecycle: true,
            onAttemptLifecycle: () => {
              throw new Error("durable lifecycle write failed");
            },
          },
          {
            provider: "openai",
            model: "test",
            apiKey: "test",
            estimateCost: false,
          },
          {},
          undefined,
          registry,
        ),
      Error,
      "durable lifecycle write failed",
    );
    assertEquals(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("diagnostic attempt lifecycle observers remain non-fatal by default", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let warnings = 0;
  globalThis.fetch = () => Promise.resolve(providerResponse());
  console.warn = () => {
    warnings += 1;
  };
  try {
    const result = await chat(
      {
        messages: [{ role: "user", content: "hello" }],
        onAttemptLifecycle: () => {
          throw new Error("diagnostic observer failed");
        },
      },
      {
        provider: "openai",
        model: "test",
        apiKey: "test",
        estimateCost: false,
      },
      {},
      undefined,
      registry,
    );
    assertEquals(result.answer, "ok");
    assertEquals(warnings, 2);
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
  }
});
