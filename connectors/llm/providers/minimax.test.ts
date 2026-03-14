import { minimaxProvider } from "./minimax.ts";
import { getProvider } from "./index.ts";
import type { ChatMessage, ProviderConfig } from "../types.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ||
        `Assertion failed.\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
    );
  }
}

function assertExists<T>(value: T, message?: string): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(message || "Expected value to exist");
  }
}

Deno.test("minimax provider is registered", () => {
  const provider = getProvider("minimax");
  assertEquals(provider, minimaxProvider);
});

Deno.test("minimax provider builds chatcompletion_v2 request body", () => {
  const config: ProviderConfig = {
    provider: "minimax",
    apiKey: "test-key",
    model: "M2-her",
    temperature: 0.7,
    topP: 0.8,
    maxCompletionTokens: 4096,
  };

  const provider = minimaxProvider(config);
  const messages: ChatMessage[] = [
    { role: "system", content: "You are helpful." },
    {
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
      ],
    },
  ];

  const body = provider.body(messages, config);

  assertEquals(body, {
    model: "M2-her",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ],
    stream: true,
    temperature: 0.7,
    top_p: 0.8,
    max_completion_tokens: 2048,
  });
});

Deno.test("minimax provider uses sane defaults and bearer auth", () => {
  const config: ProviderConfig = {
    provider: "minimax",
    apiKey: "test-key",
  };

  const provider = minimaxProvider(config);
  const headers = provider.headers(config);
  const body = provider.body([{ role: "assistant", content: "Hi" }], config);

  assertEquals(provider.endpoint, "https://api.minimax.io/v1/text/chatcompletion_v2");
  assertEquals(headers.Authorization, "Bearer test-key");
  assertEquals(headers["Content-Type"], "application/json");
  assertExists((body as Record<string, unknown>).messages);
  assertEquals((body as Record<string, unknown>).model, "M2-her");
  assertEquals((body as Record<string, unknown>).temperature, 1);
  assertEquals((body as Record<string, unknown>).top_p, 0.95);
});
