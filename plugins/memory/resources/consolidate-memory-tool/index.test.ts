import { assertEquals } from "@std/assert";
import { CONSOLIDATE_MEMORY_ACTION_ID } from "./index.ts";
Deno.test("consolidation tool refers to stable action", () =>
  assertEquals(
    CONSOLIDATE_MEMORY_ACTION_ID,
    "copilotz.memory.consolidation.commit",
  ));
