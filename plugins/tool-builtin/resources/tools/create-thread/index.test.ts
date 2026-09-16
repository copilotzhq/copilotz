import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { createThreadToolResource } from "./index.ts";
Deno.test("create-thread Resource exposes its alias", () =>
  assertEquals(
    createThreadToolResource[contribution]({
      namespace: "tools",
      alias: "create_thread",
    }).value.action,
    "create_thread",
  ));
