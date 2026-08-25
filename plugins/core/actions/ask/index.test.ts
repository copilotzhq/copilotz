import { assertEquals } from "@std/assert";
import { askAction } from "./index.ts";
Deno.test("Ask Action owns its identity", () =>
  assertEquals(askAction.id, "copilotz.core.ask"));
