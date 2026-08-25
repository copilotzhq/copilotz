import { assertEquals } from "@std/assert";
import { createGetCurrentTimeAction } from "./index.ts";
Deno.test("get-current-time Action owns its id", () =>
  assertEquals(
    createGetCurrentTimeAction(() => new Date()).id,
    "copilotz.tools.builtin.get_current_time",
  ));
