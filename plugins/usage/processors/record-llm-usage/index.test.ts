import { assertEquals } from "@std/assert";
import { llmUsageProcessor } from "./index.ts";

Deno.test("LLM Usage Processor retains its canonical id", () => {
  assertEquals(
    llmUsageProcessor.id,
    "copilotz.usage.record-llm-call",
  );
});
