import { assertEquals } from "@std/assert";
import { createEndThreadAction } from "./index.ts";
Deno.test("end-thread Action owns its id", () =>
  assertEquals(
    createEndThreadAction().id,
    "copilotz.tools.builtin.end_thread",
  ));
