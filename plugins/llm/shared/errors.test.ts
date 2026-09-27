import { assertEquals } from "@std/assert";
import { classifyLLMError, LLMTranscriptError } from "./errors.ts";

Deno.test("classifyLLMError keeps transcript failures local", () => {
  assertEquals(
    classifyLLMError(new LLMTranscriptError("invalid history")),
    "invalid_transcript",
  );
});
