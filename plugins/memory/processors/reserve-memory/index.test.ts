import { assertEquals } from "@std/assert";
import { createMemoryReservationProcessor } from "./index.ts";
Deno.test("reservation processor is named", () =>
  assertEquals(
    createMemoryReservationProcessor({
      triggerEstimatedTokens: 1,
      retainRecentEstimatedTokens: 0,
      maxContentEstimatedTokens: 1,
      retrievalLimit: 1,
    }).id,
    "copilotz.memory.reserve",
  ));
