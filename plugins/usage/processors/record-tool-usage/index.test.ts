import { assertEquals } from "@std/assert";
import { createToolUsageProcessor } from "./index.ts";

Deno.test("Tool Usage Processor retains its canonical id", () => {
  assertEquals(
    createToolUsageProcessor({}).id,
    "copilotz.usage.record-tool-action",
  );
});
