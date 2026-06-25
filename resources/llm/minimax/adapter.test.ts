import { assert, assertEquals } from "@std/assert";

import { minimaxProvider } from "./adapter.ts";
import type { ChatMessage, ProviderConfig } from "@/runtime/llm/types.ts";

const baseConfig: ProviderConfig = {
  provider: "minimax",
  model: "MiniMax-M3",
  apiKey: "test-key",
};

Deno.test("minimaxProvider targets the Anthropic-compatible Messages endpoint", () => {
  const api = minimaxProvider(baseConfig);
  assertEquals(api.endpoint, "https://api.minimax.io/anthropic/v1/messages");
});

Deno.test("minimaxProvider honors a custom baseUrl", () => {
  const api = minimaxProvider({
    ...baseConfig,
    baseUrl: "https://proxy.example.com/",
  });
  assertEquals(
    api.endpoint,
    "https://proxy.example.com/anthropic/v1/messages",
  );
});

Deno.test("minimaxProvider sends bearer auth without anthropic-version", () => {
  const headers = minimaxProvider(baseConfig).headers(baseConfig);
  assertEquals(headers["Authorization"], "Bearer test-key");
  assertEquals("anthropic-version" in headers, false);
  assertEquals("x-api-key" in headers, false);
});

Deno.test("minimaxProvider builds an Anthropic-shaped body with system string", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" },
  ];
  const body = minimaxProvider(baseConfig).body(messages, baseConfig);

  assertEquals(body.model, "MiniMax-M3");
  assertEquals(body.stream, true);
  assertEquals(body.system, "You are helpful.");
  assertEquals(body.messages, [
    { role: "user", content: [{ type: "text", text: "Hello" }] },
  ]);
});

Deno.test("minimaxProvider omits ignored Anthropic-only params", () => {
  const config: ProviderConfig = {
    ...baseConfig,
    topK: 40,
    promptCache: { ttl: "1h" },
  };
  const body = minimaxProvider(config).body(
    [{ role: "user", content: "Hi" }],
    config,
  );

  assertEquals("top_k" in body, false);
  assertEquals("cache_control" in body, false);
});

Deno.test("minimaxProvider forwards resolved native stop sequences", () => {
  const config: ProviderConfig = {
    ...baseConfig,
    nativeStopSequences: ["STOP", "<tool_results>", "</tool_results>"],
  };
  const body = minimaxProvider(config).body(
    [{ role: "user", content: "Hi" }],
    config,
  );

  assertEquals(body.stop_sequences, [
    "STOP",
    "<tool_results>",
    "</tool_results>",
  ]);
});

Deno.test("minimaxProvider falls back to stop/stopSequences for direct callers", () => {
  const config: ProviderConfig = {
    ...baseConfig,
    stopSequences: ["STOP"],
    stop: "HALT",
  };
  const body = minimaxProvider(config).body(
    [{ role: "user", content: "Hi" }],
    config,
  );

  assertEquals(body.stop_sequences, ["STOP", "HALT"]);
});

Deno.test("minimaxProvider omits stop_sequences when none are configured", () => {
  const body = minimaxProvider(baseConfig).body(
    [{ role: "user", content: "Hi" }],
    baseConfig,
  );

  assertEquals("stop_sequences" in body, false);
});

Deno.test("minimaxProvider enables adaptive thinking when reasoning effort is set", () => {
  const config: ProviderConfig = { ...baseConfig, reasoningEffort: "high" };
  const body = minimaxProvider(config).body(
    [{ role: "user", content: "Hi" }],
    config,
  );

  assertEquals(body.thinking, { type: "adaptive" });
});

Deno.test("minimaxProvider omits thinking when no reasoning effort is set", () => {
  const body = minimaxProvider(baseConfig).body(
    [{ role: "user", content: "Hi" }],
    baseConfig,
  );

  assertEquals("thinking" in body, false);
});

