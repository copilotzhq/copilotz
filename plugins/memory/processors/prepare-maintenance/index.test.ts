import { assertEquals } from "@std/assert";
import { createPrepareMemoryMaintenanceProcessor } from "./index.ts";
Deno.test("maintenance processor is named", () =>
  assertEquals(
    createPrepareMemoryMaintenanceProcessor().id,
    "copilotz.memory.prepare-attempt",
  ));
