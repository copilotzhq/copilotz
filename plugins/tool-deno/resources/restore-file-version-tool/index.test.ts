import { assertEquals } from "@std/assert";
import { restoreFileVersionTool } from "./index.ts";

Deno.test("restore_file_version Tool maps to its Action alias", () => {
  assertEquals(restoreFileVersionTool.action, "restore_file_version");
});
