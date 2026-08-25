import { assertEquals } from "@std/assert";
import { showFileDiffTool } from "./index.ts";

Deno.test("show_file_diff Tool maps to its Action alias", () => {
  assertEquals(showFileDiffTool.action, "show_file_diff");
});
