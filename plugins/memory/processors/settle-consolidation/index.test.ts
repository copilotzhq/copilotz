import { assertEquals } from "@std/assert";
import { settleMemoryConsolidationProcessor } from "./index.ts";

Deno.test("consolidation settlement is detached and Memory-owned", () => {
  const processor = settleMemoryConsolidationProcessor;
  assertEquals(processor.id, "copilotz.memory.settle-consolidation");
  assertEquals(processor.settlement, "detached");
});
