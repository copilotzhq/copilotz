import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { getCurrentTimeToolResource } from "./index.ts";
Deno.test("current-time Resource exposes its alias", () =>
  assertEquals(
    getCurrentTimeToolResource[contribution]({
      namespace: "tools",
      alias: "get_current_time",
    }).value.action,
    "get_current_time",
  ));