Deno.test("minimaxProvider clamps temperature to MiniMax range [0, 2]", () => {
  const config: ProviderConfig = { ...baseConfig, temperature: 5 };
  const body = minimaxProvider(config).body(
    [{ role: "user", content: "Hi" }],
    config,
  );

  assertEquals(body.temperature, 2);
});

Deno.test("minimaxProvider honors configured max tokens without a hard cap", () => {
  const config: ProviderConfig = { ...baseConfig, maxTokens: 30_000 };
  const body = minimaxProvider(config).body(
    [{ role: "user", content: "Hi" }],
    config,
  );

  assertEquals(body.max_tokens, 30_000);
});

Deno.test("minimaxProvider maps image and video parts to content blocks", () => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Describe these." },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" },
        },
        {
          type: "video",
          video: {
            url: "https://cdn.example.com/clip.mp4",
            mime_type: "video/mp4",
          },
        },
      ],
    },
  ];
  const body = minimaxProvider(baseConfig).body(messages, baseConfig);

  assertEquals(body.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "Describe these." },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAAA" },
        },
        {
          type: "video",
          source: { type: "url", url: "https://cdn.example.com/clip.mp4" },
        },
      ],
    },
  ]);
});

Deno.test("minimaxProvider maps base64 video data URLs to base64 sources", () => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "video",
          video: { url: "data:video/mp4;base64,BBBB" },
        },
      ],
    },
  ];
  const body = minimaxProvider(baseConfig).body(messages, baseConfig);

  assertEquals(body.messages, [
    {
      role: "user",
      content: [
        {
          type: "video",
          source: { type: "base64", media_type: "video/mp4", data: "BBBB" },
        },
      ],
    },
  ]);
});

Deno.test("minimaxProvider extracts streamed text and thinking deltas", () => {
  const api = minimaxProvider(baseConfig);

  assertEquals(
    api.extractContent({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hello" },
    }),
    [{ text: "hello" }],
  );

  assertEquals(
    api.extractContent({
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "pondering" },
    }),
    [{ text: "pondering", isReasoning: true }],
  );

  assertEquals(api.extractContent({ type: "message_start" }), null);
});

Deno.test("minimaxProvider maps Anthropic-style finish reasons", () => {
  const api = minimaxProvider(baseConfig);
  assertEquals(
    api.extractFinishReason?.({ delta: { stop_reason: "end_turn" } }),
    "stop",
  );
  assertEquals(
    api.extractFinishReason?.({ delta: { stop_reason: "max_tokens" } }),
    "length",
  );
  assertEquals(
    api.extractFinishReason?.({ delta: { stop_reason: "tool_use" } }),
    "tool_calls",
  );
});

Deno.test("minimaxProvider extracts Anthropic-style usage fields", () => {
  const api = minimaxProvider(baseConfig);
  const usage = api.extractUsage?.({
    type: "message_start",
    message: {
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5,
      },
    },
  });

  assert(usage);
  assertEquals(usage.inputTokens, 105);
  assertEquals(usage.outputTokens, 20);
  assertEquals(usage.cacheReadInputTokens, 5);
  assertEquals(usage.totalTokens, 125);
});

Deno.test("minimaxProvider reads final output tokens from message_delta usage", () => {
  const api = minimaxProvider(baseConfig);

  // message_start carries the cached/input priming with zeroed output...
  const start = api.extractUsage?.({
    type: "message_start",
    message: {
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1366,
      },
    },
  });
  assert(start);
  assertEquals(start.outputTokens, 0);
  assertEquals(start.inputTokens, 1366);

  // ...and message_delta carries the final consumption at the top level.
  const final = api.extractUsage?.({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: {
      input_tokens: 1252,
      output_tokens: 213,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 114,
    },
  });
  assert(final);
  assertEquals(final.inputTokens, 1366);
  assertEquals(final.outputTokens, 213);
  assertEquals(final.cacheReadInputTokens, 114);
  assertEquals(final.totalTokens, 1579);

  // Non-usage stream events must not emit usage updates.
  assertEquals(api.extractUsage?.({ type: "ping" }), null);
  assertEquals(
    api.extractUsage?.({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hi" },
    }),
    null,
  );
});
