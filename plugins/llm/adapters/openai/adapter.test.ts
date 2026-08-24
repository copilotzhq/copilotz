import { assertEquals, assertThrows } from "@std/assert";

import { withInternalPromptCacheKey } from "../../internal/internal-cache-key.ts";
import type { ChatMessage, ProviderConfig } from "../../internal/types.ts";
import { openaiProvider } from "./protocol.ts";

const messages: ChatMessage[] = [
  { role: "system", content: "Stable system instructions." },
  { role: "user", content: "Hello" },
];

function keyedConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return withInternalPromptCacheKey({
    provider: "openai",
    model: "gpt-5.6",
    apiKey: "test",
    ...overrides,
  }, "stable-internal-key");
}

Deno.test("OpenAI auto-selects Responses for current model families", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "gpt-5-mini",
    apiKey: "test",
    maxCompletionTokens: 123,
  };
  const provider = openaiProvider(config);
  const body = provider.body(messages, config) as Record<string, unknown>;

  assertEquals(provider.endpoint, "https://api.openai.com/v1/responses");
  assertEquals(body.model, "gpt-5-mini");
  assertEquals(body.input, messages);
  assertEquals(body.stream, true);
  assertEquals(body.store, false);
  assertEquals(body.temperature, 1);
  assertEquals(body.truncation, "disabled");
  assertEquals(body.max_output_tokens, 123);
  assertEquals(body.reasoning, { summary: "auto" });
  assertEquals("prompt_cache_key" in body, false);
});

Deno.test("OpenAI builds Responses bodies with Responses field names", () => {
  const config = keyedConfig({
    model: "gpt-5.4",
    openaiApi: "responses",
    maxCompletionTokens: 456,
  });
  const body = openaiProvider(config).body(messages, config) as Record<
    string,
    unknown
  >;

  assertEquals(body.input, messages);
  assertEquals(body.max_output_tokens, 456);
  assertEquals(body.prompt_cache_key, "stable-internal-key");
  assertEquals(body.text, { format: { type: "text" } });
  assertEquals(body.reasoning, { summary: "auto" });
  assertEquals(body.parallel_tool_calls, false);
  assertEquals("messages" in body, false);
  assertEquals("max_completion_tokens" in body, false);
  assertEquals("response_format" in body, false);
});

Deno.test("OpenAI Responses sends only the internal prompt cache key", () => {
  const config = keyedConfig({ openaiApi: "responses" });
  const body = openaiProvider(config).body(messages, config) as Record<
    string,
    unknown
  >;

  assertEquals(body.prompt_cache_key, "stable-internal-key");
  assertEquals("prompt_cache_options" in body, false);
  assertEquals("prompt_cache_retention" in body, false);
  assertEquals(JSON.stringify(body).includes("prompt_cache_breakpoint"), false);
});

Deno.test("ChatGPT transport receives the same internal key without public controls", () => {
  const config = keyedConfig({
    openaiApi: "responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    extraHeaders: { "ChatGPT-Account-ID": "account-1" },
  });
  const provider = openaiProvider(config);
  const body = provider.body(messages, config) as Record<string, unknown>;

  assertEquals(
    provider.endpoint,
    "https://chatgpt.com/backend-api/codex/responses",
  );
  assertEquals(body.prompt_cache_key, "stable-internal-key");
  assertEquals("prompt_cache_options" in body, false);
  assertEquals("prompt_cache_retention" in body, false);
});

Deno.test("Chat Completions receives the same internal key", () => {
  const config = keyedConfig({ openaiApi: "chat_completions" });
  const body = openaiProvider(config).body(messages, config) as Record<
    string,
    unknown
  >;
  assertEquals(body.prompt_cache_key, "stable-internal-key");
  assertEquals("prompt_cache_options" in body, false);
});

Deno.test("OpenAI sends API keys only in the Authorization header", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "sk-test",
    openaiApi: "responses",
  };
  const provider = openaiProvider(config);
  const body = provider.body(messages, config) as Record<string, unknown>;

  assertEquals(provider.headers(config).Authorization, "Bearer sk-test");
  assertEquals("apiKey" in body, false);
  assertEquals("api_key" in body, false);
});

Deno.test("OpenAI keeps Chat Completions for older models in auto mode", () => {
  const config = keyedConfig({
    model: "gpt-3.5-turbo",
    maxCompletionTokens: 321,
  });
  const provider = openaiProvider(config);
  const body = provider.body(messages, config) as Record<string, unknown>;

  assertEquals(provider.endpoint, "https://api.openai.com/v1/chat/completions");
  assertEquals(body.messages, messages);
  assertEquals(body.stream_options, { include_usage: true });
  assertEquals(body.max_completion_tokens, 321);
  assertEquals(body.prompt_cache_key, "stable-internal-key");
});

Deno.test("OpenAI allows forcing Chat Completions", () => {
  const config = keyedConfig({
    model: "gpt-5-mini",
    openaiApi: "chat_completions",
  });
  assertEquals(
    openaiProvider(config).endpoint,
    "https://api.openai.com/v1/chat/completions",
  );
});

Deno.test("OpenAI omits PDF file data URLs from Chat Completions", () => {
  const config = keyedConfig({
    model: "gpt-4o-mini",
    openaiApi: "chat_completions",
  });
  const body = openaiProvider(config).body([{
    role: "user",
    content: [
      { type: "text", text: "Describe this." },
      {
        type: "file",
        file: { file_data: "data:application/pdf;base64,abc" },
      },
    ],
  }], config) as Record<string, unknown>;

  assertEquals(body.messages, [{
    role: "user",
    content: [{ type: "text", text: "Describe this." }],
  }]);
});

