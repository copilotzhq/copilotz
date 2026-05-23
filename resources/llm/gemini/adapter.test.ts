import { assertEquals, assertStringIncludes } from "@std/assert";

import { chat } from "@/runtime/llm/index.ts";
import { geminiProvider } from "./adapter.ts";
import { processStream } from "@/runtime/llm/utils.ts";
import type {
  ChatMessage,
  ProviderConfig,
  ProviderRegistry,
} from "@/runtime/llm/types.ts";

const messages: ChatMessage[] = [
  { role: "system", content: "Stable system instructions." },
  { role: "user", content: "Hello" },
];

Deno.test("geminiProvider defaults to an implicit-cache-capable model", () => {
  const config: ProviderConfig = { provider: "gemini", apiKey: "test" };
  const endpoint = geminiProvider(config).endpoint;

  assertStringIncludes(endpoint, "/models/gemini-2.5-flash-lite:");
});

Deno.test("geminiProvider leaves implicit caching native by default", async () => {
  const config: ProviderConfig = { provider: "gemini", apiKey: "test" };
  const body = await geminiProvider(config).body(messages, config);

  assertEquals("cachedContent" in body, false);
  assertEquals(body.systemInstruction, {
    parts: [{ text: "Stable system instructions." }],
  });
});

Deno.test("geminiProvider supports explicit cachedContent references", async () => {
  const config: ProviderConfig = {
    provider: "gemini",
    apiKey: "test",
    promptCache: {
      mode: "explicit",
      cachedContent: "cachedContents/cache-123",
    },
  };
  const body = await geminiProvider(config).body(messages, config);

  assertEquals(body.cachedContent, "cachedContents/cache-123");
  assertEquals("systemInstruction" in body, false);
});

Deno.test("geminiProvider maps cachedContentTokenCount into cache reads", () => {
  const config: ProviderConfig = { provider: "gemini", apiKey: "test" };
  const usage = geminiProvider(config).extractUsage?.({
    usageMetadata: {
      promptTokenCount: 1000,
      candidatesTokenCount: 50,
      cachedContentTokenCount: 800,
      totalTokenCount: 1050,
    },
  });

  assertEquals(usage?.inputTokens, 1000);
  assertEquals(usage?.outputTokens, 50);
  assertEquals(usage?.cacheReadInputTokens, 800);
  assertEquals(usage?.totalTokens, 1050);
});

function streamFromChunks(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

Deno.test("geminiProvider streaming parser reads cache usage from metadata-only final SSE event", async () => {
  const config: ProviderConfig = { provider: "gemini", apiKey: "test" };
  const provider = geminiProvider(config);
  const stream = streamFromChunks([
    `data: ${
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      })
    }\n\n`,
    `data: ${
      JSON.stringify({
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 1,
          cachedContentTokenCount: 800,
          totalTokenCount: 1001,
        },
      })
    }\n\n`,
  ]);

  const streamed: string[] = [];
  const result = await processStream(
    stream.getReader(),
    (chunk) => streamed.push(chunk),
    provider.extractContent,
    {
      extractUsage: provider.extractUsage,
      extractFinishReason: provider.extractFinishReason,
    },
  );

  assertEquals(streamed.join(""), "ok");
  assertEquals(result.content, "ok");
  assertEquals(result.finishReason, "stop");
  assertEquals(result.usage?.inputTokens, 1000);
  assertEquals(result.usage?.outputTokens, 1);
  assertEquals(result.usage?.cacheReadInputTokens, 800);
  assertEquals(result.usage?.totalTokens, 1001);
});

Deno.test("geminiProvider streaming parser reads cache usage from split SSE frames", async () => {
  const config: ProviderConfig = { provider: "gemini", apiKey: "test" };
  const provider = geminiProvider(config);
  const event = `data: ${
    JSON.stringify({
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 1,
        cachedContentTokenCount: 800,
        totalTokenCount: 1001,
      },
    })
  }\n\n`;
  const splitAt = Math.floor(event.length / 2);
  const stream = streamFromChunks([
    event.slice(0, splitAt),
    event.slice(splitAt),
  ]);

  const result = await processStream(
    stream.getReader(),
    () => {},
    provider.extractContent,
    {
      extractUsage: provider.extractUsage,
      extractFinishReason: provider.extractFinishReason,
    },
  );

  assertEquals(result.content, "");
  assertEquals(result.finishReason, "stop");
  assertEquals(result.usage?.cacheReadInputTokens, 800);
  assertEquals(result.usage?.rawUsage?.cachedContentTokenCount, 800);
});

Deno.test("chat preserves Gemini streaming cache usage through provider normalization", async () => {
  const originalFetch = globalThis.fetch;
  const config: ProviderConfig = { provider: "gemini", apiKey: "test" };
  const provider = geminiProvider(config);
  const registry: ProviderRegistry = {
    gemini: () => ({
      ...provider,
      endpoint: "https://example.test/gemini",
      body: () => ({ contents: [] }),
    }),
  };

  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "ok" }] } }],
          })
        }\n\n` +
          `data: ${
            JSON.stringify({
              candidates: [{ finishReason: "STOP" }],
              usageMetadata: {
                promptTokenCount: 1000,
                candidatesTokenCount: 1,
                cachedContentTokenCount: 800,
                totalTokenCount: 1001,
              },
            })
          }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    );

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "Say ok" }] },
      config,
      {},
      undefined,
      registry,
    );

    assertEquals(response.answer, "ok");
    assertEquals(response.usage?.source, "provider");
    assertEquals(response.usage?.cacheReadInputTokens, 800);
    assertEquals(response.usage?.rawUsage?.cachedContentTokenCount, 800);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
