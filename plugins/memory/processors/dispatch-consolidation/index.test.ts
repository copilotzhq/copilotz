import { assertEquals } from "@std/assert";
import { createDispatchMemoryConsolidationProcessor } from "./index.ts";

Deno.test("consolidation dispatch is a detached Core Agent-turn producer", () => {
  const processor = createDispatchMemoryConsolidationProcessor();
  assertEquals(processor.id, "copilotz.memory.dispatch-consolidation");
  assertEquals(processor.settlement, "detached");
});
