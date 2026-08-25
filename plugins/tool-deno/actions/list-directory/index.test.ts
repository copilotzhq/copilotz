import { assertEquals } from "@std/assert";
import { listDirectoryAction } from "./index.ts";

Deno.test("list_directory Action keeps its durable id", () => {
  assertEquals(listDirectoryAction.id, "copilotz.tools.deno.list_directory");
});
