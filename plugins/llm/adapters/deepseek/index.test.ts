import { assertEquals } from "@std/assert";

import type { ProviderConfig } from "../../shared/types.ts";
import { deepseekProvider } from "./index.ts";

Deno.test("DeepSeek adapter exposes a provider factory", () => {
  assertEquals(typeof deepseekProvider, "function");
});

Deno.test("DeepSeek preserves readable and native reasoning only after stop", () => {
  const config: ProviderConfig = {
    provider: "deepseek",
    model: "deepseek-chat",
    apiKey: "test",
  };
  const provider = deepseekProvider(config);
  assertEquals(
    provider.extractContent({
      choices: [{ delta: { reasoning_content: "private" } }],
    }),
    [{ text: "private", isReasoning: true }],
  );
  assertEquals(
    provider.extractNativeReasoning?.({
      choices: [{ delta: { reasoning_content: "private" } }],
    }),
    null,
  );
  assertEquals(
    provider.extractNativeReasoning?.({
      choices: [{ delta: {}, finish_reason: "stop" }],
    }),
    [{ reasoning_content: "private" }],
  );

  const body = provider.body([{
    role: "assistant",
    content: "answer",
    nativeReasoning: {
      schema: "copilotz.llm-native-reasoning.v1",
      adapter: "deepseek",
      api: "deepseek.chat.completions",
      model: "deepseek-chat",
      blocks: [{ reasoning_content: "private" }],
    },
  }], config);
  assertEquals(body.messages, [{
    role: "assistant",
    content: "answer",
    reasoning_content: "private",
  }]);
});
