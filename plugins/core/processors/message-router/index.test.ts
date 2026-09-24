import { assert, assertEquals } from "@std/assert";
import { preflightLlmRequest, prepareLlmCall } from "@copilotz/copilotz/llm";
import type { LlmCallInput } from "@copilotz/copilotz/llm";
import { messageRouterProcessor } from "./index.ts";
Deno.test("Message Router owns its identity", () =>
  assertEquals(messageRouterProcessor.id, "copilotz.core.message-to-llm-call"));

Deno.test("LLM preparation counts provider-native state and preserves fitting fallback", async () => {
  const request = {
    messages: [{
      role: "assistant" as const,
      content: [{
        assetId: "answer",
        kind: "text" as const,
        role: "body",
        mediaType: "text/plain",
        value: "short answer",
      }],
      nativeReasoning: {
        schema: "copilotz.llm-native-reasoning.v1" as const,
        adapter: "openai",
        api: "openai.responses",
        model: "gpt-4o-mini",
        blocks: [{
          assetId: "reasoning",
          kind: "json" as const,
          role: "reasoning",
          mediaType: "application/json",
          value: { summary: "r".repeat(4_000) },
        }],
      },
    }],
  } as unknown as LlmCallInput["request"];
  const limitEstimatedInputTokens = 1_000;
  const generic = preflightLlmRequest(request, {
    provider: "openai",
    model: "gpt-4o-mini",
    limitEstimatedInputTokens,
  }, "tenant-a");
  assert(generic.estimatedInputTokens < limitEstimatedInputTokens);

  const preparation = await prepareLlmCall({
    mode: "generate",
    models: [{
      connection: "responses",
      model: "gpt-4o-mini",
      options: {
        limitEstimatedInputTokens,
      },
    }, {
      connection: "chat",
      model: "gpt-4o-mini",
      options: { limitEstimatedInputTokens, openaiApi: "chat_completions" },
    }],
    request,
  }, {
    responses: { provider: "openai", auth: { apiKey: "test-key" } },
    chat: { provider: "openai", auth: { apiKey: "test-key" } },
  }, "tenant-a");
  assertEquals(preparation.candidates.map((item) => item.status), [
    "too_large",
    "fit",
  ]);
  assert(
    preparation.candidates[0]!.estimatedInputTokens > limitEstimatedInputTokens,
  );
});
