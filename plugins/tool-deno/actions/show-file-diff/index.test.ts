import { assertEquals } from "@std/assert";
import { showFileDiffAction } from "./index.ts";

Deno.test("show_file_diff Action keeps its durable id", () => {
  assertEquals(showFileDiffAction.id, "copilotz.tools.deno.show_file_diff");
});
