import { assertEquals, assertRejects } from "@std/assert";
import { prepareAttemptTranscript } from "../adapters/bridge/transcript.ts";
import { ContextInputLimitError } from "./errors.ts";

Deno.test("attempt preparation rejects oversized history without dropping it", async () => {
  const error = await assertRejects(() =>
    prepareAttemptTranscript({
      request: {
        messages: [
          {
            role: "user",
            content: "a".repeat(80),
            metadata: { sourceMessageId: "m1" },
          },
          {
            role: "assistant",
            content: "b".repeat(80),
            metadata: { sourceMessageId: "m2" },
          },
        ],
      },
      config: { limitEstimatedInputTokens: 30 },
    }), ContextInputLimitError);
  if (!(error instanceof ContextInputLimitError)) throw error;
  if (error.estimatedInputTokens <= error.limitEstimatedInputTokens) {
    throw new Error("Expected the estimate to exceed the configured limit.");
  }
});

Deno.test("attempt fingerprints include native reasoning state", async () => {
  const base = {
    request: {
      messages: [{ role: "assistant" as const, content: "answer" }],
    },
    config: { provider: "openai" as const, model: "gpt-test" },
  };
  const withoutState = await prepareAttemptTranscript(base);
  const withState = await prepareAttemptTranscript({
    ...base,
    request: {
      messages: [{
        role: "assistant" as const,
        content: "answer",
        nativeReasoning: {
          schema: "copilotz.llm-native-reasoning.v1" as const,
          adapter: "openai",
          api: "openai.responses",
          model: "gpt-test",
          blocks: [{ opaque: "state" }],
        },
      }],
    },
  });
  assertEquals(
    withoutState.promptFingerprint === withState.promptFingerprint,
    false,
  );
  assertEquals(
    withoutState.inputTokenEstimate.estimatedTokens <
      withState.inputTokenEstimate.estimatedTokens,
    true,
  );
});
