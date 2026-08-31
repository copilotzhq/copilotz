import { assertEquals } from "@std/assert";
import { createConsolidateMemoryAction } from "./index.ts";
Deno.test("consolidate action publishes stable and auditable contracts", () => {
  const action = createConsolidateMemoryAction({
    triggerEstimatedTokens: 1,
    retainRecentEstimatedTokens: 0,
    maxContentEstimatedTokens: 1,
    retrievalLimit: 1,
  });
  assertEquals(action.id, "copilotz.memory.consolidation.commit");
  assertEquals(
    (action.inputSchema as { $defs?: unknown }).$defs !== undefined,
    true,
  );
  assertEquals(
    (action.outputSchema as { properties?: Record<string, unknown> })
      .properties?.createdRecords !== undefined,
    true,
  );
});
