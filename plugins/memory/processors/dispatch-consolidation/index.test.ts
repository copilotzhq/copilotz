import { assertEquals } from "@std/assert";
import { dispatchMemoryConsolidationProcessor } from "./index.ts";

Deno.test("consolidation dispatch is a detached Core Agent-turn producer", () => {
  const processor = dispatchMemoryConsolidationProcessor;
  assertEquals(processor.id, "copilotz.memory.dispatch-consolidation");
  assertEquals(processor.settlement, "detached");
});
