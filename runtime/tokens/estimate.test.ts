import { assert, assertEquals } from "@std/assert";
import {
  calculateTokenCalibration,
  estimateTextTokens,
  estimateTokens,
} from "./estimate.ts";

Deno.test("estimateTextTokens handles common text without external tokenizers", () => {
  const english = estimateTextTokens(
    "The quick brown fox jumps over the lazy dog.",
  );
  const cjk = estimateTextTokens("你好世界，这是一个测试。");
  const emoji = estimateTextTokens("🧭🚀✨");

  assert(english >= 9 && english <= 14);
  assert(cjk >= 10);
  assert(emoji >= 6);
});

Deno.test("estimateTokens returns mixed-modality breakdown and safety margin", () => {
  const result = estimateTokens([
    { type: "text", text: "Summarize the attached material." },
    { type: "image", width: 1920, height: 1080, detail: "high" },
    { type: "audio", durationSeconds: 45 },
    {
      type: "document",
      text: "A short extracted document.",
      pages: 12,
    },
    { type: "protocol", tokens: 12 },
  ], {
    provider: "gemini",
    model: "gemini-3.5-flash",
  });

  assert(result.byModality.text > 0);
  assertEquals(result.byModality.image, 1548);
  assertEquals(result.byModality.audio, 1440);
  assert(result.byModality.document > 12 * 258);
  assertEquals(result.byModality.protocol, 12);
  assertEquals(
    result.rawEstimatedTokens,
    Object.values(result.byModality).reduce((sum, value) => sum + value, 0),
  );
  assertEquals(result.safeTokens, Math.ceil(result.estimatedTokens * 1.15));
});

Deno.test("estimateTokens applies provider-specific image profiles", () => {
  const image = {
    type: "image" as const,
    width: 1024,
    height: 1024,
    detail: "high" as const,
  };
  const openai = estimateTokens(image, {
    provider: "openai",
    model: "gpt-4o",
  });
  const anthropic = estimateTokens(image, {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  });
  const gemini = estimateTokens(image, {
    provider: "gemini",
    model: "gemini-3.5-flash",
  });

  assertEquals(openai.estimatedTokens, 765);
  assertEquals(anthropic.estimatedTokens, 1399);
  assertEquals(gemini.estimatedTokens, 1032);
});

Deno.test("estimateTokens uses conservative defaults when media metadata is missing", () => {
  const result = estimateTokens([
    { type: "image" },
    { type: "audio" },
    { type: "video" },
    { type: "document" },
  ]);

  assert(result.estimatedTokens > 0);
  assertEquals(result.confidence, "heuristic");
  assert(result.parts.every((part) => part.confidence === "heuristic"));
});

Deno.test("estimateTokens does not inspect raw unknown payload contents", () => {
  const result = estimateTokens({
    type: "unknown",
    byteLength: 4_000_000,
  });

  assertEquals(result.rawEstimatedTokens, 1_000_000);
  assertEquals(result.confidence, "heuristic");
});

Deno.test("calculateTokenCalibration uses a bounded rolling median", () => {
  const factor = calculateTokenCalibration([
    { estimatedTokens: 100, actualInputTokens: 120 },
    { estimatedTokens: 100, actualInputTokens: 110 },
    { estimatedTokens: 100, actualInputTokens: 500 },
  ]);

  assertEquals(factor, 1.2);
  assertEquals(
    calculateTokenCalibration([
      { estimatedTokens: 100, actualInputTokens: 1000 },
    ]),
    2,
  );
  assertEquals(calculateTokenCalibration([]), 1);
});

Deno.test("estimateTokens applies calibration after computing the raw estimate", () => {
  const result = estimateTokens(
    { type: "text", text: "x".repeat(400) },
    { calibrationFactor: 1.2, safetyMargin: 0.1 },
  );

  assertEquals(result.rawEstimatedTokens, 100);
  assertEquals(result.estimatedTokens, 120);
  assertEquals(result.safeTokens, 132);
});
