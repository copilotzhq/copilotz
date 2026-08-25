import { assertEquals } from "@std/assert";
import { createLlmUsageProcessor } from "./index.ts";

Deno.test("LLM Usage Processor retains its canonical id", () => {
  assertEquals(
    createLlmUsageProcessor({}).id,
    "copilotz.usage.record-llm-call",
  );
});
