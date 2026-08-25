import { assertEquals } from "@std/assert";
import { listDirectoryTool } from "./index.ts";

Deno.test("list_directory Tool maps to its Action alias", () => {
  assertEquals(listDirectoryTool.action, "list_directory");
});
