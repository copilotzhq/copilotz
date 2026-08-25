import { assertEquals } from "@std/assert";
import { MAINTAIN_MEMORY_ACTION_ID } from "./index.ts";
Deno.test("maintenance action has stable id", () =>
  assertEquals(MAINTAIN_MEMORY_ACTION_ID, "copilotz.memory.maintenance.run"));
