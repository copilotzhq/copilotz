import { assertEquals } from "@std/assert";
import { createInspectMemoryAction } from "./index.ts";
Deno.test("inspect action is named", () =>
  assertEquals(createInspectMemoryAction().id, "copilotz.memory.inspect"));
