import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { updateUserMemoryToolResource } from "./index.ts";
Deno.test("human-memory Resource exposes its alias", () =>
  assertEquals(
    updateUserMemoryToolResource[contribution]({
      namespace: "tools",
      alias: "update_user_memory",
    }).value.action,
    "update_user_memory",
  ));
