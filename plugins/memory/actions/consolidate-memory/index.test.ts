import { assertEquals } from "@std/assert";
import { createConsolidateMemoryAction } from "./index.ts";
Deno.test("consolidate action has stable id", () =>
  assertEquals(
    createConsolidateMemoryAction({
      triggerEstimatedTokens: 1,
      retainRecentEstimatedTokens: 0,
      maxContentEstimatedTokens: 1,
      retrievalLimit: 1,
    }).id,
    "copilotz.memory.consolidation.commit",
  ));
