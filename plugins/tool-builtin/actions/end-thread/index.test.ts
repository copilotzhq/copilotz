import { assertEquals } from "@std/assert";
import { endThreadAction } from "./index.ts";
Deno.test("end-thread Action owns its id", () =>
  assertEquals(
    endThreadAction.id,
    "copilotz.tools.builtin.end_thread",
  ));
