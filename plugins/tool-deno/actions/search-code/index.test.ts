import { assertEquals } from "@std/assert";
import { searchCodeAction } from "./index.ts";

Deno.test("search_code Action keeps its durable id", () => {
  assertEquals(searchCodeAction.id, "copilotz.tools.deno.search_code");
});
