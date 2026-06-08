import { assertEquals, assertThrows } from "@std/assert";

import { openaiProvider } from "./adapter.ts";
import type { ChatMessage, ProviderConfig } from "@/runtime/llm/types.ts";

const messages: ChatMessage[] = [
  { role: "system", content: "Stable system instructions." },
  { role: "user", content: "Hello" },
];

Deno.test("openaiProvider auto-selects Responses API for current OpenAI model families", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "gpt-5-mini",
    apiKey: "test",
    maxCompletionTokens: 123,
  };
  const provider = openaiProvider(config);
  const body = provider.body(messages, config) as Record<string, any>;

  assertEquals(provider.endpoint, "https://api.openai.com/v1/responses");
  assertEquals(body.model, "gpt-5-mini");
  assertEquals(body.input, messages);
  assertEquals(body.stream, true);
  assertEquals(body.store, false);
  assertEquals(body.max_output_tokens, 123);
  assertEquals(body.reasoning, { summary: "auto" });
});

Deno.test("openaiProvider builds GPT-5 Responses body with Responses field names", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "test",
    openaiApi: "responses",
    maxCompletionTokens: 456,
  };
  const provider = openaiProvider(config);
  const body = provider.body(messages, config) as Record<string, any>;

  assertEquals(provider.endpoint, "https://api.openai.com/v1/responses");
  assertEquals(body.model, "gpt-5.4");
  assertEquals(body.input, messages);
  assertEquals(body.stream, true);
  assertEquals(body.store, false);
  assertEquals(body.max_output_tokens, 456);
  assertEquals(body.text, { format: { type: "text" } });
  assertEquals(body.reasoning, { summary: "auto" });
  assertEquals(body.parallel_tool_calls, false);
  assertEquals("messages" in body, false);
  assertEquals("max_completion_tokens" in body, false);
  assertEquals("response_format" in body, false);
});

Deno.test("openaiProvider sends API key only in Authorization header", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "sk-test",
    openaiApi: "responses",
  };
  const provider = openaiProvider(config);
  const headers = provider.headers(config);
  const body = provider.body(messages, config) as Record<string, any>;

  assertEquals(headers.Authorization, "Bearer sk-test");
  assertEquals("apiKey" in body, false);
  assertEquals("api_key" in body, false);
});

Deno.test("openaiProvider keeps Chat Completions for older models in auto mode", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "gpt-3.5-turbo",
    apiKey: "test",
    maxCompletionTokens: 321,
  };
  const provider = openaiProvider(config);
  const body = provider.body(messages, config) as Record<string, any>;

  assertEquals(provider.endpoint, "https://api.openai.com/v1/chat/completions");
  assertEquals(body.model, "gpt-3.5-turbo");
  assertEquals(body.messages, messages);
  assertEquals(body.stream_options, { include_usage: true });
  assertEquals(body.max_completion_tokens, 321);
});

Deno.test("openaiProvider allows forcing Chat Completions for a Responses-capable model", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "gpt-5-mini",
    apiKey: "test",
    openaiApi: "chat_completions",
  };

  assertEquals(
    openaiProvider(config).endpoint,
    "https://api.openai.com/v1/chat/completions",
  );
});

Deno.test("openaiProvider omits PDF file data URLs from Chat Completions input", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "test",
    openaiApi: "chat_completions",
  };
  const body = openaiProvider(config).body([
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this." },
        {
          type: "file",
          file: { file_data: "data:application/pdf;base64,abc" },
        },
      ],
    },
  ], config) as Record<string, any>;

  assertEquals(body.messages, [{
    role: "user",
    content: [{ type: "text", text: "Describe this." }],
  }]);
});

Deno.test("openaiProvider omits reasoning summary when explicitly disabled", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "o3-mini",
    apiKey: "test",
    openaiReasoningSummary: false,
  };
  const body = openaiProvider(config).body(messages, config) as Record<
    string,
    any
  >;

  assertEquals("reasoning" in body, false);
});

Deno.test("openaiProvider does not send Responses reasoning config to non-reasoning models", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "test",
  };
  const body = openaiProvider(config).body(messages, config) as Record<
    string,
    any
  >;

  assertEquals("reasoning" in body, false);
});

Deno.test("openaiProvider maps multimodal content for Responses input", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "test",
  };
  const body = openaiProvider(config).body([
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this." },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        { type: "input_audio", input_audio: { data: "abc", format: "mp3" } },
        {
          type: "file",
          file: { file_data: "data:application/pdf;base64,abc" },
        },
      ],
    },
  ], config) as Record<string, any>;

  assertEquals(body.input, [{
    role: "user",
    content: [
      { type: "input_text", text: "Describe this." },
      { type: "input_image", image_url: "https://example.com/a.png" },
      { type: "input_file", file_data: "data:audio/mp3;base64,abc" },
      { type: "input_file", file_data: "data:application/pdf;base64,abc" },
    ],
  }]);
});

Deno.test("openaiProvider extracts Responses text, reasoning, finish reason, and usage", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "gpt-5-mini",
    apiKey: "test",
  };
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
  assertEquals(
    provider.isStreamActivity?.({ type: "response.output_item.added" }),
    true,
  );
  assertEquals(
    provider.isStreamActivity?.({ type: "response.failed" }),
    false,
  );
  assertEquals(
    openaiProvider(config).extractContent({
      type: "response.completed",
      response: {
        output: [{
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Summary" }],
        }],
      },
    }),
    [{ text: "Summary", isReasoning: true }],
  );
  assertEquals(
    provider.extractFinishReason?.({
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: {
          reason: "max_output_tokens",
        },
      },
    }),
    "length",
  );
  assertEquals(
    provider.extractUsage?.({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 10,
          output_tokens: 7,
          total_tokens: 17,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    }),
    {
      inputTokens: 10,
      outputTokens: 7,
      reasoningTokens: 4,
      cacheReadInputTokens: 3,
      totalTokens: 17,
      rawUsage: {
        input_tokens: 10,
        output_tokens: 7,
        total_tokens: 17,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 4 },
      },
    },
  );
});

Deno.test("openaiProvider throws on Responses stream error events", () => {
  const config: ProviderConfig = {
    provider: "openai",
    model: "gpt-5-mini",
    apiKey: "test",
  };
  const provider = openaiProvider(config);

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
