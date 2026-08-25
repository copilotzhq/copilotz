import { assertEquals } from "@std/assert";
import { searchFilesAction } from "./index.ts";

Deno.test("search_files Action keeps its durable id", () => {
  assertEquals(searchFilesAction.id, "copilotz.tools.deno.search_files");
});
