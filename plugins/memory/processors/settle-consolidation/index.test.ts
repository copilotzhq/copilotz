import { assertEquals } from "@std/assert";
import { createSettleMemoryConsolidationProcessor } from "./index.ts";

Deno.test("consolidation settlement is detached and Memory-owned", () => {
  const processor = createSettleMemoryConsolidationProcessor();
  assertEquals(processor.id, "copilotz.memory.settle-consolidation");
  assertEquals(processor.settlement, "detached");
});
