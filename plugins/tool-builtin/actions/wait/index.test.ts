import { assertEquals } from "@std/assert";
import { waitAction } from "./index.ts";
Deno.test("wait Action owns its id", () =>
  assertEquals(
    waitAction.id,
    "copilotz.tools.builtin.wait",
  ));
