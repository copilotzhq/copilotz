import { assertEquals } from "@std/assert";

import { anthropicProvider } from "./adapter.ts";
import type { ChatMessage, ProviderConfig } from "@/runtime/llm/types.ts";

const messages: ChatMessage[] = [
  { role: "system", content: "Stable system instructions." },
  { role: "user", content: "Hello" },
];

Deno.test("anthropicProvider enables automatic prompt caching by default", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.cache_control, { type: "ephemeral" });
});

Deno.test("anthropicProvider supports 1h prompt cache TTL", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
    promptCache: { ttl: "1h" },
  };
  const body = anthropicProvider(config).body(messages, config);

  assertEquals(body.cache_control, { type: "ephemeral", ttl: "1h" });
});

Deno.test("anthropicProvider can disable prompt cache directives", () => {
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "test",
    promptCache: false,
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
