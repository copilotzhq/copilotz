import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { endThreadToolResource } from "./index.ts";
Deno.test("end-thread Resource exposes its alias", () =>
  assertEquals(
    endThreadToolResource[contribution]({
      namespace: "tools",
      alias: "end_thread",
    }).value.action,
    "end_thread",
  ));
