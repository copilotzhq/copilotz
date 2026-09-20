import { assertEquals } from "@std/assert";

import type { ChatMessage, ProviderConfig } from "../../shared/types.ts";
import { anthropicProvider } from "./index.ts";

const messages: ChatMessage[] = [
  { role: "system", content: "Stable system instructions." },
  { role: "user", content: "Hello" },
];

Deno.test("anthropicProvider leaves prompt caching to provider defaults", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals("cache_control" in body, false);
});

Deno.test("anthropicProvider forwards resolved native stop sequences", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
    nativeStopSequences: ["STOP", "<tool_results>", "</tool_results>"],
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.stop_sequences, [
    "STOP",
    "<tool_results>",
    "</tool_results>",
  ]);
});

Deno.test("anthropicProvider omits stop_sequences when none are configured", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.stop_sequences, undefined);
});

Deno.test("anthropicProvider maps adaptive effort for Claude Fable 5", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-fable-5",
    apiKey: "test",
    reasoningEffort: "high",
    temperature: 0,
    topP: 0.5,
    topK: 10,
    maxTokens: 30_000,
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.thinking, { type: "adaptive" });
  assertEquals(body.output_config, { effort: "high" });
  assertEquals(body.max_tokens, 30_000);
  assertEquals("temperature" in body, false);
  assertEquals("top_p" in body, false);
  assertEquals("top_k" in body, false);
  assertEquals(
    "budget_tokens" in (body.thinking as Record<string, unknown>),
    false,
  );
});

Deno.test("anthropicProvider enables always-on adaptive thinking for Fable without effort", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-fable-5",
    apiKey: "test",
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.thinking, { type: "adaptive" });
  assertEquals("output_config" in body, false);
});

Deno.test("anthropicProvider maps adaptive effort for Claude Opus 4.8", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-opus-4-8",
    apiKey: "test",
    reasoningEffort: "medium",
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.thinking, { type: "adaptive" });
  assertEquals(body.output_config, { effort: "medium" });
  assertEquals("temperature" in body, false);
  assertEquals(
    "budget_tokens" in (body.thinking as Record<string, unknown>),
    false,
  );
});

Deno.test("anthropicProvider keeps Opus 4.8 fallback requests valid without effort", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-opus-4-8",
    apiKey: "test",
    temperature: 1,
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals("thinking" in body, false);
  assertEquals("temperature" in body, false);
  assertEquals("top_p" in body, false);
  assertEquals("top_k" in body, false);
});

Deno.test("anthropicProvider makes Sonnet 5 adaptive thinking explicit by default", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    apiKey: "test",
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.thinking, { type: "adaptive" });
  assertEquals("output_config" in body, false);
});

Deno.test("anthropicProvider retains manual budgets for legacy Claude models", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
    reasoningEffort: "high",
    maxTokens: 30_000,
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.thinking, { type: "enabled", budget_tokens: 65536 });
  assertEquals(body.max_tokens, 65537);
  assertEquals("output_config" in body, false);
  assertEquals("temperature" in body, false);
});

Deno.test("anthropicProvider maps PDF file data URLs to document blocks", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
  };
  const body = anthropicProvider(config).body([
    {
      role: "user",
      content: [
        {
          type: "file",
          file: {
            file_data: "data:application/pdf;base64,JVBERi0xLjQK",
            mime_type: "application/pdf",
          },
        },
        { type: "text", text: "Summarize this PDF." },
      ],
    },
  ], config);

  assertEquals(body.messages, [{
    role: "user",
    content: [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "JVBERi0xLjQK",
        },
      },
      { type: "text", text: "Summarize this PDF." },
    ],
  }]);
});

Deno.test("anthropicProvider replays only matching finalized thinking blocks", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
  };
  const body = anthropicProvider(config).body([{
    role: "assistant",
    content: "Answer",
    nativeReasoning: {
      schema: "copilotz.llm-native-reasoning.v1",
      adapter: "anthropic",
      api: "anthropic.messages",
      model: "claude-sonnet-4-5",
      blocks: [
        { type: "thinking", thinking: "private", signature: "sig" },
        { type: "redacted_thinking", data: "cipher" },
      ],
    },
  }], config);

  assertEquals(body.messages, [{
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private", signature: "sig" },
      { type: "redacted_thinking", data: "cipher" },
      { type: "text", text: "Answer" },
    ],
  }]);
  assertEquals(
    anthropicProvider(config).nativeReasoningApi,
    "anthropic.messages",
  );
});

Deno.test("anthropicProvider uses Opus 5 adaptive requests at every supported effort", () => {
  for (
    const effort of [undefined, "minimal", "low", "medium", "high"] as const
  ) {
    const config: ProviderConfig = {
      provider: "anthropic",
      model: "claude-opus-5",
      reasoningEffort: effort,
      temperature: 0.5,
      topP: 0.7,
      topK: 10,
      maxTokens: 2000,
    };
    const body = anthropicProvider(config).body(messages, config);
    assertEquals(body.thinking, { type: "adaptive" });
    assertEquals(
      body.output_config,
      effort ? { effort: effort === "minimal" ? "low" : effort } : undefined,
    );
    assertEquals(body.max_tokens, 2000);
    for (const field of ["temperature", "top_p", "top_k"]) {
      assertEquals(
        field in body,
        false,
      );
    }
  }
});

Deno.test("anthropicProvider does not guess unsupported Opus 5 aliases", () => {
  // Opus 5 is a fixed ID without dated variants. Preserve unknown-model behavior.
  for (
    const model of [
      "claude-opus-50",
      "claude-opus-5-20260724",
      "claude-opus-5-preview",
      "claude-opus-4-5",
    ]
  ) {
    const config: ProviderConfig = {
      provider: "anthropic",
      model,
      reasoningEffort: "low",
    };
    const body = anthropicProvider(config).body(messages, config);
    assertEquals(body.thinking, { type: "enabled", budget_tokens: 4096 });
  }
});

Deno.test("Opus 5 omitted thinking survives streaming and tool-result continuation", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-opus-5",
  };
  const adapter = anthropicProvider(config);
  const extract = adapter.extractNativeReasoning!;
  extract({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  });
  extract({
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "opaque-signature" },
  });
  extract({ type: "content_block_stop", index: 0 });
  extract({ type: "message_delta", delta: { stop_reason: "stop_sequence" } });
  const blocks = extract({ type: "message_stop" })!;
  assertEquals(blocks, [{
    type: "thinking",
    thinking: "",
    signature: "opaque-signature",
  }]);
  assertEquals(
    adapter.extractContent({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "answer" },
    }),
    [{ text: "answer" }],
  );
  const body = adapter.body([
    ...messages,
    {
      role: "assistant",
      content: "<tool_calls>read_file</tool_calls>",
      nativeReasoning: {
        schema: "copilotz.llm-native-reasoning.v1",
        adapter: "anthropic",
        api: "anthropic.messages",
        model: config.model!,
        blocks: blocks as NonNullable<ChatMessage["nativeReasoning"]>["blocks"],
      },
    },
    { role: "user", content: "<tool_results>file contents</tool_results>" },
  ], config);
  const replay = body.messages as { content: unknown[] }[];
  assertEquals(replay[1].content[0], blocks[0]);
});
