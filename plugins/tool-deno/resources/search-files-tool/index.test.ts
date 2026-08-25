import { assertEquals } from "@std/assert";
import { searchFilesTool } from "./index.ts";

Deno.test("search_files Tool maps to its Action alias", () => {
  assertEquals(searchFilesTool.action, "search_files");
});
