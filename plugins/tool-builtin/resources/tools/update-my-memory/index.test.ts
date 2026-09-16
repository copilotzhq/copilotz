import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { updateMyMemoryToolResource } from "./index.ts";
Deno.test("Agent-memory Resource exposes its alias", () =>
  assertEquals(
    updateMyMemoryToolResource[contribution]({
      namespace: "tools",
      alias: "update_my_memory",
    }).value.action,
    "update_my_memory",
  ));
