import { assertEquals } from "@std/assert";
import {
  getTokenCalibrationFactor,
  observeTokenCalibration,
  resetTokenCalibration,
  tokenCalibrationKey,
} from "./token-calibration.ts";
import { estimateChatMessages } from "./chat-tokens.ts";
import type { LlmAdapterNativeReasoning } from "./contracts.ts";

Deno.test("native replay hints take precedence, including zero, and remain heuristic", () => {
  for (const reasoningTokens of [0, 7_083]) {
    const native = {
      schema: "copilotz.llm-native-reasoning.v1" as const,
      adapter: "openai",
      api: "openai.responses",
      model: "gpt-test",
      reasoningTokens,
      blocks: [{ type: "reasoning", encrypted_content: "x".repeat(330_000) }],
    };
    const before = structuredClone(native);
    const estimate = estimateChatMessages(
      [{
        role: "assistant",
        content: "answer",
        nativeReasoning: native,
      }],
      { provider: "openai", model: "gpt-test" },
      1,
    );
    assertEquals(estimate.byModality.unknown, reasoningTokens);
    assertEquals(estimate.confidence, "heuristic");
    assertEquals(native, before);
  }
});

Deno.test("historical OpenAI state counts ciphertext without duplicate visible text or metadata", () => {
  const native: LlmAdapterNativeReasoning = {
    schema: "copilotz.llm-native-reasoning.v1" as const,
    adapter: "openai",
    api: "openai.responses",
    model: "gpt-test",
    blocks: [
      { type: "reasoning", encrypted_content: "x".repeat(15_000), id: "id" },
      { type: "message", content: [{ type: "output_text", text: "answer" }] },
    ],
  };
  const estimate = (state: typeof native) =>
    estimateChatMessages(
      [{
        role: "assistant",
        content: "answer",
        nativeReasoning: state,
      }],
      { provider: "openai", model: "gpt-test" },
      1,
    );
  const original = estimate(native);
  const largerIds = structuredClone(native);
  const changed = {
    ...largerIds,
    blocks: largerIds.blocks.map((block, index) =>
      index === 0 ? { ...block, id: "id".repeat(5_000) } : block
    ),
  };
  assertEquals(estimate(changed).estimatedTokens, original.estimatedTokens);
  assertEquals(original.byModality.unknown < 1_100, true);
  assertEquals(original.byModality.unknown > 900, true);
  assertEquals(original.confidence, "heuristic");
});

Deno.test("native usage estimates reuse request calibration and unsupported formats keep their fallback", () => {
  const message = {
    role: "assistant" as const,
    content: "answer",
    nativeReasoning: {
      schema: "copilotz.llm-native-reasoning.v1" as const,
      adapter: "gemini",
      api: "gemini.generateContent",
      model: "gemini-test",
      reasoningTokens: 400,
      blocks: [{ thoughtSignature: "x".repeat(1_000) }],
    },
  };
  const hinted = estimateChatMessages([message], {}, 1.2);
  assertEquals(hinted.byModality.unknown, 400);
  assertEquals(
    hinted.estimatedTokens,
    Math.ceil(hinted.rawEstimatedTokens * 1.2),
  );
  const { reasoningTokens: _hint, ...legacy } = message.nativeReasoning;
  const fallback = estimateChatMessages(
    [{ ...message, nativeReasoning: legacy }],
    {},
    1,
  );
  assertEquals(
    fallback.byModality.unknown,
    Math.ceil(JSON.stringify(legacy.blocks).length / 2),
  );
  assertEquals(fallback.confidence, "heuristic");
});

Deno.test("process-local calibration is isolated by provider, model, and modality", () => {
  resetTokenCalibration();
  const textKey = tokenCalibrationKey("openai", "gpt-test", "protocol+text");
  const imageKey = tokenCalibrationKey(
    "openai",
    "gpt-test",
    "image+protocol",
  );

  observeTokenCalibration(textKey, 100, 120);
  observeTokenCalibration(textKey, 100, 110);

  assertEquals(getTokenCalibrationFactor(textKey), 1.15);
  assertEquals(getTokenCalibrationFactor(imageKey), 1);
  resetTokenCalibration();
});

Deno.test("chat estimates use media metadata and learned calibration", () => {
  resetTokenCalibration();
  const messages = [{
    role: "user" as const,
    content: [{
      type: "input_audio" as const,
      input_audio: { data: "asset://audio", format: "wav" },
      tokenMetadata: { durationSeconds: 10 },
    }],
  }];
  const first = estimateChatMessages(messages, {
    provider: "gemini",
    model: "gemini-test",
  });
  observeTokenCalibration(
    first.calibrationKey,
    first.rawEstimatedTokens,
    first.rawEstimatedTokens * 1.1,
  );
  const calibrated = estimateChatMessages(messages, {
    provider: "gemini",
    model: "gemini-test",
  });

  assertEquals(first.byModality.audio, 320);
  assertEquals(
    calibrated.estimatedTokens,
    Math.ceil(first.rawEstimatedTokens * 1.1),
  );
  resetTokenCalibration();
});

Deno.test("chat estimates conservatively account for opaque native reasoning state", () => {
  const withoutState = estimateChatMessages([{
    role: "assistant" as const,
    content: "answer",
  }], { provider: "openai", model: "gpt-test" });
  const withState = estimateChatMessages([{
    role: "assistant" as const,
    content: "answer",
    nativeReasoning: {
      schema: "copilotz.llm-native-reasoning.v1",
      adapter: "openai",
      api: "openai.responses",
      model: "gpt-test",
      blocks: [{ encrypted: "x".repeat(128) }],
    },
  }], { provider: "openai", model: "gpt-test" });

  assertEquals(withState.modalityMask.includes("unknown"), true);
  assertEquals(
    withState.rawEstimatedTokens > withoutState.rawEstimatedTokens,
    true,
  );
});
