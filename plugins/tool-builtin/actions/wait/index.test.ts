import { assertEquals } from "@std/assert";
import { createWaitAction } from "./index.ts";
Deno.test("wait Action owns its id", () =>
  assertEquals(
    createWaitAction(() => Promise.resolve()).id,
    "copilotz.tools.builtin.wait",
  ));
