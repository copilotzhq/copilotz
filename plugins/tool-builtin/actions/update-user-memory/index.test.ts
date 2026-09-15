import { assertEquals } from "@std/assert";
import { updateUserMemoryAction } from "./index.ts";
Deno.test("update-user-memory Action owns its id", () =>
  assertEquals(
    updateUserMemoryAction.id,
    "copilotz.tools.builtin.update_user_memory",
  ));
