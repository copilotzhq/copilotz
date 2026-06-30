import { assertEquals } from "@std/assert";
import {
  getTokenCalibrationFactor,
  observeTokenCalibration,
  resetTokenCalibration,
  tokenCalibrationKey,
} from "./calibration.ts";
import { estimateChatMessages } from "./chat.ts";

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
