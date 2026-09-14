import { assertEquals } from "@std/assert";

import type { ProviderConfig } from "../../internal/types.ts";
import { ollamaProvider } from "./index.ts";

Deno.test("Ollama adapter exposes a provider factory", () => {
  assertEquals(typeof ollamaProvider, "function");
});

Deno.test("Ollama replays terminal message thinking", () => {
  const config: ProviderConfig = {
    provider: "ollama",
    model: "qwen3",
    apiKey: "test",
  };
  const provider = ollamaProvider(config);
  assertEquals(
    provider.extractContent({
      message: { thinking: "private" },
    }),
    [{ text: "private", isReasoning: true }],
  );
  assertEquals(
    provider.extractNativeReasoning?.({
      message: { thinking: "private" },
    }),
    null,
  );
  assertEquals(
    provider.extractNativeReasoning?.({
      message: {},
      done: true,
      done_reason: "stop",
    }),
    [{ thinking: "private" }],
  );

  const body = provider.body([{
    role: "assistant",
    content: "answer",
    nativeReasoning: {
      schema: "copilotz.llm-native-reasoning.v1",
      adapter: "ollama",
      api: "ollama.chat",
      model: "qwen3",
      blocks: [{ thinking: "private" }],
    },
  }], config);
  assertEquals(body.messages, [{
    role: "assistant",
    content: "answer",
    thinking: "private",
  }]);
});
