import { assertEquals } from "@std/assert";
import { createCreateThreadAction } from "./index.ts";
Deno.test("create-thread Action owns its id", () =>
  assertEquals(
    createCreateThreadAction().id,
    "copilotz.tools.builtin.create_thread",
  ));