Deno.test("OpenAI omits explicitly disabled reasoning summaries", () => {
  const config = keyedConfig({
    model: "o3-mini",
    openaiReasoningSummary: false,
  });
  const body = openaiProvider(config).body(messages, config) as Record<
    string,
    unknown
  >;
  assertEquals("reasoning" in body, false);
});

Deno.test("OpenAI omits Responses reasoning for non-reasoning models", () => {
  const config = keyedConfig({ model: "gpt-4o-mini" });
  const body = openaiProvider(config).body(messages, config) as Record<
    string,
    unknown
  >;
  assertEquals("reasoning" in body, false);
});

Deno.test("OpenAI maps multimodal content for Responses", () => {
  const config = keyedConfig({ model: "gpt-4o-mini" });
  const body = openaiProvider(config).body([{
    role: "user",
    content: [
      { type: "text", text: "Describe this." },
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      {
        type: "input_audio",
        input_audio: {
          data: "abc",
          format: "mp3",
          filename: "voice-note.mp3",
        },
      },
      {
        type: "file",
        file: {
          file_data: "data:application/pdf;base64,abc",
          filename: "exported-report.pdf",
        },
      },
    ],
  }], config) as Record<string, unknown>;

  assertEquals(body.input, [{
    role: "user",
    content: [
      { type: "input_text", text: "Describe this." },
      { type: "input_image", image_url: "https://example.com/a.png" },
      {
        type: "input_file",
        file_data: "data:audio/mp3;base64,abc",
        filename: "voice-note.mp3",
      },
      {
        type: "input_file",
        file_data: "data:application/pdf;base64,abc",
        filename: "exported-report.pdf",
      },
    ],
  }]);
});

Deno.test("OpenAI Responses replays assistant history as output text", () => {
  const config = keyedConfig({ model: "gpt-5-mini" });
  const body = openaiProvider(config).body([{
    role: "system",
    content: [{ type: "text", text: "Be concise." }],
  }, {
    role: "user",
    content: [{ type: "text", text: "First question" }],
  }, {
    role: "assistant",
    content: [{ type: "text", text: "First answer" }],
  }, {
    role: "user",
    content: [{ type: "text", text: "Follow-up question" }],
  }], config) as Record<string, unknown>;

  assertEquals(body.input, [{
    role: "system",
    content: [{ type: "input_text", text: "Be concise." }],
  }, {
    role: "user",
    content: [{ type: "input_text", text: "First question" }],
  }, {
    role: "assistant",
    content: [{
      type: "output_text",
      text: "First answer",
      annotations: [],
    }],
  }, {
    role: "user",
    content: [{ type: "input_text", text: "Follow-up question" }],
  }]);
});

Deno.test("OpenAI usage normalizes cache reads and writes", () => {
  const config = keyedConfig({ openaiApi: "chat_completions" });
  const usage = openaiProvider(config).extractUsage?.({
    usage: {
      prompt_tokens: 20,
      completion_tokens: 4,
      total_tokens: 24,
      prompt_tokens_details: { cached_tokens: 12, cache_write_tokens: 6 },
    },
  });
  assertEquals(usage?.inputTokens, 20);
  assertEquals(usage?.cacheReadInputTokens, 12);
  assertEquals(usage?.cacheCreationInputTokens, 6);
  assertEquals(usage?.outputTokens, 4);
});

Deno.test("OpenAI extracts Responses content, reasoning, finish reason, and usage", () => {
  const config = keyedConfig({ model: "gpt-5-mini" });
  const provider = openaiProvider(config);

  assertEquals(
    provider.extractContent({
      type: "response.output_text.delta",
      delta: "Hello",
    }),
    [{ text: "Hello" }],
  );
  assertEquals(
    provider.extractContent({
      type: "response.reasoning_summary_text.delta",
      delta: "Thinking",
    }),
    [{ text: "Thinking", isReasoning: true }],
  );
  assertEquals(
    provider.isStreamActivity?.({ type: "response.in_progress" }),
    true,
  );
  assertEquals(provider.isStreamActivity?.({ type: "response.failed" }), false);
  assertEquals(
    provider.extractFinishReason?.({
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    }),
    "length",
  );

  const usage = provider.extractUsage?.({
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 10,
        output_tokens: 7,
        total_tokens: 17,
        input_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 },
        output_tokens_details: { reasoning_tokens: 4 },
      },
    },
  });
  assertEquals(usage?.inputTokens, 10);
  assertEquals(usage?.outputTokens, 7);
  assertEquals(usage?.reasoningTokens, 4);
  assertEquals(usage?.cacheReadInputTokens, 3);
  assertEquals(usage?.cacheCreationInputTokens, 5);
});

Deno.test("OpenAI throws on Responses stream error events", () => {
  const provider = openaiProvider(keyedConfig({ model: "gpt-5-mini" }));
  const error = assertThrows(
    () =>
      provider.extractContent({
        type: "error",
        error: {
          code: "insufficient_quota",
          message: "quota exceeded",
        },
      }),
    Error,
    "quota exceeded",
  );
  assertEquals((error as { status?: number }).status, 429);
});
