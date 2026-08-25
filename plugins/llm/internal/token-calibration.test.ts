/** Tests private LLM calibration policy. @module */
import { assertEquals } from "@std/assert";
import { calculateTokenCalibration } from "./token-calibration.ts";

Deno.test("token calibration uses a bounded rolling median", () => {
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
