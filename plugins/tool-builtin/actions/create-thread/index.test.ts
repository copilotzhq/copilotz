import { assertEquals } from "@std/assert";
import { createThreadAction } from "./index.ts";
Deno.test("create-thread Action owns its id", () =>
  assertEquals(
    createThreadAction.id,
    "copilotz.tools.builtin.create_thread",
  ));
