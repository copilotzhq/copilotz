import { assertEquals } from "@std/assert";
import { updateMyMemoryAction } from "./index.ts";
Deno.test("update-my-memory Action owns its id", () =>
  assertEquals(
    updateMyMemoryAction.id,
    "copilotz.tools.builtin.update_my_memory",
  ));
