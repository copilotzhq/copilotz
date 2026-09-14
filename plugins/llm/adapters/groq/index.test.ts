import { assertEquals } from "@std/assert";

import type { ProviderConfig } from "../../internal/types.ts";
import { groqProvider } from "./index.ts";

Deno.test("Groq adapter exposes a provider factory", () => {
  assertEquals(typeof groqProvider, "function");
});

Deno.test("Groq captures parsed reasoning without inventing an input field", () => {
  const config: ProviderConfig = {
    provider: "groq",
    model: "qwen",
    apiKey: "test",
  };
  const provider = groqProvider(config);
  assertEquals(
    provider.extractContent({
      choices: [{ delta: { reasoning: "private" } }],
    }),
    [{ text: "private", isReasoning: true }],
  );
  assertEquals(
    provider.extractNativeReasoning?.({
      choices: [{ delta: { reasoning: "private" } }],
    }),
    null,
  );
  assertEquals(
    provider.extractNativeReasoning?.({
      choices: [{ delta: {}, finish_reason: "stop" }],
    }),
    [{ reasoning: "private" }],
  );

  const body = provider.body([{
    role: "assistant",
    content: "answer",
    nativeReasoning: {
      schema: "copilotz.llm-native-reasoning.v1",
      adapter: "groq",
      api: "groq.chat.completions",
      model: "qwen",
      blocks: [{ reasoning: "private" }],
    },
  }], config);
  assertEquals(body.messages, [{ role: "assistant", content: "answer" }]);
});
