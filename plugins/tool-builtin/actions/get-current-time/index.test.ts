import { assertEquals } from "@std/assert";
import { getCurrentTimeAction } from "./index.ts";
Deno.test("get-current-time Action owns its id", () =>
  assertEquals(
    getCurrentTimeAction.id,
    "copilotz.tools.builtin.get_current_time",
  ));
