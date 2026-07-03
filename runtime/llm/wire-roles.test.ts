import { assertEquals } from "@std/assert";

import type {
  ChatMessage,
  ProviderConfig,
  ProviderFactory,
} from "@/runtime/llm/types.ts";
import { formatMessages } from "@/runtime/llm/utils.ts";
import { anthropicProvider } from "@/resources/llm/anthropic/adapter.ts";
import { deepseekProvider } from "@/resources/llm/deepseek/adapter.ts";
import { geminiProvider } from "@/resources/llm/gemini/adapter.ts";
import { groqProvider } from "@/resources/llm/groq/adapter.ts";
import { minimaxProvider } from "@/resources/llm/minimax/adapter.ts";
import { ollamaProvider } from "@/resources/llm/ollama/adapter.ts";
import { openaiProvider } from "@/resources/llm/openai/adapter.ts";

const history: ChatMessage[] = [
  { role: "user", content: "Check the service." },
  {
    role: "assistant",
    content: "",
    toolCalls: [{
      id: "check-1",
      tool: { id: "health_check" },
      args: "{}",
    }],
  },
  {
    role: "tool",
    content: "",
    toolCalls: [{
      id: "check-1",
      tool: { id: "health_check" },
      args: "{}",
      output: { healthy: true },
      status: "completed",
    }],
  },
];

const wireMessages = formatMessages({ messages: history });

Deno.test("formatMessages exposes only provider-safe alternating wire roles", () => {
  assertEquals(
    wireMessages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assertEquals(
    String(wireMessages[1].content).includes("<tool_results>"),
    false,
  );
  assertEquals(
    String(wireMessages[2].content).includes("<tool_results>"),
    true,
  );
});

type ProviderCase = {
  name: string;
  factory: ProviderFactory;
  config: ProviderConfig;
  roles: (body: Record<string, unknown>) => string[];
};

function rolesAt(
  body: Record<string, unknown>,
  key: "contents" | "input" | "messages",
): string[] {
  const messages = body[key];
  if (!Array.isArray(messages)) return [];

  return messages
    .map((message: unknown) =>
      typeof message === "object" && message !== null && "role" in message
        ? message.role
        : undefined
    )
    .filter((role): role is string => typeof role === "string");
}

const providerCases: ProviderCase[] = [
  {
    name: "Anthropic",
    factory: anthropicProvider,
    config: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "test",
    },
    roles: (body) => rolesAt(body, "messages"),
  },
  {
    name: "MiniMax",
    factory: minimaxProvider,
    config: {
      provider: "minimax",
      model: "MiniMax-M3",
      apiKey: "test",
    },
    roles: (body) => rolesAt(body, "messages"),
  },
  {
    name: "Gemini",
    factory: geminiProvider,
    config: {
      provider: "gemini",
      model: "gemini-3.5-flash",
      apiKey: "test",
    },
    roles: (body) => rolesAt(body, "contents"),
  },
  {
    name: "OpenAI Chat Completions",
    factory: openaiProvider,
    config: {
      provider: "openai",
      model: "gpt-4o-mini",
      openaiApi: "chat_completions",
      apiKey: "test",
    },
    roles: (body) => rolesAt(body, "messages"),
  },
  {
    name: "OpenAI Responses",
    factory: openaiProvider,
    config: {
      provider: "openai",
      model: "gpt-5.4",
      openaiApi: "responses",
      apiKey: "test",
    },
    roles: (body) => rolesAt(body, "input"),
  },
  {
    name: "Groq",
    factory: groqProvider,
    config: { provider: "groq", model: "test", apiKey: "test" },
    roles: (body) => rolesAt(body, "messages"),
  },
  {
    name: "DeepSeek",
    factory: deepseekProvider,
    config: { provider: "deepseek", model: "test", apiKey: "test" },
    roles: (body) => rolesAt(body, "messages"),
  },
  {
    name: "Ollama",
    factory: ollamaProvider,
    config: { provider: "ollama", model: "test", apiKey: "http://localhost" },
    roles: (body) => rolesAt(body, "messages"),
  },
];

for (const providerCase of providerCases) {
  Deno.test(`${providerCase.name} receives tool results as external input`, async () => {
    const provider = providerCase.factory(providerCase.config);
    const body = await provider.body(
      wireMessages,
      providerCase.config,
    ) as Record<string, unknown>;
    const expected = providerCase.name === "Gemini"
      ? ["user", "model", "user"]
      : ["user", "assistant", "user"];
    assertEquals(providerCase.roles(body), expected);
  });
}
