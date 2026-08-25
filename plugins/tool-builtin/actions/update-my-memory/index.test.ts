import { assertEquals } from "@std/assert";
import { createUpdateMyMemoryAction } from "./index.ts";
Deno.test("update-my-memory Action owns its id", () =>
  assertEquals(
    createUpdateMyMemoryAction().id,
    "copilotz.tools.builtin.update_my_memory",
  ));
