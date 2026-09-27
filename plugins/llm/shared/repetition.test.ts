import { assertEquals } from "@std/assert";
import { detectDegenerateRepetition } from "./repetition.ts";

Deno.test("detectDegenerateRepetition catches noisy repeated JSON-ish tail", () => {
  const prefix = "The board updates are complete. ";
  const repeated = Array.from(
    { length: 80 },
    (_, index) => index % 5 === 0 ? '"source": "source": "source"' : '"source"',
  ).join(", ");
  const detected = detectDegenerateRepetition(`${prefix}${repeated}`);

  assertEquals(Boolean(detected), true);
  assertEquals(detected?.reason, "low_entropy_periodic_tail");
  assertEquals(detected && detected.startIndex >= prefix.length, true);
});

Deno.test("detectDegenerateRepetition catches repeated phrases", () => {
  const prefix = "I found the blocker. ";
  const phrase = "the task is blocked because ownership cannot be verified ";
  const detected = detectDegenerateRepetition(prefix + phrase.repeat(14));

  assertEquals(Boolean(detected), true);
  assertEquals(detected?.periodTokens.length, 9);
  assertEquals(detected && detected.startIndex >= prefix.length, true);
});

Deno.test("detectDegenerateRepetition ignores normal repeated domain terms", () => {
  const answer =
    "The blocked cards are blocked for different reasons: the Meta app is not ready, the WABA owner is unclear, and the migration path needs confirmation. Move only the blocked work to the blocked column and leave the remaining todo cards unchanged.";

  assertEquals(detectDegenerateRepetition(answer), null);
});
