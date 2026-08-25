import { assertEquals } from "@std/assert";
import { reviseMessageAction } from "./index.ts";
Deno.test("revise-message Action owns its identity", () =>
  assertEquals(reviseMessageAction.id, "copilotz.core.message.revise"));
