import { assertEquals } from "@std/assert";
import { createUpdateUserMemoryAction } from "./index.ts";
Deno.test("update-user-memory Action owns its id", () =>
  assertEquals(
    createUpdateUserMemoryAction(() => new Date()).id,
    "copilotz.tools.builtin.update_user_memory",
  ));
